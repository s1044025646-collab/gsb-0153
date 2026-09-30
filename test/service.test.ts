import { test } from "node:test";
import assert from "node:assert/strict";
import { tempDb, newService } from "./helpers.js";
import { FICTIONAL_SCENES } from "../src/scenes.js";
import { SimError } from "../src/types.js";

test("create + run + restart: state persists and continuation is deterministic", () => {
  const tmp = tempDb();
  try {
    const svc = newService(tmp.path);
    const { id } = svc.createScene("s1", FICTIONAL_SCENES["headon"]!());
    svc.run(id, 2.5);
    const mid = svc.getStatus(id);
    svc.db.close();

    const reopened = newService(tmp.path);
    const afterRestart = reopened.getStatus(id);
    assert.equal(afterRestart.t, mid.t);
    assert.equal(afterRestart.eventSeq, mid.eventSeq);
    for (let i = 0; i < mid.disks.length; i++) {
      assert.deepEqual(afterRestart.disks[i], mid.disks[i]);
    }
    reopened.run(id, 2.5);
    const continued = reopened.getStatus(id);
    assert.ok(Math.abs(continued.t - 5) < 1e-9);
    reopened.db.close();
  } finally {
    tmp.close();
  }
});

test("idempotent run with same key does not advance twice", () => {
  const tmp = tempDb();
  try {
    const svc = newService(tmp.path);
    const { id } = svc.createScene("s", FICTIONAL_SCENES["headon"]!());
    const first = svc.run(id, 2.5, "key-1");
    assert.equal(first.reused, false);
    const again = svc.run(id, 2.5, "key-1");
    assert.equal(again.reused, true);
    assert.equal(again.after.t, first.after.t);
    assert.equal(svc.getStatus(id).t, first.after.t);
  } finally {
    tmp.close();
  }
});

test("idempotent create does not duplicate scene", () => {
  const tmp = tempDb();
  try {
    const svc = newService(tmp.path);
    const a = svc.createScene("uniq", FICTIONAL_SCENES["headon"]!(), "ck");
    const b = svc.createScene("uniq", FICTIONAL_SCENES["headon"]!(), "ck");
    assert.equal(a.id, b.id);
    assert.equal(b.reused, true);
    assert.equal(svc.listScenes(1, 50).total, 1);
  } finally {
    tmp.close();
  }
});

test("duplicate name and invalid duration return stable error codes", () => {
  const tmp = tempDb();
  try {
    const svc = newService(tmp.path);
    svc.createScene("dup", FICTIONAL_SCENES["headon"]!());
    assert.throws(
      () => svc.createScene("dup", FICTIONAL_SCENES["headon"]!()),
      (e: unknown) => e instanceof SimError && e.code === "NAME_CONFLICT",
    );
    const { id } = svc.createScene("d", FICTIONAL_SCENES["headon"]!());
    assert.throws(
      () => svc.run(id, -1),
      (e: unknown) => e instanceof SimError && e.code === "INVALID_DURATION",
    );
  } finally {
    tmp.close();
  }
});

test("transaction rollback on failed create leaves no disks/scene", () => {
  const tmp = tempDb();
  try {
    const svc = newService(tmp.path);
    const bad = FICTIONAL_SCENES["headon"]!();
    bad.disks[1] = { ...bad.disks[1]!, x: bad.disks[0]!.x }; // force overlap
    assert.throws(
      () => svc.createScene("broken", bad),
      (e: unknown) => e instanceof SimError && e.code === "INITIAL_OVERLAP",
    );
    assert.equal(svc.listScenes(1, 50).total, 0);
    const count = svc.db
      .prepare("SELECT COUNT(*) AS c FROM disks")
      .get() as { c: number };
    assert.equal(count.c, 0);
  } finally {
    tmp.close();
  }
});

test("event pagination metadata is correct", () => {
  const tmp = tempDb();
  try {
    const svc = newService(tmp.path);
    const { id } = svc.createScene("p", FICTIONAL_SCENES["highspeedWall"]!());
    svc.run(id, 1);
    const page1 = svc.listEvents(id, 1, 5);
    assert.equal(page1.items.length, 5);
    assert.ok(page1.totalPages >= 2);
    const page2 = svc.listEvents(id, 2, 5);
    assert.equal(page2.items.length, Math.min(5, page1.total - 5));
    assert.notEqual(page1.items[0]!.seq, page2.items[0]!.seq);
  } finally {
    tmp.close();
  }
});

test("restitution clone compares energy: e=0 vs e=1, same geometry", () => {
  const tmp = tempDb();
  try {
    const svc = newService(tmp.path);
    const { id } = svc.createScene("base", FICTIONAL_SCENES["headon"]!());
    const cloneId = svc.cloneWithRestitution(id, "soft", 0);
    svc.run(id, 4, "base-run");
    svc.run(cloneId, 4, "soft-run");
    const elastic = svc.getStatus(id);
    const soft = svc.getStatus(cloneId);
    assert.ok(soft.kineticEnergy < elastic.kineticEnergy - 1e-6);
    // momentum in a no-wall head-on phase stays zero for both
    assert.ok(Math.abs(soft.momentum.x) < 1e-9);
  } finally {
    tmp.close();
  }
});

test("wall impulse is reported and disk momentum change balances it", () => {
  const tmp = tempDb();
  try {
    const svc = newService(tmp.path);
    const { id } = svc.createScene("w", FICTIONAL_SCENES["highspeedWall"]!());
    const r = svc.run(id, 0.5);
    // initial disk momentum = +1000 x
    const diskPx = r.after.momentum.x;
    const wallPx = r.after.wallImpulse.x;
    const residual = Math.abs(diskPx - (1000 + wallPx));
    assert.ok(
      residual < 1e-6 * Math.max(1, Math.abs(wallPx)),
      `momentum balance residual ${residual}`,
    );
    assert.ok(r.after.wallImpulseCount >= 1);
  } finally {
    tmp.close();
  }
});

test("trajectory export contains start and post-run samples", () => {
  const tmp = tempDb();
  try {
    const svc = newService(tmp.path);
    const { id } = svc.createScene("t", FICTIONAL_SCENES["headon"]!());
    svc.run(id, 1);
    const rows = svc.exportTrajectory(id);
    assert.ok(rows.some((r) => r.t === 0));
    assert.ok(rows.some((r) => Math.abs(r.t - 1) < 1e-9));
  } finally {
    tmp.close();
  }
});
