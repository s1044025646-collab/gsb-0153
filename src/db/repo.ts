import { DatabaseSync } from "node:sqlite";
import type {
  CollisionRecord,
  Container,
  Disk,
  Snapshot,
  Tolerance,
  Vec2,
} from "../physics/types.js";
import { DEFAULT_TOLERANCE } from "../physics/types.js";
import {
  SimError,
  validateContainer,
  validateDiskInput,
  validateInitialState,
  validateTolerance,
} from "../physics/validate.js";
import { advanceTo } from "../physics/engine.js";
import { summarize, wallImpulseFrom } from "../physics/stats.js";

export interface Page {
  limit: number;
  offset: number;
}

export interface CreateSceneInput {
  name: string;
  container: { width: number; height: number };
  disks: { radius: number; mass: number; restitution: number; pos: Vec2; vel: Vec2 }[];
  tolerance?: Partial<Tolerance>;
  idempotencyKey?: string;
}

export interface SceneRow {
  id: number;
  name: string;
  width: number;
  height: number;
  time: number;
  paused: number;
  version: number;
  stop_reason: string | null;
  tolerance_json: string;
}

export class SceneRepository {
  constructor(private db: DatabaseSync, private clock: () => number = () => Date.now()) {}

  createScene(input: CreateSceneInput): { id: number; reused: boolean } {
    if (!input || typeof input.name !== "string" || !input.name.trim())
      throw new SimError("VALIDATION", "name is required");
    const container = validateContainer(input.container);
    if (!Array.isArray(input.disks) || input.disks.length === 0)
      throw new SimError("VALIDATION", "disks must be a non-empty array");
    input.disks.forEach((d, i) => validateDiskInput(d, i));
    const tolerance: Tolerance = { ...DEFAULT_TOLERANCE, ...(validateTolerance(input.tolerance ?? null) ?? {}) };

    const disks: Disk[] = input.disks.map((d, i) => ({
      id: i + 1,
      radius: d.radius,
      mass: d.mass,
      restitution: d.restitution,
      pos: { ...d.pos },
      vel: { ...d.vel },
    }));
    validateInitialState(container, disks, tolerance);

    // Idempotent create: same key returns the existing scene instead of erroring.
    if (input.idempotencyKey) {
      const existing = this.db
        .prepare("SELECT id FROM scenes WHERE idempotency_key = ?")
        .get(input.idempotencyKey) as { id: number } | undefined;
      if (existing) return { id: existing.id, reused: true };
    }

    const now = new Date(this.clock()).toISOString();
    try {
      this.db.exec("BEGIN");
      const info = this.db
        .prepare(
          `INSERT INTO scenes(name,width,height,time,paused,version,tolerance_json,idempotency_key,created_at,updated_at)
           VALUES(?,?,?,0,0,1,?,?,?,?)`,
        )
        .run(
          input.name,
          container.width,
          container.height,
          JSON.stringify(tolerance),
          input.idempotencyKey ?? null,
          now,
          now,
        );
      const id = Number(info.lastInsertRowid);
      const ins = this.db.prepare(
        `INSERT INTO disks(scene_id,disk_no,radius,mass,restitution,x,y,vx,vy)
         VALUES(?,?,?,?,?,?,?,?,?)`,
      );
      disks.forEach((d) => ins.run(id, d.id, d.radius, d.mass, d.restitution, d.pos.x, d.pos.y, d.vel.x, d.vel.y));
      this.db.exec("COMMIT");
      return { id, reused: false };
    } catch (err) {
      this.db.exec("ROLLBACK");
      if ((err as Error).message?.includes("UNIQUE"))
        throw new SimError("CONFLICT", `a scene named '${input.name}' already exists`);
      throw err;
    }
  }

  listScenes(page: Page): { items: SceneRow[]; total: number } {
    const total = Number((this.db.prepare("SELECT COUNT(*) c FROM scenes").get() as any).c);
    const items = this.db
      .prepare("SELECT * FROM scenes ORDER BY id ASC LIMIT ? OFFSET ?")
      .all(page.limit, page.offset) as unknown as SceneRow[];
    return { items, total };
  }

  private loadRow(id: number): SceneRow {
    const row = this.db.prepare("SELECT * FROM scenes WHERE id = ?").get(id) as SceneRow | undefined;
    if (!row) throw new SimError("NOT_FOUND", `scene ${id} not found`);
    return row;
  }

