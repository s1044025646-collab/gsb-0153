import type { Disk, ContactEvent, ImpulseRecord, Tolerance, Vec2 } from "./types.js";
import { dot } from "./geometry.js";
import { compareEvents } from "./events.js";

function velAt(disks: Disk[], id: number): Disk {
  const d = disks.find((x) => x.id === id);
  if (!d) throw new Error(`internal: disk ${id} missing`);
  return d;
}

function snapshotVels(disks: Disk[], ids: number[]): Vec2[] {
  return ids.map((id) => ({ ...velAt(disks, id).vel }));
}

/**
 * Apply one non-penetrating frictionless normal impulse for a single contact.
 * Returns the scalar impulse j (>= 0), or 0 if the contact is separating/resting.
 *
 * Disk-disk:  j = -(1+e) v_rel·n / (1/m_a + 1/m_b)
 * Wall:       j = -(1+e) v·n * m   (wall treated as infinite mass)
 */
export function applyContactImpulse(
  disks: Disk[],
  ev: ContactEvent,
): { magnitude: number; impulseOnFirst: Vec2 } | null {
  const n = ev.normal;
  if (ev.kind === "wall") {
    const d = velAt(disks, ev.disks[0]!);
    const vn = dot(d.vel, n); // n points into the container; vn < 0 => into wall
    if (vn >= -1e-14) return null; // already separating
    const j = -(1 + d.restitution) * vn * d.mass;
    const imp = { x: j * n.x, y: j * n.y };
    d.vel.x += imp.x / d.mass;
    d.vel.y += imp.y / d.mass;
    return { magnitude: j, impulseOnFirst: imp };
  }
  const a = velAt(disks, ev.disks[0]!);
  const b = velAt(disks, ev.disks[1]!);
  const rvx = b.vel.x - a.vel.x;
  const rvy = b.vel.y - a.vel.y;
  const rvn = rvx * n.x + rvy * n.y;
  if (rvn >= -1e-14) return null;
  const e = Math.sqrt(a.restitution * b.restitution);
  const j = (-(1 + e) * rvn) / (1 / a.mass + 1 / b.mass);
  const imp = { x: j * n.x, y: j * n.y };
  a.vel.x -= imp.x / a.mass;
  a.vel.y -= imp.y / a.mass;
  b.vel.x += imp.x / b.mass;
  b.vel.y += imp.y / b.mass;
  return { magnitude: j, impulseOnFirst: imp };
}

export interface SolveResult {
  records: ImpulseRecord[];
  iterations: number;
  converged: boolean;
  total: number;
}

/**
 * Resolve a group of simultaneous contacts with deterministic sequential impulses.
 *
 * Method (approximate, NOT an exact unique solution):
 *  contacts are visited in the fixed `compareEvents` order; each visit applies a
 *  non-penetrating impulse only while that contact is still approaching. The sweep
 *  repeats until the maximum residual approach speed is below tolerance or the
 *  iteration cap is reached. For a single isolated contact this converges in one
 *  iteration to the analytic impulse. Resting/over-constrained stacks (impossible
 *  under zero gravity except at corner contacts) may iterate to the cap; such a
 *  case is reported with converged=false rather than claimed exact.
 */
export function resolveGroup(disks: Disk[], events: ContactEvent[], tol: Tolerance): SolveResult {
  const records: ImpulseRecord[] = [];
  const accum = new Map<string, { ev: ContactEvent; total: number; velBefore: Vec2[] }>();

  let iterations = 0;
  let converged = false;
  for (iterations = 1; iterations <= tol.maxIterations; iterations++) {
    let maxApproach = 0;
    for (const ev of events) {
      const key = ev.kind === "wall" ? `w:${ev.disks[0]}:${ev.wall}` : `d:${ev.disks[0]}:${ev.disks[1]}`;
      const velBefore = accum.get(key)?.velBefore ?? snapshotVels(disks, ev.disks as number[]);
      const res = applyContactImpulse(disks, ev);
      if (res) {
        const prev = accum.get(key);
        accum.set(key, { ev, total: (prev?.total ?? 0) + res.magnitude, velBefore });
      }
      const approach = approachSpeed(disks, ev);
      if (approach < 0) maxApproach = Math.max(maxApproach, -approach);
    }
    if (maxApproach <= tol.toleranceVel) {
      converged = true;
      break;
    }
  }

  for (const { ev, total, velBefore } of [...accum.values()].sort((a, b) => compareEvents(a.ev, b.ev))) {
  const ids = [...ev.disks] as number[];
    records.push({
      kind: ev.kind,
      disks: ids as [number] | [number, number],
      wall: ev.wall,
      normal: ev.normal,
      magnitude: total,
      impulseOnFirst: { x: total * ev.normal.x, y: total * ev.normal.y },
      velBefore,
      velAfter: snapshotVels(disks, ids),
    });
  }
  const grand = records.reduce((s, r) => s + r.magnitude, 0);
  return { records, iterations, converged, total: grand };
}

function approachSpeed(disks: Disk[], ev: ContactEvent): number {
  if (ev.kind === "wall") {
    return dot(velAt(disks, ev.disks[0]!).vel, ev.normal);
  }
  const a = velAt(disks, ev.disks[0]!);
  const b = velAt(disks, ev.disks[1]!);
  return dot({ x: b.vel.x - a.vel.x, y: b.vel.y - a.vel.y }, ev.normal);
}
