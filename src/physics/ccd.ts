import type { DiskState, ToleranceConfig, Vec2 } from "../types.js";
import { SimError } from "../types.js";

export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);

export function kineticEnergy(disks: DiskState[]): number {
  return disks.reduce((s, d) => s + 0.5 * d.m * (d.vx * d.vx + d.vy * d.vy), 0);
}

export function totalMomentum(disks: DiskState[]): Vec2 {
  return disks.reduce(
    (acc, d) => ({ x: acc.x + d.m * d.vx, y: acc.y + d.m * d.vy }),
    { x: 0, y: 0 },
  );
}

export interface ContactCandidate {
  kind: "disk-disk" | "disk-wall";
  a: number;
  /** other disk id, or wall index 0..3 */
  b: number;
  /** contact time > 0 */
  t: number;
  /** contact normal n pointing toward the body that receives +j*n:
   * disk-disk: from B toward A; disk-wall: from the wall inward toward the disk.
   * vn = (vA - vB) . n < 0 means approaching. */
  nx: number;
  ny: number;
  /** signed approach speed along the normal (negative = approaching) */
  approach: number;
}

/**
 * Earliest contact (root of |pA(t)-pB(t)| = rA+rB) for two free-flying disks,
 * searching strictly in (0, horizon]. Resting / separating pairs return null.
 * Analytic quadratic; no coarse stepping, so arbitrarily fast disks cannot tunnel.
 */
export function diskDiskContact(
  a: DiskState,
  b: DiskState,
  horizon: number,
  tol: ToleranceConfig,
): ContactCandidate | null {
  const px = a.x - b.x;
  const py = a.y - b.y;
  const dvx = a.vx - b.vx;
  const dvy = a.vy - b.vy;
  const rr = a.r + b.r;
  const A = dvx * dvx + dvy * dvy;
  const B = 2 * (px * dvx + py * dvy);
  const C = px * px + py * py - rr * rr;
  const dist = Math.hypot(px, py);

  if (C < -tol.contactEps) {
    throw new SimError(
      "INITIAL_OVERLAP",
      `Disks ${a.id} and ${b.id} initially overlap (gap ${dist - rr})`,
      { a: a.id, b: b.id, gap: dist - rr },
    );
  }

  if (A <= tol.restingSpeed * tol.restingSpeed) return null;

  const disc = B * B - 4 * A * C;
  if (disc < 0) return null;
  const sq = Math.sqrt(Math.max(0, disc));
  const t1 = (-B - sq) / (2 * A);
  const t2 = (-B + sq) / (2 * A);

  // Roots in (0, horizon] count; roots below timeEps are clamped to 0 so the
  // engine treats them as zero-dt contacts (and can guard stuck loops) rather
  // than tunneling past a very close contact.
  let t = -1;
  if (t1 > 0 && t1 <= horizon) t = Math.max(0, t1);
  else if (t2 > 0 && t2 <= horizon) t = Math.max(0, t2);
  if (t < 0) return null;

  // Normalize the separation direction. When the transverse separation is
  // zero (exactly head-on), the floating-point center distance is not exactly
  // rr, so normalize by rr directly to keep the axis component at exactly 1.
  const cx = px + dvx * t;
  const cy = py + dvy * t;
  const axisAligned =
    Math.abs(cy) < tol.contactEps || Math.abs(cx) < tol.contactEps;
  const nl = axisAligned ? rr : Math.hypot(cx, cy) || rr;
  const nx = cx / nl;
  const ny = cy / nl;
  const approach = dvx * nx + dvy * ny;
  if (approach >= -tol.restingSpeed) return null;

  return { kind: "disk-disk", a: a.id, b: b.id, t, nx, ny, approach };
}

/**
 * Earliest wall contact for one disk over (0, horizon]. Walls:
 * 0=left x=r, 1=right x=W-r, 2=bottom y=r, 3=top y=H-r.
 * Normal points from the wall into the container.
 */
export function diskWallContact(
  d: DiskState,
  width: number,
  height: number,
  horizon: number,
  tol: ToleranceConfig,
): ContactCandidate | null {
  const walls: { b: number; dist: number; vel: number; nx: number; ny: number }[] = [
    // normals point from the wall TOWARD the disk (inward), matching the
    // disk-disk convention that n points toward the body receiving +j*n:
    // left +x, right -x, bottom +y, top -y
    { b: 0, dist: d.x - d.r, vel: d.vx, nx: 1, ny: 0 },
    { b: 1, dist: width - d.r - d.x, vel: -d.vx, nx: -1, ny: 0 },
    { b: 2, dist: d.y - d.r, vel: d.vy, nx: 0, ny: 1 },
    { b: 3, dist: height - d.r - d.y, vel: -d.vy, nx: 0, ny: -1 },
  ];
  let best: ContactCandidate | null = null;
  for (const w of walls) {
    if (w.dist < -tol.contactEps) {
      throw new SimError(
        "INITIAL_OVERLAP",
        `Disk ${d.id} initially penetrates wall ${w.b} (gap ${w.dist})`,
        { disk: d.id, wall: w.b, gap: w.dist },
      );
    }
    // First arrival time. A fast disk may already be past the boundary at the
    // end of the horizon (it separated again), so we cannot gate on endpoint
    // velocity: solve the linear boundary-crossing root directly.
    let t: number | null = null;
    if (w.vel < -tol.restingSpeed) {
      t = w.dist / -w.vel; // moving toward this wall
    } else if (w.vel > tol.restingSpeed && w.dist < 0) {
      // already crossed this wall within the horizon: contact was at t=0+
      t = 0;
    }
    if (t === null || t < 0 || t > horizon) continue;
    t = Math.max(0, t);
    if (!best || t < best.t - tol.timeEps) {
      best = {
        kind: "disk-wall",
        a: d.id,
        b: w.b,
        t,
        nx: w.nx,
        ny: w.ny,
        approach: w.vel,
      };
    }
  }
  return best;
}
