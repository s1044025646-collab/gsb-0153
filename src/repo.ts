import type { DatabaseSync } from "node:sqlite";
import type {
  CollisionEvent,
  DiskState,
  SceneSpec,
  Vec2,
} from "./types.js";

export interface SceneRow {
  id: number;
  name: string;
  width: number;
  height: number;
  restitution: number;
  base_scene_id: number | null;
  created_at: string;
}

export interface RuntimeRow {
  t: number;
  event_seq: number;
  wall_ix: number;
  wall_iy: number;
  wall_count: number;
  stopped_reason: string | null;
}

export class Repo {
  constructor(public db: DatabaseSync) {}

  getIdempotent(key: string): unknown | null {
    const row = this.db
      .prepare("SELECT response_json FROM idempotency WHERE key = ?")
      .get(key) as { response_json: string } | undefined;
    return row ? (JSON.parse(row.response_json) as unknown) : null;
  }

  putIdempotent(key: string, response: unknown, now: string): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO idempotency (key, response_json, created_at) VALUES (?, ?, ?)",
      )
      .run(key, JSON.stringify(response), now);
  }

  findSceneByName(name: string): SceneRow | null {
    return (
      (this.db.prepare("SELECT * FROM scenes WHERE name = ?").get(name) as
        | SceneRow
        | undefined) ?? null
    );
  }

  getScene(id: number): SceneRow {
    const row = this.db.prepare("SELECT * FROM scenes WHERE id = ?").get(id) as
      | SceneRow
      | undefined;
    if (!row) throw Object.assign(new Error("scene not found"), { code: "NOT_FOUND" });
    return row;
  }

  listScenes(limit: number, offset: number): { rows: SceneRow[]; total: number } {
    const total = (
      this.db.prepare("SELECT COUNT(*) AS c FROM scenes").get() as { c: number }
    ).c;
    const rows = this.db
      .prepare("SELECT * FROM scenes ORDER BY id LIMIT ? OFFSET ?")
      .all(limit, offset) as unknown as SceneRow[];
    return { rows, total };
  }

  createScene(
    spec: SceneSpec & { name: string },
    now: string,
    baseSceneId: number | null = null,
  ): number {
    const insScene = this.db.prepare(
      "INSERT INTO scenes (name, width, height, restitution, base_scene_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const insDisk = this.db.prepare(
      "INSERT INTO disks (scene_id, disk_id, r, m, x, y, vx, vy) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const insRuntime = this.db.prepare(
      "INSERT INTO runtime (scene_id, t, event_seq, wall_ix, wall_iy, wall_count, stopped_reason) VALUES (?, 0, 0, 0, 0, 0, NULL)",
    );
    this.db.exec("BEGIN");
    try {
      const res = insScene.run(
        spec.name,
        spec.width,
        spec.height,
        spec.restitution,
        baseSceneId,
        now,
      );
      const id = Number(res.lastInsertRowid);
      for (const d of spec.disks) {
        insDisk.run(id, d.id, d.r, d.m, d.x, d.y, d.vx, d.vy);
      }
      insRuntime.run(id);
      this.db.exec("COMMIT");
      return id;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  loadDisks(sceneId: number): DiskState[] {
    const rows = this.db
      .prepare(
        "SELECT disk_id AS id, r, m, x, y, vx, vy FROM disks WHERE scene_id = ? ORDER BY disk_id",
      )
      .all(sceneId) as unknown as DiskState[];
    return rows.map((d) => ({ ...d }));
  }

  getRuntime(sceneId: number): RuntimeRow {
    const row = this.db
      .prepare("SELECT * FROM runtime WHERE scene_id = ?")
      .get(sceneId) as RuntimeRow | undefined;
    if (!row) throw Object.assign(new Error("runtime not found"), { code: "NOT_FOUND" });
    return row;
  }

  saveAdvance(
    sceneId: number,
    rt: {
      t: number;
      eventSeq: number;
      wallImpulse: Vec2;
      wallImpulseCount: number;
      stoppedReason: string | null;
    },
    disks: DiskState[],
    events: CollisionEvent[],
    trajectory: { t: number; disk: DiskState }[],
    now: string,
  ): void {
    const updDisk = this.db.prepare(
      "UPDATE disks SET x = ?, y = ?, vx = ?, vy = ? WHERE scene_id = ? AND disk_id = ?",
    );
    const updRt = this.db.prepare(
      "UPDATE runtime SET t = ?, event_seq = ?, wall_ix = ?, wall_iy = ?, wall_count = ?, stopped_reason = ? WHERE scene_id = ?",
    );
    const insEvent = this.db.prepare(
      `INSERT INTO events (scene_id, seq, kind, t, disk_a, disk_b, nx, ny, impulse,
         iterations, converged, va_xb, va_yb, vb_xb, vb_yb, va_xa, va_ya, vb_xa, vb_ya,
         tol_contact_eps, tol_time_eps, tol_resting_speed, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insTraj = this.db.prepare(
      "INSERT OR REPLACE INTO trajectories (scene_id, t, disk_id, x, y, vx, vy) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    this.db.exec("BEGIN");
    try {
      for (const d of disks) {
        updDisk.run(d.x, d.y, d.vx, d.vy, sceneId, d.id);
      }
      updRt.run(
        rt.t,
        rt.eventSeq,
        rt.wallImpulse.x,
        rt.wallImpulse.y,
        rt.wallImpulseCount,
        rt.stoppedReason,
        sceneId,
      );
      for (const e of events) {
        insEvent.run(
          sceneId, e.seq, e.kind, e.t, e.a, e.b, e.nx, e.ny, e.impulse,
          e.iterations, e.converged ? 1 : 0,
          e.vaxBefore, e.vayBefore, e.vbxBefore, e.vbyBefore,
          e.vaxAfter, e.vayAfter, e.vbxAfter, e.vbyAfter,
          e.tolContactEps, e.tolTimeEps, e.tolRestingSpeed, e.idempotencyKey, now,
        );
      }
      for (const sample of trajectory) {
        insTraj.run(
          sceneId, sample.t, sample.disk.id, sample.disk.x, sample.disk.y,
          sample.disk.vx, sample.disk.vy,
        );
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  listEvents(
    sceneId: number,
    limit: number,
    offset: number,
  ): { rows: CollisionEvent[]; total: number } {
    const total = (
      this.db
        .prepare("SELECT COUNT(*) AS c FROM events WHERE scene_id = ?")
        .get(sceneId) as { c: number }
    ).c;
    const raw = this.db
      .prepare("SELECT * FROM events WHERE scene_id = ? ORDER BY seq LIMIT ? OFFSET ?")
      .all(sceneId, limit, offset) as Record<string, number | string | null>[];
    return { rows: raw.map(rowToEvent), total };
  }

  getEventBySeq(sceneId: number, seq: number): CollisionEvent | null {
    const raw = this.db
      .prepare("SELECT * FROM events WHERE scene_id = ? AND seq = ?")
      .get(sceneId, seq) as Record<string, number | string | null> | undefined;
    return raw ? rowToEvent(raw) : null;
  }

  getTrajectory(sceneId: number): {
    t: number;
    disk_id: number;
    x: number;
    y: number;
    vx: number;
    vy: number;
  }[] {
    return this.db
      .prepare(
        "SELECT t, disk_id, x, y, vx, vy FROM trajectories WHERE scene_id = ? ORDER BY t, disk_id",
      )
      .all(sceneId) as {
      t: number;
      disk_id: number;
      x: number;
      y: number;
      vx: number;
      vy: number;
    }[];
  }
}

function rowToEvent(r: Record<string, number | string | null>): CollisionEvent {
  const num = (k: string): number => Number(r[k]);
  return {
    seq: num("seq"),
    kind: String(r["kind"]) as CollisionEvent["kind"],
    t: num("t"),
    a: num("disk_a"),
    b: num("disk_b"),
    nx: num("nx"),
    ny: num("ny"),
    impulse: num("impulse"),
    iterations: num("iterations"),
    converged: Number(r["converged"]) === 1,
    vaxBefore: num("va_xb"),
    vayBefore: num("va_yb"),
    vbxBefore: num("vb_xb"),
    vbyBefore: num("vb_yb"),
    vaxAfter: num("va_xa"),
    vayAfter: num("va_ya"),
    vbxAfter: num("vb_xa"),
    vbyAfter: num("vb_ya"),
    tolContactEps: num("tol_contact_eps"),
    tolTimeEps: num("tol_time_eps"),
    tolRestingSpeed: num("tol_resting_speed"),
    idempotencyKey: (r["idempotency_key"] as string | null) ?? null,
  };
}
