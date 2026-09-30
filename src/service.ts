import type { DatabaseSync } from "node:sqlite";
import { Repo } from "./repo.js";
import { validateScene } from "./physics/validate.js";
import { advance, initState, report, type EngineState } from "./physics/engine.js";
import { totalMomentum, kineticEnergy } from "./physics/ccd.js";
import { SimError, TOL_DEFAULTS, type DiskState, type SceneSpec } from "./types.js";

export interface Clock {
  now(): string;
}

export class SimService {
  repo: Repo;
  constructor(
    public db: DatabaseSync,
    private clock: Clock = { now: () => new Date().toISOString() },
  ) {
    this.repo = new Repo(db);
  }

  createScene(
    name: string,
    spec: SceneSpec,
    idempotencyKey?: string,
  ): { id: number; name: string; reused: boolean } {
    if (typeof name !== "string" || name.trim() === "") {
      throw new SimError("INVALID_NAME", "scene name is required");
    }
    if (idempotencyKey) {
      const cached = this.repo.getIdempotent(idempotencyKey);
      if (cached) return { ...(cached as { id: number; name: string }), reused: true };
    }
    validateScene(spec);
    if (this.repo.findSceneByName(name)) {
      throw new SimError("NAME_CONFLICT", `scene '${name}' already exists`, { name });
    }
    const id = this.repo.createScene({ ...spec, name }, this.clock.now());
    const response = { id, name, reused: false };
    if (idempotencyKey) this.repo.putIdempotent(idempotencyKey, response, this.clock.now());
    return response;
  }

  /** Clone a scene with a different restitution for A/B comparison. */
  cloneWithRestitution(
    sourceId: number,
    newName: string,
    restitution: number,
  ): number {
    const source = this.repo.getScene(sourceId);
    const disks = this.repo.loadDisks(sourceId);
    const spec: SceneSpec & { name: string } = {
      name: newName,
      width: source.width,
      height: source.height,
      restitution,
      disks,
    };
    validateScene(spec);
    if (this.repo.findSceneByName(newName)) {
      throw new SimError("NAME_CONFLICT", `scene '${newName}' already exists`);
    }
    return this.repo.createScene(spec, this.clock.now(), sourceId);
  }

  private hydrate(sceneId: number): { scene: ReturnType<Repo["getScene"]>; state: EngineState } {
    const scene = this.repo.getScene(sceneId);
    const rt = this.repo.getRuntime(sceneId);
    const disks = this.repo.loadDisks(sceneId);
    const state = initState(scene.width, scene.height, scene.restitution, disks);
    state.t = rt.t;
    state.eventSeq = rt.event_seq;
    state.wallImpulse = { x: rt.wall_ix, y: rt.wall_iy };
    state.wallImpulseCount = rt.wall_count;
    state.stoppedReason = rt.stopped_reason;
    return { scene, state };
  }

  /**
   * Run forward by duration. Pause/resume is just run/run-again: state is fully
   * persisted after each call and deterministic continuation is guaranteed.
   */
  run(sceneId: number, duration: number, idempotencyKey?: string): RunResult {
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new SimError("INVALID_DURATION", "duration must be finite and > 0", {
        duration,
      });
    }
    if (idempotencyKey) {
      const cached = this.repo.getIdempotent(idempotencyKey);
      if (cached) return { ...(cached as Omit<RunResult, "reused">), reused: true };
    }
    const { scene, state } = this.hydrate(sceneId);
    if (state.stoppedReason) {
      throw new SimError(
        "SCENE_STOPPED",
        `simulation stopped: ${state.stoppedReason}`,
        { reason: state.stoppedReason },
      );
    }
    const before = this.snapshot(sceneId, state);
    const out = advance(state, duration, {
      idempotencyKey: idempotencyKey ?? null,
      recordTrajectory: true,
      now: this.clock.now,
    });
    this.repo.saveAdvance(
      sceneId,
      {
        t: out.state.t,
        eventSeq: out.state.eventSeq,
        wallImpulse: out.state.wallImpulse,
        wallImpulseCount: out.state.wallImpulseCount,
        stoppedReason: out.state.stoppedReason,
      },
      out.state.disks,
      out.events,
      out.trajectory,
      this.clock.now(),
    );
    const after = this.snapshot(sceneId, out.state);
    const response: RunResult = {
      sceneId,
      sceneName: scene.name,
      before,
      after,
      newEvents: out.events.length,
      events: out.events,
      stoppedReason: out.state.stoppedReason,
      reused: false,
    };
    if (idempotencyKey) this.repo.putIdempotent(idempotencyKey, response, this.clock.now());
    return response;
  }

  private snapshot(sceneId: number, state: EngineState) {
    return {
      sceneId,
      t: state.t,
      eventSeq: state.eventSeq,
      disks: state.disks.map((d) => ({ ...d })),
      momentum: totalMomentum(state.disks),
      kineticEnergy: kineticEnergy(state.disks),
      wallImpulse: { ...state.wallImpulse },
      wallImpulseCount: state.wallImpulseCount,
      stoppedReason: state.stoppedReason,
      tolerances: TOL_DEFAULTS,
    };
  }

  getStatus(sceneId: number) {
    const { state } = this.hydrate(sceneId);
    return this.snapshot(sceneId, state);
  }

  listEvents(sceneId: number, page: number, pageSize: number) {
    this.repo.getScene(sceneId);
    const limit = clampPageSize(pageSize);
    const offset = (clampPage(page) - 1) * limit;
    const { rows, total } = this.repo.listEvents(sceneId, limit, offset);
    return paginate(rows, total, clampPage(page), limit);
  }

  getEvent(sceneId: number, seq: number) {
    this.repo.getScene(sceneId);
    const ev = this.repo.getEventBySeq(sceneId, seq);
    if (!ev) throw new SimError("NOT_FOUND", `event ${seq} not found`);
    return ev;
  }

  exportTrajectory(sceneId: number) {
    this.repo.getScene(sceneId);
    return this.repo.getTrajectory(sceneId);
  }

  listScenes(page: unknown, pageSize: unknown) {
    const limit = clampPageSize(pageSize);
    const offset = (clampPage(page) - 1) * limit;
    const { rows, total } = this.repo.listScenes(limit, offset);
    return paginate(rows, total, clampPage(page), limit);
  }
}

function clampPage(p: unknown): number {
  const n = Number(p);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}
function clampPageSize(s: unknown): number {
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1) return 50;
  return Math.min(n, 500);
}

export function paginate<T>(
  rows: T[],
  total: number,
  page: number,
  pageSize: number,
) {
  return {
    items: rows,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export type RunResult = NonNullable<
  {
    sceneId: number;
    sceneName: string;
    before: ReturnType<SimService["snapshot"]>;
    after: ReturnType<SimService["snapshot"]>;
    newEvents: number;
    events: import("./types.js").CollisionEvent[];
    stoppedReason: string | null;
    reused: boolean;
  }
>;