  private loadDisks(id: number): Disk[] {
    return (this.db
      .prepare("SELECT * FROM disks WHERE scene_id = ? ORDER BY disk_no ASC")
      .all(id) as any[]).map((r) => ({
      id: r.disk_no,
      radius: r.radius,
      mass: r.mass,
      restitution: r.restitution,
      pos: { x: r.x, y: r.y },
      vel: { x: r.vx, y: r.vy },
    }));
  }

  loadScene(id: number): { row: SceneRow; container: Container; disks: Disk[]; tolerance: Tolerance; snapshot: Snapshot } {
    const row = this.loadRow(id);
    const container = { width: row.width, height: row.height };
    const tolerance = { ...DEFAULT_TOLERANCE, ...(JSON.parse(row.tolerance_json) as Tolerance) };
    const disks = this.loadDisks(id);
    const snapshot: Snapshot = {
      time: row.time,
      paused: !!row.paused,
      disks,
      version: row.version,
      stopReason: row.stop_reason,
    };
    return { row, container, disks, tolerance, snapshot };
  }

  setPaused(id: number, paused: boolean): void {
    this.loadRow(id);
    this.db
      .prepare("UPDATE scenes SET paused = ?, updated_at = ? WHERE id = ?")
      .run(paused ? 1 : 0, new Date(this.clock()).toISOString(), id);
  }

