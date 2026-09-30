import type { Disk, Vec2 } from "./types.js";
import { dot } from "./geometry.js";

export interface Moment {
  p: Vec2;
  kineticEnergy: number;
}

/** Linear momentum of the disks alone (walls can exchange momentum with them). */
export function totalMomentum(disks: Disk[]): Vec2 {
  const p = { x: 0, y: 0 };
  for (const d of disks) {
    p.x += d.mass * d.vel.x;
    p.y += d.mass * d.vel.y;
  }
  return p;
}

/** Total translational kinetic energy sum(1/2 m v^2). */
export function kineticEnergy(disks: Disk[]): number {
  let ke = 0;
  for (const d of disks) ke += 0.5 * d.mass * dot(d.vel, d.vel);
  return ke;
}

export function summarize(disks: Disk[]): Moment {
  return { p: totalMomentum(disks), kineticEnergy: kineticEnergy(disks) };
}

/**
 * Net outward impulse delivered to the walls by the disks, per axis.
 * Wall events do NOT violate momentum conservation: the missing disk momentum
 * is exactly the impulse transferred to the (immovable) container.
 */
export function wallImpulseFrom(records: { impulses: { kind: string; impulseOnFirst: Vec2 }[] }[]): Vec2 {
  const w = { x: 0, y: 0 };
  for (const rec of records) {
    for (const imp of rec.impulses) {
      if (imp.kind === "wall") {
        // impulseOnFirst is applied to the disk; wall receives its negation.
        w.x -= imp.impulseOnFirst.x;
        w.y -= imp.impulseOnFirst.y;
      }
    }
  }
  return w;
}
