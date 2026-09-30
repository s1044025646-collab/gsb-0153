import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/db.js";
import { SimService } from "../src/service.js";
import { advance, initState, type EngineState } from "../src/physics/engine.js";
import type { SceneSpec, ToleranceConfig } from "../src/types.js";
import { TOL_DEFAULTS } from "../src/types.js";

export function tempDb(): { path: string; close: () => void } {
  const root = join(process.cwd(), "data", "test-tmp");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "disksim-"));
  const path = join(dir, "test.db");
  return {
    path,
    close: () => {
      for (const closer of openHandles.get(path) ?? []) {
        try {
          closer();
        } catch {
          // already closed
        }
      }
      openHandles.delete(path);
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          rmSync(dir, { recursive: true, force: true });
          return;
        } catch {
          // Windows may keep WAL/shm handles open briefly after close.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        }
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const openHandles = new Map<string, Array<() => void>>();

export function trackDb(path: string, closeFn: () => void): void {
  const list = openHandles.get(path) ?? [];
  list.push(closeFn);
  openHandles.set(path, list);
}

export function newService(path: string): SimService {
  const svc = new SimService(openDb(path));
  trackDb(path, () => svc.db.close());
  return svc;
}

export function runPure(
  spec: SceneSpec,
  duration: number,
  tol: ToleranceConfig = TOL_DEFAULTS,
): { state: EngineState; events: ReturnType<typeof advance>["events"] } {
  const state = initState(spec.width, spec.height, spec.restitution, spec.disks);
  const out = advance(state, duration, { tol, recordTrajectory: false });
  return { state: out.state, events: out.events };
}

export const APPROX = 1e-9;

export function assertNoPenetration(state: EngineState, eps = 1e-7): void {
  for (const d of state.disks) {
    if (d.x - d.r < -eps) throw new Error(`disk ${d.id} past left wall`);
    if (d.x + d.r > state.width + eps) throw new Error(`disk ${d.id} past right wall`);
    if (d.y - d.r < -eps) throw new Error(`disk ${d.id} past bottom wall`);
    if (d.y + d.r > state.height + eps) throw new Error(`disk ${d.id} past top wall`);
  }
  for (let i = 0; i < state.disks.length; i++) {
    for (let j = i + 1; j < state.disks.length; j++) {
      const a = state.disks[i]!;
      const b = state.disks[j]!;
      const gap = Math.hypot(a.x - b.x, a.y - b.y) - (a.r + b.r);
      if (gap < -eps) throw new Error(`disks ${a.id},${b.id} overlap by ${-gap}`);
    }
  }
}

/** Analytic post-impact velocities for a 1D two-disk collision. */
export function analyticImpact(
  m1: number,
  u1: number,
  m2: number,
  u2: number,
  e: number,
): { v1: number; v2: number } {
  const p = m1 * u1 + m2 * u2;
  const v1 = (p + m2 * e * (u2 - u1)) / (m1 + m2);
  const v2 = (p + m1 * e * (u1 - u2)) / (m1 + m2);
  return { v1, v2 };
}
