import type { SceneSpec } from "./types.js";

/** Fictional, deterministic demo scenes (no external assets/randomness). */
export const FICTIONAL_SCENES: Record<string, () => SceneSpec> = {
  headon: () => ({
    width: 20,
    height: 10,
    restitution: 1,
    disks: [
      { id: 1, r: 1, m: 1, x: 5, y: 5, vx: 2, vy: 0 },
      { id: 2, r: 1, m: 1, x: 15, y: 5, vx: -2, vy: 0 },
    ],
  }),
  unequal: () => ({
    width: 20,
    height: 10,
    restitution: 0.8,
    disks: [
      { id: 1, r: 1, m: 1, x: 4, y: 5, vx: 3, vy: 0 },
      { id: 2, r: 1.5, m: 4, x: 14, y: 5, vx: -1, vy: 0 },
    ],
  }),
  grazing: () => ({
    width: 20,
    height: 10,
    restitution: 1,
    disks: [
      { id: 1, r: 1, m: 1, x: 3, y: 4.5, vx: 4, vy: 0 },
      { id: 2, r: 1, m: 1, x: 10, y: 5.5, vx: 0, vy: 0 },
    ],
  }),
  pursuit: () => ({
    width: 30,
    height: 6,
    restitution: 0.9,
    disks: [
      { id: 1, r: 1, m: 1, x: 3, y: 3, vx: 6, vy: 0 },
      { id: 2, r: 1, m: 1, x: 10, y: 3, vx: 2, vy: 0 },
      { id: 3, r: 1, m: 2, x: 20, y: 3, vx: 1, vy: 0 },
    ],
  }),
  highspeedWall: () => ({
    width: 100,
    height: 10,
    restitution: 0.95,
    disks: [{ id: 1, r: 0.5, m: 1, x: 1, y: 5, vx: 1000, vy: 0 }],
  }),
  simultaneous: () => ({
    width: 20,
    height: 10,
    restitution: 1,
    disks: [
      { id: 1, r: 1, m: 1, x: 6, y: 5, vx: 2, vy: 0 },
      { id: 2, r: 1, m: 1, x: 10, y: 5, vx: 0, vy: 0 },
      { id: 3, r: 1, m: 1, x: 14, y: 5, vx: -2, vy: 0 },
    ],
  }),
  billiards: () => ({
    width: 24,
    height: 12,
    restitution: 0.95,
    disks: [
      { id: 1, r: 0.6, m: 1, x: 3, y: 6, vx: 5, vy: 1.2 },
      { id: 2, r: 0.6, m: 1, x: 12, y: 6, vx: 0, vy: 0 },
      { id: 3, r: 0.6, m: 1, x: 13.2, y: 6, vx: 0, vy: 0 },
      { id: 4, r: 0.6, m: 1, x: 12.6, y: 4.960769, vx: 0, vy: 0 },
    ],
  }),
};

export function listPresets(): string[] {
  return Object.keys(FICTIONAL_SCENES);
}
