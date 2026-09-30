import type { Container, Disk, Tolerance } from "./types.js";
import { diskGap, wallGaps } from "./geometry.js";

export type ErrorCode =
  | "VALIDATION"
  | "INITIAL_PENETRATION"
  | "DISK_DOES_NOT_FIT"
  | "NON_POSITIVE_MASS"
  | "NON_POSITIVE_RADIUS"
  | "BAD_RESTITUTION"
  | "BAD_CONTAINER"
  | "EVENT_LOOP_LIMIT"
  | "NOT_FOUND"
  | "BAD_REQUEST"
  | "CONFLICT";

export class SimError extends Error {
  code: ErrorCode;
  details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Validate raw disk input; throws SimError with a stable error code. */
export function validateDiskInput(raw: any, index: number): void {
  const where = `disk[${index}]`;
  if (!raw || typeof raw !== "object") throw new SimError("VALIDATION", `${where} must be an object`);
  for (const k of ["radius", "mass", "restitution", "pos", "vel"]) {
    if (raw[k] === undefined) throw new SimError("VALIDATION", `${where}.${k} is required`);
  }
  if (!isFiniteNumber(raw.radius) || raw.radius <= 0)
    throw new SimError("NON_POSITIVE_RADIUS", `${where}.radius must be a finite positive number`);
  if (!isFiniteNumber(raw.mass) || raw.mass <= 0)
    throw new SimError("NON_POSITIVE_MASS", `${where}.mass must be a finite positive number`);
  if (!isFiniteNumber(raw.restitution) || raw.restitution < 0 || raw.restitution > 1)
    throw new SimError("BAD_RESTITUTION", `${where}.restitution must be within [0,1]`);
  if (!isFiniteNumber(raw.pos.x) || !isFiniteNumber(raw.pos.y) || !isFiniteNumber(raw.vel.x) || !isFiniteNumber(raw.vel.y))
    throw new SimError("VALIDATION", `${where} position/velocity components must be finite numbers`);
}

export function validateContainer(raw: any): Container {
  if (!raw || !isFiniteNumber(raw.width) || !isFiniteNumber(raw.height) || raw.width <= 0 || raw.height <= 0)
    throw new SimError("BAD_CONTAINER", "container width/height must be finite positive numbers");
  return { width: raw.width, height: raw.height };
}

export function validateTolerance(raw: any): Tolerance | null {
  if (raw === undefined || raw === null) return null;
  const keys: (keyof Tolerance)[] = ["epsilonPos", "epsilonVel", "epsilonTime", "maxIterations", "toleranceVel"];
  for (const k of keys) {
    if (raw[k] !== undefined && (!isFiniteNumber(raw[k]) || raw[k] < 0))
      throw new SimError("VALIDATION", `tolerance.${k} must be a finite non-negative number`);
  }
  if (raw.maxIterations !== undefined && (!Number.isInteger(raw.maxIterations) || raw.maxIterations < 1))
    throw new SimError("VALIDATION", "tolerance.maxIterations must be a positive integer");
  return raw as Tolerance;
}

/**
 * Reject physically impossible initial states:
 *  - a disk larger than the container
  - any pair already overlapping beyond positional tolerance
 *  - any disk already inside a wall beyond positional tolerance
 */
export function validateInitialState(container: Container, disks: Disk[], tol: Tolerance): void {
  for (const d of disks) {
    if (d.radius * 2 > container.width + tol.epsilonPos || d.radius * 2 > container.height + tol.epsilonPos)
      throw new SimError("DISK_DOES_NOT_FIT", `disk ${d.id} diameter exceeds a container dimension`);
    const g = wallGaps(d, container);
    if (Math.min(g.left, g.right, g.bottom, g.top) < -tol.epsilonPos)
      throw new SimError("INITIAL_PENETRATION", `disk ${d.id} starts inside a wall`, g);
  }
  for (let i = 0; i < disks.length; i++) {
    for (let j = i + 1; j < disks.length; j++) {
      const gap = diskGap(disks[i], disks[j]);
      if (gap < -tol.epsilonPos)
        throw new SimError("INITIAL_PENETRATION", `disks ${disks[i].id} and ${disks[j].id} start overlapping`, { gap });
    }
  }
}
