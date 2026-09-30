export interface Vec2 {
  x: number;
  y: number;
}

export interface DiskSpec {
  id: number;
  r: number;
  m: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface DiskState extends DiskSpec {}

export interface SceneSpec {
  width: number;
  height: number;
  restitution: number;
  disks: DiskSpec[];
}

export const TOL_DEFAULTS = {
  /** Separation gap (world units) treated as "in contact" / approaching contact. */
  contactEps: 1e-9,
  /** Relative normal speed below which contact is considered resting. */
  restingSpeed: 1e-9,
  /** Root-finding tolerance on time (seconds). */
  timeEps: 1e-12,
  /** Positional correction fraction (Baumgarte-style slop blend). */
  slop: 1e-8,
  /** Max iterations of simultaneous impulse solver at one instant. */
  maxIterations: 32,
  /** Velocity-change L-infinity threshold for declaring solver convergence. */
  velocityTol: 1e-11,
  /** Max number of zero-dt events before the engine stops a stuck loop. */
  maxZeroDtEvents: 256,
} as const;

export type ToleranceConfig = typeof TOL_DEFAULTS;

export type EventKind = "disk-disk" | "disk-wall";

export interface CollisionEvent {
  seq: number;
  kind: EventKind;
  t: number;
  a: number;
  /** Second disk id for disk-disk; wall index 0=L 1=R 2=B 3=T for disk-wall. */
  b: number;
  nx: number;
  ny: number;
  impulse: number;
  iterations: number;
  converged: boolean;
  vaxBefore: number;
  vayBefore: number;
  vbxBefore: number;
  vbyBefore: number;
  vaxAfter: number;
  vayAfter: number;
  vbxAfter: number;
  vbyAfter: number;
  tolContactEps: number;
  tolTimeEps: number;
  tolRestingSpeed: number;
  idempotencyKey: string | null;
}

export interface Snapshot {
  t: number;
  eventSeq: number;
  disks: DiskState[];
  wallImpulse: Vec2;
  wallImpulseCount: number;
  ke: number;
  momentum: Vec2;
  stoppedReason: string | null;
}

export class SimError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "SimError";
  }
}
