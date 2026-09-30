import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations } from "../src/db/migrate.js";
import { SceneRepository } from "../src/db/repo.js";
import type { Container, Disk, Tolerance } from "../src/physics/types.js";
import { DEFAULT_TOLERANCE } from "../src/physics/types.js";
import { advanceTo } from "../src/physics/engine.js";
import type { Snapshot } from "../src/physics/types.js";

let counter = 0;

export function tempDbPath(): string {
  counter += 1;
  const dir = mkdtempSync(join(tmpdir(), "disk-sim-"));
  return join(dir, `test-${process.pid}-${counter}.sqlite`);
}

export function makeRepo(clock?: () => number): { repo: SceneRepository; db: DatabaseSync; path: string } {
  const path = tempDbPath();
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  applyMigrations(db);
  return { repo: new SceneRepository(db, clock), db, path };
}

export function disk(id: number, d: Partial<Disk> & { pos: Disk["pos"]; vel: Disk["vel"] }): Disk {
  return { id, radius: d.radius ?? 1, mass: d.mass ?? 1, restitution: d.restitution ?? 1, pos: d.pos, vel: d.vel };
}

export function runEngine(
  container: Container,
  disks: Disk[],
  target: number,
  tolerance: Tolerance = DEFAULT_TOLERANCE,
) {
  const snapshot: Snapshot = { time: 0, paused: false, disks, version: 1, stopReason: null };
  const collisions: any[] = [];
  const result = advanceTo(container, disks.map((d) => ({ ...d, pos: { ...d.pos }, vel: { ...d.vel } })), snapshot, target, tolerance, {
    version: 1,
    onCollision: (c) => collisions.push(c),
  });
  return { ...result, collisions, snapshot: result.snapshot };
}

export function closeEnough(a: number, b: number, eps = 1e-7): boolean {
  return Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
}
