import type {
  CollisionEvent,
  DiskState,
  ToleranceConfig,
  Vec2,
} from "../types.js";
import { SimError, TOL_DEFAULTS } from "../types.js";
import {
  diskDiskContact,
  diskWallContact,
  kineticEnergy,
  totalMomentum,
  type ContactCandidate,
} from "./ccd.js";
import { resolveContacts } from "./impulse.js";

export interface EngineState {
  width: number;
  height: number;
  restitution: number;
  t: number;
  eventSeq: number;
  disks: DiskState[];
  wallImpulse: Vec2;
  wallImpulseCount: number;
  stoppedReason: string | null;
  zeroDtStreak: number;
}

export interface EngineOutput {
  state: EngineState;
  events: CollisionEvent[];
  trajectory: { t: number; disk: DiskState }[];
}

export interface EngineOptions {
  tol?: ToleranceConfig;
  idempotencyKey?: string | null;
  /** Record trajectory samples at every advance endpoint and collision time. */
  recordTrajectory?: boolean;
  now?: () => string;
}

export function initState(
  width: number,
  height: number,
  restitution: number,
  disks: DiskState[],
): EngineState {
  return {
    width,
    height,
    restitution,
    t: 0,
    eventSeq: 0,
    disks: disks.map((d) => ({ ...d })),
    wallImpulse: { x: 0, y: 0 },
    wallImpulseCount: 0,
    stoppedReason: null,
    zeroDtStreak: 0,
  };
}

const byId = (disks: DiskState[]): Map<number, DiskState> =>
  new Map(disks.map((d) => [d.id, d]));

function snapshotTrajectory(t: number, disks: DiskState[]) {
  return disks.map((d) => ({ t, disk: { ...d } }));
}

function earliestContacts(
  state: EngineState,
  horizon: number,
  tol: ToleranceConfig,
): ContactCandidate[] {
  const found: ContactCandidate[] = [];
  const disks = state.disks;
  for (let i = 0; i < disks.length; i++) {
    const w = diskWallContact(disks[i]!, state.width, state.height, horizon, tol);
    if (w) found.push(w);
    for (let j = i + 1; j < disks.length; j++) {
      const dd = diskDiskContact(disks[i]!, disks[j]!, horizon, tol);
      if (dd) found.push(dd);
    }
  }
  if (found.length === 0) return [];
  // Deterministic earliest-instant selection.
  found.sort((a, b) => a.t - b.t);
  const tStar = found[0]!.t;
  // Simultaneous group: all contacts within timeEps of the earliest.
  return found.filter((c) => c.t <= tStar + tol.timeEps);
}

/**
 * Advance the simulation from its current time to current time + dt using
 * analytic event-driven integration. Deterministic: same state + same dt
 * always yields identical events and final state, enabling resume / replay.
 */
