/**
 * Core domain types for the 2D frictionless disk simulation.
 *
 * Model assumptions (explicit by design):
 *  - disks live inside an axis-aligned rectangular container
 *  - zero gravity, zero rotation, frictionless (smooth) contacts
 *  - disks are perfectly circular with constant radius/mass
 *  - pairwise restitution e = sqrt(e_i * e_j); wall restitution = disk's own e
 */

export interface Vec2 {
  x: number;
  y: number;
}

export interface Disk {
  id: number;
  radius: number;
  mass: number;
  /** Position of the disk centre. */
  pos: Vec2;
  vel: Vec2;
  /** Coefficient of restitution in [0,1]. */
  restitution: number;
}

export interface Container {
  width: number;
  height: number;
}

/** All floating-point tolerance knobs are public and recorded per collision. */
export interface Tolerance {
  /** Positional epsilon in world length units (contact distance slack). */
  epsilonPos: number;
  /** Relative normal speed below which contact is treated as resting. */
  epsilonVel: number;
  /** Times smaller than this are treated as zero-time (simultaneous) events. */
  epsilonTime: number;
  /** Max iterations of the simultaneous sequential-impulse solver. */
  maxIterations: number;
  /** Convergence threshold: max residual relative normal speed. */
  toleranceVel: number;
}

export const DEFAULT_TOLERANCE: Tolerance = {
  epsilonPos: 1e-9,
  epsilonVel: 1e-11,
  epsilonTime: 1e-12,
  maxIterations: 64,
  toleranceVel: 1e-10,
};

export type ContactKind = "disk-disk" | "wall";
export type WallSide = "left" | "right" | "bottom" | "top";

/** A candidate/resolved contact event. */
export interface ContactEvent {
  kind: ContactKind;
  /** Simulation time at which the contact occurs. */
  time: number;
  /** Participant disk ids (one for a wall contact, two for a disk contact). */
  disks: [number] | [number, number];
  wall?: WallSide;
  /** Outward contact normal, from the first participant toward the second/surface. */
  normal: Vec2;
  /** Signed approach speed along the normal (< 0 means approaching). */
  approachSpeed: number;
}

/** A single normal impulse applied within a (possibly simultaneous) collision. */
export interface ImpulseRecord {
  kind: ContactKind;
  disks: [number] | [number, number];
  wall?: WallSide;
  normal: Vec2;
  /** Non-negative scalar magnitude of the accumulated normal impulse. */
  magnitude: number;
  /** Vector impulse applied to the first disk (second gets the negation / wall absorbs it). */
  impulseOnFirst: Vec2;
  /** Pre-contact velocities of participants, in `disks` order. */
  velBefore: Vec2[];
  /** Post-contact velocities of participants, in `disks` order. */
  velAfter: Vec2[];
}

export interface CollisionRecord {
  id: number;
  sceneId: number;
  time: number;
  kind: ContactKind;
  disks: number[];
  wall: WallSide | null;
  normal: Vec2;
  impulses: ImpulseRecord[];
  /** Total scalar impulse(s); for wall contacts this is the momentum transferred to the wall. */
  impulseMagnitude: number;
  velBefore: Vec2[];
  velAfter: Vec2[];
  /** Which tolerance configuration produced this record. */
  tolerance: Tolerance;
  /** Solver metadata for simultaneous contacts. */
  simultaneous: boolean;
  iterations: number;
  converged: boolean;
  /** Monotonic scene version at the time the record was written. */
  version: number;
}

export interface TrajectoryPoint {
  time: number;
  pos: Vec2;
  vel: Vec2;
}

export interface Snapshot {
  time: number;
  paused: boolean;
  disks: Disk[];
  version: number;
  /** Set when the zero-time event loop hit its cap. */
  stopReason: string | null;
}
