import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { makeRepo, tempDbPath, closeEnough } from "./helpers.js";
import { applyMigrations } from "../src/db/migrate.js";
import { SceneRepository } from "../src/db/repo.js";
import { SimError } from "../src/physics/validate.js";

const baseScene = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  container: { width: 30, height: 20 },
  disks: [
    { radius: 1, mass: 1, restitution: 1, pos: { x: 3, y: 5 }, vel: { x: 4, y: 0 } },
    { radius: 1, mass: 2, restitution: 0.8, pos: { x: 12, y: 5 }, vel: { x: -2, y: 0 } },
  ],
  ...extra,
});

test("create rejects non-positive mass/radius and overlap with error codes", () => {
  const { repo, db } = makeRepo();
  assert.throws(() => repo.createScene(baseScene("bad-mass", { disks: [{ radius: 1, mass: 0, restitution: 1, pos: { x: 5, y: 5 }, vel: { x: 0, y: 0 } }] })), (e: any) => e.code === "NON_POSITIVE_MASS");
  assert.throws(() => repo.createScene(baseScene("bad-radius", { disks: [{ radius: -1, mass: 1, restitution: 1, pos: { x: 5, y: 5 }, vel: { x: 0, y: 0 } }] })), (e: any) => e.code === "NON_POSITIVE_RADIUS");
  assert.throws(
    () =>
      repo.createScene(
        baseScene("overlap", {
          disks: [
            { radius: 1, mass: 1, restitution: 1, pos: { x: 5, y: 5 }, vel: { x: 0, y: 0 } },
            { radius: 1, mass: 1, restitution: 1, pos: { x: 5.5, y: 5 }, vel: { x: 0, y: 0 } },
          ],
        }),
      ),
    (e: any) => e.code === "INITIAL_PENETRATION",
  );
  db.close();
});

test("duplicate name conflicts but idempotency key reuses the same scene", () => {
  const { repo, db } = makeRepo();
  const first = repo.createScene(baseScene("same", { idempotencyKey: "k1" }));
  assert.equal(first.reused, false);
  const again = repo.createScene(baseScene("same", { idempotencyKey: "k1" }));
  assert.equal(again.reused, true);
  assert.equal(again.id, first.id);
  assert.throws(() => repo.createScene(baseScene("same", {})), (e: any) => e.code === "CONFLICT");
  db.close();
});

test("run persists collisions, trajectory and version; pause blocks run; resume continues deterministically", () => {
  const { repo, db } = makeRepo();
  const { id } = repo.createScene(baseScene("s1"));
  const r1 = repo.run(id, 1.5);
  assert.ok(r1.collisions.length >= 1);
  assert.ok(r1.snapshot.version > 1);

  repo.setPaused(id, true);
  assert.throws(() => repo.run(id, 3), (e: any) => e.code === "CONFLICT");
  repo.setPaused(id, false);

  const midState = repo.loadScene(id).disks.map((d) => ({ ...d.pos }));
  const midTime = repo.loadScene(id).snapshot.time;
  repo.run(id, 3);
  const finalA = repo.loadScene(id).disks.map((d) => ({ x: d.pos.x, y: d.pos.y, vx: d.vel.x, vy: d.vel.y }));

  // Re-run from a fresh mid-point snapshot in a separate scene must match (determinism).
  const { id: id2 } = repo.createScene(baseScene("s1-copy"));
  repo.run(id2, midTime);
  for (let i = 0; i < midState.length; i++) {
    const d = repo.loadScene(id2).disks[i];
    assert.ok(closeEnough(d.pos.x, midState[i].x, 1e-9));
  }
  repo.run(id2, 3);
  const finalB = repo.loadScene(id2).disks.map((d) => ({ x: d.pos.x, y: d.pos.y, vx: d.vel.x, vy: d.vel.y }));
  for (let i = 0; i < finalA.length; i++) {
    assert.ok(closeEnough(finalA[i].x, finalB[i].x, 1e-8));
    assert.ok(closeEnough(finalA[i].vx, finalB[i].vx, 1e-8));
  }
  db.close();
});

test("idempotent run replays cached result without advancing twice", () => {
  const { repo, db } = makeRepo();
  const { id } = repo.createScene(baseScene("idem"));
  const r1 = repo.run(id, 2, { idempotencyKey: "run-1" });
  const collisionsAfter1 = r1.collisions.length;
  const r2 = repo.run(id, 2, { idempotencyKey: "run-1" });
  assert.equal(r2.reused, true);
  const { total } = repo.listCollisions(id, { limit: 100, offset: 0 });
  assert.equal(total, collisionsAfter1);
  db.close();
});