export function advance(
  initial: EngineState,
  dt: number,
  opts: EngineOptions = {},
): EngineOutput {
  const tol = opts.tol ?? TOL_DEFAULTS;
  if (!Number.isFinite(dt) || dt < 0) {
    throw new SimError("INVALID_DURATION", "duration must be finite and >= 0", { dt });
  }
  const state: EngineState = {
    ...initial,
    disks: initial.disks.map((d) => ({ ...d })),
    wallImpulse: { ...initial.wallImpulse },
    stoppedReason: initial.stoppedReason,
    zeroDtStreak: initial.zeroDtStreak,
  };
  const events: CollisionEvent[] = [];
  const trajectory: EngineOutput["trajectory"] = [];
  if (opts.recordTrajectory) trajectory.push(...snapshotTrajectory(state.t, state.disks));

  const targetT = state.t + dt;
  const createdAt = (opts.now ?? (() => new Date().toISOString()))();

  while (state.t < targetT - tol.timeEps) {
    const horizon = targetT - state.t;
    const group = earliestContacts(state, horizon, tol);
    if (group.length === 0) {
      for (const d of state.disks) {
        d.x += d.vx * horizon;
        d.y += d.vy * horizon;
      }
      state.t = targetT;
      state.zeroDtStreak = 0;
      break;
    }

    const tContact = group[0]!.t;
    const dtEvent = tContact > tol.timeEps ? tContact : 0;
    // Free flight up to the contact instant.
    for (const d of state.disks) {
      d.x += d.vx * dtEvent;
      d.y += d.vy * dtEvent;
    }
    state.t += dtEvent;

    // A contact exactly at the target time is still resolved (impulse applied);
    // we simply do not advance beyond the target afterwards.

    // Guard zero-time event loops (resolving contacts that instantly reappear).
    if (dtEvent <= tol.timeEps) {
      state.zeroDtStreak += 1;
      if (state.zeroDtStreak > tol.maxZeroDtEvents) {
        state.stoppedReason =
          `ZERO_DT_LOOP_LIMIT: ${tol.maxZeroDtEvents} consecutive zero-time events`;
        break;
      }
    } else {
      state.zeroDtStreak = 0;
    }

    const diskMap = byId(state.disks);
    const { resolved, iterations, converged } = resolveContacts(
      diskMap,
      group,
      state.restitution,
      tol,
    );

    for (const r of resolved) {
      const c = r.contact;
      state.eventSeq += 1;
      const ev: CollisionEvent = {
        seq: state.eventSeq,
        kind: c.kind,
        t: state.t,
        a: c.a,
        b: c.b,
        nx: c.nx,
        ny: c.ny,
        impulse: r.impulse,
        iterations,
        converged,
        vaxBefore: r.before.avx,
        vayBefore: r.before.avy,
        vbxBefore: r.before.bvx,
        vbyBefore: r.before.bvy,
        vaxAfter: r.after.avx,
        vayAfter: r.after.avy,
        vbxAfter: r.after.bvx,
        vbyAfter: r.after.bvy,
        tolContactEps: tol.contactEps,
        tolTimeEps: tol.timeEps,
        tolRestingSpeed: tol.restingSpeed,
        idempotencyKey: opts.idempotencyKey ?? null,
      };
      events.push(ev);
      if (c.kind === "disk-wall") {
        // n points inward from the wall and the disk receives +j*n, which is
        // the external impulse delivered by the wall: p_now = p_0 + wallImpulse.
        state.wallImpulse.x += r.impulse * c.nx;
        state.wallImpulse.y += r.impulse * c.ny;
        state.wallImpulseCount += 1;
      }
    }
    if (opts.recordTrajectory) trajectory.push(...snapshotTrajectory(state.t, state.disks));

    // Positional de-slop: contacts solved exactly at touching distance, but
    // round-off can leave tiny overlap; nudge apart along accumulated normals
    // by at most the contact epsilon. This never injects kinetic energy.
    for (const r of resolved) {
      const c = r.contact;
      const a = diskMap.get(c.a)!;
      if (c.kind === "disk-disk") {
        const b = diskMap.get(c.b)!;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const gap = Math.hypot(dx, dy) - (a.r + b.r);
        if (gap < 0 && gap > -tol.contactEps) {
          const push = -gap / 2;
          const nl = Math.hypot(dx, dy) || 1;
          a.x += (push * dx) / nl;
          a.y += (push * dy) / nl;
          b.x -= (push * dx) / nl;
          b.y -= (push * dy) / nl;
        }
      }
    }

    if (!converged) {
      state.stoppedReason = `SOLVER_DID_NOT_CONVERGE after ${iterations} iterations`;
      break;
    }
  }

  if (opts.recordTrajectory) trajectory.push(...snapshotTrajectory(state.t, state.disks));
  return { state, events, trajectory };
}

export function report(state: EngineState) {
  return {
    t: state.t,
    momentum: totalMomentum(state.disks),
    kineticEnergy: kineticEnergy(state.disks),
    wallImpulse: state.wallImpulse,
    wallImpulseCount: state.wallImpulseCount,
    stoppedReason: state.stoppedReason,
  };
}