  run(
    id: number,
    targetTime: number,
    opts: { idempotencyKey?: string; toleranceOverride?: Partial<Tolerance> } = {},
  ): { snapshot: Snapshot; collisions: CollisionRecord[]; stopReason: string | null; reused: boolean } {
    if (!Number.isFinite(targetTime) || targetTime < 0)
      throw new SimError("VALIDATION", "targetTime must be a finite non-negative number");

    if (opts.idempotencyKey) {
      const cached = this.db
        .prepare("SELECT result_json FROM run_requests WHERE scene_id = ? AND idempotency_key = ?")
        .get(id, opts.idempotencyKey) as { result_json: string } | undefined;
      if (cached) {
        const result = JSON.parse(cached.result_json);
        return { ...result, reused: true };
      }
    }

    const loaded = this.loadScene(id);
    if (loaded.snapshot.paused)
      throw new SimError("CONFLICT", `scene ${id} is paused; resume before running`);
    if (targetTime < loaded.snapshot.time)
      throw new SimError("BAD_REQUEST", `targetTime ${targetTime} < current time ${loaded.snapshot.time}`);
    const tolerance: Tolerance = { ...loaded.tolerance, ...(opts.toleranceOverride ?? {}) };

    const nextSeqRow = this.db.prepare("SELECT COALESCE(MAX(seq),0) m FROM collisions WHERE scene_id = ?").get(id) as any;
    let seq = Number(nextSeqRow.m);

    const persisted: CollisionRecord[] = [];
    try {
      this.db.exec("BEGIN");
      const result = advanceTo(loaded.container, loaded.disks, loaded.snapshot, targetTime, tolerance, {
        version: loaded.snapshot.version,
        now: this.clock,
        onCollision: (rec) => {
          seq += 1;
          const full: CollisionRecord = { ...rec, id: seq, sceneId: id };
          persisted.push(full);
          this.db
            .prepare(
              `INSERT INTO collisions(scene_id,seq,time,kind,disks_json,wall,normal_json,impulses_json,
                 impulse_magnitude,vel_before_json,vel_after_json,tolerance_json,simultaneous,iterations,converged,version)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(
              id,
              seq,
              rec.time,
              rec.kind,
              JSON.stringify(rec.disks),
              rec.wall,
              JSON.stringify(rec.normal),
              JSON.stringify(rec.impulses),
              rec.impulseMagnitude,
              JSON.stringify(rec.velBefore),
              JSON.stringify(rec.velAfter),
              JSON.stringify(rec.tolerance),
              rec.simultaneous ? 1 : 0,
              rec.iterations,
              rec.converged ? 1 : 0,
              rec.version,
            );
        },
        onSample: (s) => {
          this.db
            .prepare(
              "INSERT INTO trajectory(scene_id,disk_no,time,x,y,vx,vy) VALUES(?,?,?,?,?,?,?)",
            )
            .run(id, s.diskId, s.time, s.pos.x, s.pos.y, s.vel.x, s.vel.y);
        },
      });

      this.db
        .prepare(
          "UPDATE scenes SET time=?, version=?, stop_reason=?, updated_at=? WHERE id=?",
        )
        .run(result.snapshot.time, result.snapshot.version, result.stopReason, new Date(this.clock()).toISOString(), id);

      // Persist the advanced disk states so restarts continue deterministically.
      const upd = this.db.prepare(
        "UPDATE disks SET x=?, y=?, vx=?, vy=? WHERE scene_id=? AND disk_no=?",
      );
      for (const d of loaded.disks) upd.run(d.pos.x, d.pos.y, d.vel.x, d.vel.y, id, d.id);

      const outResult = {
        snapshot: result.snapshot,
        collisions: persisted,
        stopReason: result.stopReason,
      };
      if (opts.idempotencyKey) {
        this.db
          .prepare("INSERT INTO run_requests(scene_id,idempotency_key,request_json,result_json,created_at) VALUES(?,?,?,?,?)")
          .run(
            id,
            opts.idempotencyKey,
            JSON.stringify({ targetTime, toleranceOverride: opts.toleranceOverride ?? null }),
            JSON.stringify(outResult),
            new Date(this.clock()).toISOString(),
          );
      }
      this.db.exec("COMMIT");
      return { ...outResult, reused: false };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  listCollisions(
    id: number,
    page: Page,
  ): { items: CollisionRecord[]; total: number } {
    this.loadRow(id);
    const total = Number((this.db.prepare("SELECT COUNT(*) c FROM collisions WHERE scene_id=?").get(id) as any).c);
    const rows = this.db
      .prepare("SELECT * FROM collisions WHERE scene_id=? ORDER BY seq ASC LIMIT ? OFFSET ?")
      .all(id, page.limit, page.offset) as any[];
    const items: CollisionRecord[] = rows.map((r) => ({
      id: r.seq,
      sceneId: id,
      time: r.time,
      kind: r.kind,
      disks: JSON.parse(r.disks_json),
      wall: r.wall,
      normal: JSON.parse(r.normal_json),
      impulses: JSON.parse(r.impulses_json),
      impulseMagnitude: r.impulse_magnitude,
      velBefore: JSON.parse(r.vel_before_json),
      velAfter: JSON.parse(r.vel_after_json),
      tolerance: JSON.parse(r.tolerance_json),
      simultaneous: !!r.simultaneous,
      iterations: r.iterations,
      converged: !!r.converged,
      version: r.version,
    }));
    return { items, total };
  }

  trajectory(id: number, diskNo?: number): { diskNo: number; points: { time: number; pos: Vec2; vel: Vec2 }[] }[] {
    this.loadRow(id);
    const args: unknown[] = [id];
    let where = "scene_id = ?";
    if (diskNo !== undefined) {
      where += " AND disk_no = ?";
      args.push(diskNo);
    }
    const rows = this.db
      .prepare(`SELECT * FROM trajectory WHERE ${where} ORDER BY disk_no ASC, time ASC`)
      .all(...(args as any[])) as any[];
    const byDisk = new Map<number, { diskNo: number; points: { time: number; pos: Vec2; vel: Vec2 }[] }>();
    for (const r of rows) {
      if (!byDisk.has(r.disk_no)) byDisk.set(r.disk_no, { diskNo: r.disk_no, points: [] });
      byDisk.get(r.disk_no)!.points.push({
        time: r.time,
        pos: { x: r.x, y: r.y },
        vel: { x: r.vx, y: r.vy },
      });
    }
    return [...byDisk.values()];
  }

  stats(id: number): { time: number; momentum: Vec2; kineticEnergy: number; wallImpulse: Vec2; version: number; paused: boolean; stopReason: string | null } {
    const loaded = this.loadScene(id);
    const disks = this.loadDisks(id);
    const s = summarize(disks);
    const { items } = this.listCollisions(id, { limit: 1_000_000, offset: 0 });
    return {
      time: loaded.row.time,
      momentum: s.p,
      kineticEnergy: s.kineticEnergy,
      wallImpulse: wallImpulseFrom(items),
      version: loaded.row.version,
      paused: !!loaded.row.paused,
      stopReason: loaded.row.stop_reason,
    };
  }

  deleteScene(id: number): void {
    this.db.prepare("DELETE FROM scenes WHERE id = ?").run(id);
  }
}
