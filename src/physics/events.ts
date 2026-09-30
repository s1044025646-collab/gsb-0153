import type { Container, Disk, Tolerance, ContactEvent, WallSide } from "./types.js";
import { sub, dot, diskGap, wallGaps } from "./geometry.js";

/** Pairwise restitution: geometric mean keeps symmetry and stays in [0,1]. */
export function pairRestitution(a: Disk, b: Disk): number {
  return Math.sqrt(a.restitution * b.restitution);
}

/**
 * Earliest t in (0, horizon] at which disks a and b make contact along straight
 * ballistic paths. Solves |r_b(t)-r_a(t)| = r_a+r_b exactly (quadratic),
 * so high-speed disks cannot tunnel between coarse time steps.
 *
 * Returns null when they never approach to contact in the window.
 */
export function nextDiskContact(
  a: Disk,
  b: Disk,
  horizon: number,
  tol: Tolerance,
): { time: number; normal: { x: number; y: number } } | null {
  const rel = sub(b.pos, a.pos);
  const rv = sub(b.vel, a.vel);
  const rr = a.radius + b.radius;
  const A = dot(rv, rv);
  if (A === 0) return null; // relative rest
  const B = 2 * dot(rel, rv);
  const C = dot(rel, rel) - rr * rr;
  const disc = B * B - 4 * A * C;
  if (disc < 0) {
    // Slight numerical negative when essentially grazing/touching.
    if (disc > -tol.epsilonPos) {
      const t = -B / (2 * A);
      if (t > tol.epsilonTime && t <= horizon) return { time: t, normal: normaliseOrX(rel) };
    }
    return null;
  }
  const s = Math.sqrt(Math.max(0, disc));
  const t1 = (-B - s) / (2 * A); // earliest contact (approach branch)
  const t2 = (-B + s) / (2 * A); // later separation branch

  // Already touching at t=0: the approach branch is ~0; only valid if separating.
  const gap0 = diskGap(a, b);
  if (gap0 <= tol.epsilonPos) {
    const approach = dot(rv, rel) / (Math.hypot(rel.x, rel.y) || 1);
    if (approach >= -tol.epsilonVel) return null; // resting/separating, ignore
    // Already touching but still approaching (unresolved simultaneous stack):
    // this must be handled as a zero-time contact, never by flying forward.
    return { time: 0, normal: normaliseOrX(rel) };
  }
  for (const t of [t1, t2]) {
    if (t > tol.epsilonTime && t <= horizon + tol.epsilonTime) {
      const npos = { x: rel.x + rv.x * t, y: rel.y + rv.y * t };
      return { time: Math.min(t, horizon), normal: normaliseOrX(npos) };
    }
  }
  return null;
}

function normaliseOrX(v: { x: number; y: number }): { x: number; y: number } {
  const l = Math.hypot(v.x, v.y);
  if (l < 1e-15) return { x: 1, y: 0 };
  return { x: v.x / l, y: v.y / l };
}

const WALL_DEFS: { side: WallSide; gap: (g: ReturnType<typeof wallGaps>) => number; normal: { x: number; y: number }; vel: (d: Disk) => number; pos: (d: Disk) => number; limit: (c: Container) => number }[] = [
  { side: "left", gap: (g) => g.left, normal: { x: 1, y: 0 }, vel: (d) => d.vel.x, pos: (d) => d.pos.x, limit: () => 0 },
  { side: "right", gap: (g) => g.right, normal: { x: -1, y: 0 }, vel: (d) => d.vel.x, pos: (d) => d.pos.x, limit: (c) => c.width },
  { side: "bottom", gap: (g) => g.bottom, normal: { x: 0, y: 1 }, vel: (d) => d.vel.y, pos: (d) => d.pos.y, limit: () => 0 },
  { side: "top", gap: (g) => g.top, normal: { x: 0, y: -1 }, vel: (d) => d.vel.y, pos: (d) => d.pos.y, limit: (c) => c.height },
];

/** Earliest wall contact time for one disk in (0, horizon]. */
export function nextWallContact(
  d: Disk,
  container: Container,
  horizon: number,
  tol: Tolerance,
): { time: number; side: WallSide; normal: { x: number; y: number } }[] {
  const gaps = wallGaps(d, container);
  const found: { time: number; side: WallSide; normal: { x: number; y: number } }[] = [];
  for (const w of WALL_DEFS) {
    const g0 = w.gap(gaps);
    // Normal points from wall into container; approach speed along normal.
    const vn = dot(d.vel, w.normal);
    if (g0 > tol.epsilonPos) {
      // Distance to travel along -normal until touching: t = g0 / (-vn)
      if (vn >= -tol.epsilonVel) continue;
      const t = g0 / -vn;
      if (t > tol.epsilonTime && t <= horizon + tol.epsilonTime) {
        const tt = Math.min(t, horizon);
        found.push({ time: tt, side: w.side, normal: w.normal });
      }
    } else {
      // Already touching: only a contact if moving into the wall.
      if (vn < -tol.epsilonVel) {
        found.push({ time: 0, side: w.side, normal: w.normal });
      }
    }
  }
  if (found.length === 0) return [];
  const earliest = Math.min(...found.map((f) => f.time));
  return found.filter((f) => f.time - earliest <= tol.epsilonTime);
}

/**
 * Collect every contact whose time is within epsilonTime of the earliest one.
 * Sorting of the simultaneous group is fully deterministic (see comparator).
 */
export function findContactGroup(
  disks: Disk[],
  container: Container,
  horizon: number,
  tol: Tolerance,
): { events: ContactEvent[]; earliest: number } | null {
  const candidates: ContactEvent[] = [];
  for (let i = 0; i < disks.length; i++) {
    for (const wc of nextWallContact(disks[i], container, horizon, tol)) {
      const vn = dot(disks[i].vel, wc.normal);
      candidates.push({
        kind: "wall",
        time: wc.time,
        disks: [disks[i].id],
        wall: wc.side,
        normal: wc.normal,
        approachSpeed: vn,
      });
    }
    for (let j = i + 1; j < disks.length; j++) {
      const dc = nextDiskContact(disks[i], disks[j], horizon, tol);
      if (dc) {
        const rv = sub(disks[j].vel, disks[i].vel);
        candidates.push({
          kind: "disk-disk",
          time: dc.time,
          disks: [disks[i].id, disks[j].id],
          normal: dc.normal, // from i to j
          approachSpeed: dot(rv, dc.normal),
        });
      }
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort(compareEvents);
  const earliest = candidates[0].time;
  const events = candidates.filter((c) => c.time - earliest <= tol.epsilonTime);
  return { events, earliest };
}

/**
 * Deterministic tie-break order for equal-time contacts:
 * time -> kind (disk-disk before wall) -> sorted participant ids -> wall side.
 */
export function compareEvents(a: ContactEvent, b: ContactEvent): number {
  if (a.time !== b.time) return a.time - b.time;
  const ka = a.kind === "disk-disk" ? 0 : 1;
  const kb = b.kind === "disk-disk" ? 0 : 1;
  if (ka !== kb) return ka - kb;
  const ai = [...a.disks].sort((x, y) => x - y).join(",");
  const bi = [...b.disks].sort((x, y) => x - y).join(",");
  if (ai !== bi) return ai < bi ? -1 : 1;
  return (a.wall ?? "").localeCompare(b.wall ?? "");
}
