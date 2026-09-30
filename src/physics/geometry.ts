import type { Container, Disk, Vec2 } from "./types.js";

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scale(a: Vec2, s: number): Vec2 {
  return { x: a.x * s, y: a.y * s };
}

export function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

export function length(a: Vec2): number {
  return Math.hypot(a.x, a.y);
}

/** Advance every disk centre by v * dt along a straight line. */
export function advance(disks: Disk[], dt: number): void {
  for (const d of disks) {
    d.pos.x += d.vel.x * dt;
    d.pos.y += d.vel.y * dt;
  }
}

/**
 * Signed normalised gap between two disks:
 *   positive => separated, zero => touching, negative => overlapping.
 */
export function diskGap(a: Disk, b: Disk): number {
  return length(sub(b.pos, a.pos)) - (a.radius + b.radius);
}

/** Signed gaps from a disk to each of the four container walls (negative = penetrated). */
export function wallGaps(d: Disk, c: Container): { left: number; right: number; bottom: number; top: number } {
  return {
    left: d.pos.x - d.radius,
    right: c.width - (d.pos.x + d.radius),
    bottom: d.pos.y - d.radius,
    top: c.height - (d.pos.y + d.radius),
  };
}