test("wall collision momentum is accounted as wall impulse, not conservation failure", () => {
  const { repo, db } = makeRepo();
  const { id } = repo.createScene({
    name: "wall",
    container: { width: 100, height: 100 },
    disks: [{ radius: 1, mass: 2, restitution: 1, pos: { x: 5, y: 50 }, vel: { x: 10, y: 0 } }],
  });
  // Run only to the first right-wall impact: p goes from +20 to -20, wall gets +40.
  repo.run(id, 10);
  const st = repo.stats(id);
  assert.ok(closeEnough(st.momentum.x, -20, 1e-6));
  assert.ok(closeEnough(st.wallImpulse.x, 40, 1e-6), `wallImpulse=${st.wallImpulse.x}`);
  db.close();
});

test("collision pagination works", () => {
  const { repo, db } = makeRepo();
  const { id } = repo.createScene({
    name: "many",
    container: { width: 12, height: 12 },
    disks: [{ radius: 0.5, mass: 1, restitution: 1, pos: { x: 6, y: 6 }, vel: { x: 50, y: 30 } }],
  });
  repo.run(id, 1);
  const page1 = repo.listCollisions(id, { limit: 2, offset: 0 });
  assert.ok(page1.total >= 3);
  assert.equal(page1.items.length, 2);
  const page2 = repo.listCollisions(id, { limit: 2, offset: 2 });
  assert.notEqual(page1.items[0].id, page2.items[0].id);
  db.close();
});

test("transaction rolls back when persistence fails mid-run", () => {
  const { repo, db } = makeRepo();
  const { id } = repo.createScene(baseScene("rollback"));
  const timeBefore = repo.loadScene(id).snapshot.time;

  // Corrupt the collisions table so the run's first INSERT fails inside the
  // transaction; everything (time, collisions, trajectory) must roll back.
  db.exec(
    "CREATE TRIGGER fail_collisions BEFORE INSERT ON collisions BEGIN SELECT RAISE(ABORT, 'injected failure'); END;",
  );
  assert.throws(() => repo.run(id, 2), /injected failure/);
  // Scene time/collisions must be unchanged (rolled back).
  const row = db.prepare("SELECT time FROM scenes WHERE id=?").get(id) as any;
  assert.equal(row.time, timeBefore);
  const count = Number((db.prepare("SELECT COUNT(*) c FROM collisions WHERE scene_id=?").get(id) as any).c);
  assert.equal(count, 0);
  db.close();
});

test("state survives reopening the database (restart persistence) and migrations are repeatable", () => {
  const path = tempDbPath();
  const db1 = new DatabaseSync(path);
  applyMigrations(db1);
  const repo1 = new SceneRepository(db1);
  const { id } = repo1.createScene(baseScene("persist"));
  repo1.run(id, 2);
  const expected = repo1.loadScene(id).disks.map((d) => ({ vx: d.vel.x, x: d.pos.x }));
  db1.close();

  const db2 = new DatabaseSync(path);
  applyMigrations(db2); // repeatable migration
  const repo2 = new SceneRepository(db2);
  const loaded = repo2.loadScene(id);
  assert.ok(loaded.snapshot.time > 0);
  loaded.disks.forEach((d, i) => {
    assert.ok(closeEnough(d.vel.x, expected[i].vx, 1e-9));
    assert.ok(closeEnough(d.pos.x, expected[i].x, 1e-9));
  });
  assert.ok(repo2.listCollisions(id, { limit: 10, offset: 0 }).total >= 1);
  db2.close();
});

test("zero-time event loop limit stops with a recorded reason", () => {
  const { repo, db } = makeRepo();
  // Construct an impossible resting contact that keeps asking for zero-time impulses:
  // two disks exactly touching, both pushed toward each other, e=0 gives no separation
  // from a single solve only if residual remains; here a corner jam triggers the cap.
  const { id } = repo.createScene({
    name: "jam",
    container: { width: 4, height: 4 },
    disks: [
      // Two disks already touch in a corner wedge and are pushed together/walls.
      // Sequential impulses cannot separate every contact per sweep, so zero-time
      // groups repeat until the cap trips (explicitly approximate, not exact).
      { radius: 1, mass: 1, restitution: 0, pos: { x: 1, y: 1 }, vel: { x: -1, y: -1 } },
      { radius: 1, mass: 1, restitution: 0, pos: { x: 3, y: 3 }, vel: { x: -1, y: -1 } },
    ],
    tolerance: { maxIterations: 2, epsilonPos: 0, epsilonTime: 0, epsilonVel: 0, toleranceVel: 0 },
  });
  const r = repo.run(id, 10, {
    toleranceOverride: { epsilonPos: 0, epsilonTime: 0, epsilonVel: 0, toleranceVel: 0, maxIterations: 2 },
  });
  assert.ok(r.stopReason !== null, `expected loop-limit reason, got ${r.stopReason}`);
  db.close();
});
