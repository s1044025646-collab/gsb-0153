import type {
  CollisionRecord,
  Container,
  Disk,
  Snapshot,
  Tolerance,
  TrajectoryPoint,
  Vec2,
} from "./types.js";
import { advance } from "./geometry.js";
import { findContactGroup } from "./events.js";
import { resolveGroup } from "./impulse.js";
import { SimError, validateInitialState } from "./validate.js";

export interface StepOptions {
  /** Clock source (injectable for deterministic tests). */
  now?: () => number;
  /** Called each time a collision is resolved, so callers can persist it. */
  onCollision?: (rec: Omit<CollisionRecord, "id" | "sceneId">) => void;
  /** Called on each trajectory sample (start, each collision, finish). */
  onSample?: (p: { diskId: number; time: number; pos: Vec2; vel: Vec2 }) => void;
  recordIdStart?: number;
  version: number;
}

export interface StepResult {
  snapshot: Snapshot;
  collisions: Omit<CollisionRecord, "id" | "sceneId">[];
  zeroTimeEvents: number;
  stopReason: string | null;
}

/**
 * Advance a scene from its current time to `targetTime` using an event-driven
 * scheme: analytically find the earliest contact, free-fly to it, resolve, and
 * repeat. Positions are always exact at contact, so there is no discrete overlap
 * check and no tunnelling at high speed.
 *
 * Zero-time (simultaneous) contacts are bounded: if more than
 * `2 * maxIterations` consecutive zero-time steps occur without forward motion
 * the loop stops with stopReason "EVENT_LOOP_LIMIT".
 */
export function advanceTo(
  container: Container,
  disks: Disk[],
  snapshot: Snapshot,
  targetTime: number,
  tol: Tolerance,
  opts: StepOptions,
): StepResult {
  if (!Number.isFinite(targetTime) || targetTime < snapshot.time)
    throw new SimError("BAD_REQUEST", `targetTime must be finite and >= current time ${snapshot.time}`);
  if (snapshot.time === 0 && snapshot.version <= 1) {
    validateInitialState(container, disks, tol);
  }

  const collisions: Omit<CollisionRecord, "id" | "sceneId">[] = [];
  let zeroStreak = 0;
  let stopReason: string | null = null;
  let version = opts.version;

  // Sample initial positions for this run (caller de-duplicates by time).
  for (const d of disks) opts.onSample?.({ diskId: d.id, time: snapshot.time, pos: { ...d.pos }, vel: { ...d.vel } });

  while (snapshot.time < targetTime - tol.epsilonTime) {
    const horizon = targetTime - snapshot.time;
    const group = findContactGroup(disks, container, horizon, tol);
    if (!group) {
      advance(disks, horizon);
      snapshot.time = targetTime;
      break;
    }
    const dt = group.earliest;
    if (dt > tol.epsilonTime) {
      advance(disks, dt);
      snapshot.time += dt;
      zeroStreak = 0;
    } else {
      zeroStreak++;
      const cap = Math.max(8, 2 * tol.maxIterations);
      if (zeroStreak > cap) {
        stopReason =
          "EVENT_LOOP_LIMIT: zero-time contact group did not separate within " +
          `${cap} attempts (maxIterations=${tol.maxIterations})`;
        snapshot.stopReason = stopReason;
        break;
      }
    }

    // Only record/resolve groups that happen strictly before or at the target.
    const events = group.events;
    const participating = unique(events.flatMap((e) => e.disks as number[])).sort((a, b) => a - b);
    const velBeforeById = new Map<number, Vec2>(participating.map((id) => [id, { ...mustFind(disks, id).vel }]));
    const solve = resolveGroup(disks, events, tol);
    version++;

    // Skip writing a record if nothing actually approached (numerical phantom).
    const meaningful = solve.records.length > 0;
    if (meaningful) {
      const rec: Omit<CollisionRecord, "id" | "sceneId"> = {
        time: snapshot.time,
        kind: events.length === 1 ? events[0].kind : "disk-disk",
        disks: participating,
        wall: events.length === 1 && events[0].kind === "wall" ? events[0].wall! : null,
        normal: events.length === 1 ? events[0].normal : { x: 0, y: 0 },
        impulses: solve.records,
        impulseMagnitude: solve.total,
        velBefore: participating.map((id) => ({ ...(velBeforeById.get(id) as Vec2) })),
        velAfter: participating.map((id) => ({ ...mustFind(disks, id).vel })),
        tolerance: structuredClone(tol),
        simultaneous: events.length > 1,
        iterations: solve.iterations,
        converged: solve.converged,
        version,
      };
      collisions.push(rec);
      opts.onCollision?.(rec);
      for (const id of participating)
        opts.onSample?.({ diskId: id, time: snapshot.time, pos: { ...mustFind(disks, id).pos }, vel: { ...mustFind(disks, id).vel } });
    }
  }

  if (snapshot.time > targetTime || Math.abs(snapshot.time - targetTime) <= tol.epsilonTime) snapshot.time = targetTime;
  snapshot.disks = disks;
  snapshot.version = version;
  for (const d of disks) opts.onSample?.({ diskId: d.id, time: snapshot.time, pos: { ...d.pos }, vel: { ...d.vel } });
  return { snapshot, collisions, zeroTimeEvents: zeroStreak, stopReason };
}

function mustFind(disks: Disk[], id: number): Disk {
  const d = disks.find((x) => x.id === id);
  if (!d) throw new SimError("NOT_FOUND", `disk ${id} not in scene`);
  return d;
}

function unique(xs: number[]): number[] {
  return [...new Set(xs)];
}
