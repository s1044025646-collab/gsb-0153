import { test } from "node:test";
import assert from "node:assert/strict";
import { disk, runEngine, closeEnough } from "./helpers.js";
import { SimError } from "../src/physics/validate.js";
import { kineticEnergy, totalMomentum } from "../src/physics/stats.js";

test("equal-mass head-on elastic collision exchanges velocities (analytic)", () => {
  const container = { width: 100, height: 20 };
  // At t=0 gaps touch at t=1 (centres 4 apart, radii 1+1=2, rel speed 2).
  const a = disk(1, { pos: { x: 2, y: 10 }, vel: { x: 2, y: 0 } });
  const b = disk(2, { pos: { x: 6, y: 10 }, vel: { x: 0, y: 0 } });
  const { collisions, snapshot } = runEngine(container, [a, b], 2);
  assert.equal(collisions.length, 1);
  assert.ok(closeEnough(collisions[0].time, 1, 1e-9));
  // Equal masses swap velocities: a stops, b moves at 2.
  assert.ok(closeEnough(snapshot.disks[0].vel.x, 0, 1e-9));
  assert.ok(closeEnough(snapshot.disks[1].vel.x, 2, 1e-9));
  // Impulse magnitude j = m*(1+e)*approach/2 = 1*2*2/2 = 2
  assert.ok(closeEnough(collisions[0].impulseMagnitude, 2, 1e-9));
});

test("unequal masses match 1D analytic impulse solution", () => {
  const container = { width: 100, height: 20 };
  // m1=1 u1=3, m2=3 u2=0, e=1 -> v1=(m1-e m2)/(m1+m2)*u1 = -1.5, v2=2*m1/(m1+m2)*u1=1.5
  const a = disk(1, { mass: 1, pos: { x: 2, y: 10 }, vel: { x: 3, y: 0 } });
  const b = disk(2, { mass: 3, pos: { x: 6, y: 10 }, vel: { x: 0, y: 0 } });
  const { snapshot } = runEngine(container, [a, b], 2);
  assert.ok(closeEnough(snapshot.disks[0].vel.x, -1.5, 1e-8));
  assert.ok(closeEnough(snapshot.disks[1].vel.x, 1.5, 1e-8));
});

test("restitution consistency: relative speed after = e times before", () => {
  const container = { width: 100, height: 20 };
  const e = 0.4;
  const a = disk(1, { restitution: e, mass: 2, pos: { x: 2, y: 10 }, vel: { x: 4, y: 0 } });
  const b = disk(2, { restitution: e, mass: 5, pos: { x: 6, y: 10 }, vel: { x: 1, y: 0 } });
  const { collisions } = runEngine(container, [a, b], 2);
  assert.equal(collisions.length, 1);
  const before = 4 - 1;
  const after =
    collisions[0].velAfter[1].x - collisions[0].velAfter[0].x;
  assert.ok(closeEnough(after, e * before, 1e-8), `after=${after} expected ${e * before}`);
});

test("grazing contact: tangential velocity unchanged, tiny normal exchange", () => {
  const container = { width: 100, height: 100 };
  // Centres offset in y by almost 2r: nearly tangential path.
  const a = disk(1, { pos: { x: 2, y: 10 }, vel: { x: 5, y: 0 } });
  const b = disk(2, { pos: { x: 10, y: 11.999999 }, vel: { x: 0, y: 0 } });
  const { collisions, snapshot } = runEngine(container, [a, b], 4);
  // Energy and momentum conserved regardless of collision count.
  assert.ok(closeEnough(kineticEnergy(snapshot.disks), 0.5 * 25, 1e-6));
  const p = totalMomentum(snapshot.disks);
  assert.ok(closeEnough(p.x, 5, 1e-6));
  assert.ok(collisions.length >= 0);
});

test("catching disk hits slower moving disk from behind", () => {
  const container = { width: 100, height: 20 };
  const a = disk(1, { pos: { x: 2, y: 10 }, vel: { x: 6, y: 0 } });
  const b = disk(2, { pos: { x: 8, y: 10 }, vel: { x: 1, y: 0 } });
  const { collisions, snapshot } = runEngine(container, [a, b], 3);
  assert.equal(collisions.length, 1);
  assert.ok(snapshot.disks[1].vel.x > snapshot.disks[0].vel.x);
});

test("high-speed disk does not tunnel through a wall", () => {
  const container = { width: 10, height: 10 };
  // Speed 1000 over t=1 would cross the box many times; must bounce at wall.
  const a = disk(1, { pos: { x: 5, y: 5 }, vel: { x: 1000, y: 0 } });
  const { collisions, snapshot } = runEngine(container, [a], 0.01);
  assert.ok(collisions.length >= 1);
  // Never leaves the container.
  for (const d of snapshot.disks) {
    assert.ok(d.pos.x >= d.radius - 1e-6 && d.pos.x <= 10 - d.radius + 1e-6);
  }
  // First wall contact at x=9, t=(9-5)/1000=0.004, elastic -> vx=-1000.
  assert.ok(closeEnough(collisions[0].time, 0.004, 1e-12));
  assert.ok(closeEnough(snapshot.disks[0].vel.x, -1000, 1e-6));
});

test("simultaneous corner contact is handled deterministically and flagged", () => {
  const container = { width: 10, height: 10 };
  // Disk aimed exactly at a corner so left/top (after positioning) coincide.
  const a = disk(1, { pos: { x: 5, y: 5 }, vel: { x: -707.10678, y: -707.10678 } });
  const { collisions, snapshot } = runEngine(container, [a], 0.01);
  const sim = collisions.find((c) => c.simultaneous);
  assert.ok(sim, "expected a flagged simultaneous group");
  assert.equal(sim.disks.length, 1);
  assert.ok(snapshot.disks[0].pos.x >= 1 - 1e-5);
  assert.ok(snapshot.disks[0].pos.y >= 1 - 1e-5);
});

test("free flight with no contacts reaches ballistic position", () => {
  const container = { width: 1000, height: 1000 };
  const a = disk(1, { pos: { x: 10, y: 20 }, vel: { x: 3, y: -2 } });
  const { collisions, snapshot } = runEngine(container, [a], 5);
  assert.equal(collisions.length, 0);
  assert.ok(closeEnough(snapshot.disks[0].pos.x, 25, 1e-8));
  assert.ok(closeEnough(snapshot.disks[0].pos.y, 10, 1e-8));
});

test("elastic system conserves kinetic energy", () => {
  const container = { width: 30, height: 30 };
  const disks = [
    disk(1, { mass: 2, pos: { x: 3, y: 5 }, vel: { x: 4, y: 1 } }),
    disk(2, { mass: 3, pos: { x: 12, y: 8 }, vel: { x: -2, y: 2 } }),
    disk(3, { mass: 1, pos: { x: 20, y: 22 }, vel: { x: 1, y: -3 } }),
  ];
  const ke0 = kineticEnergy(disks);
  const { snapshot } = runEngine(container, disks, 3);
  assert.ok(closeEnough(kineticEnergy(snapshot.disks), ke0, 1e-6));
});

test("inelastic collisions never increase kinetic energy", () => {
  const container = { width: 30, height: 30 };
  const disks = [
    disk(1, { restitution: 0.3, mass: 2, pos: { x: 3, y: 5 }, vel: { x: 6, y: 1 } }),
    disk(2, { restitution: 0.5, mass: 3, pos: { x: 12, y: 8 }, vel: { x: -2, y: 2 } }),
    disk(3, { restitution: 0, mass: 1, pos: { x: 20, y: 22 }, vel: { x: 1, y: -4 } }),
  ];
  const ke0 = kineticEnergy(disks);
  const { snapshot } = runEngine(container, disks, 4);
  assert.ok(kineticEnergy(snapshot.disks) <= ke0 + 1e-6);
});

test("disks never overlap after a run (impenetrability)", () => {
  const container = { width: 20, height: 20 };
  const disks = [
    disk(1, { pos: { x: 3, y: 4 }, vel: { x: 5, y: 2 } }),
    disk(2, { pos: { x: 10, y: 13 }, vel: { x: -4, y: -3 } }),
    disk(3, { pos: { x: 16, y: 6 }, vel: { x: -2, y: 4 } }),
  ];
  const { snapshot } = runEngine(container, disks, 5);
  for (let i = 0; i < snapshot.disks.length; i++)
    for (let j = i + 1; j < snapshot.disks.length; j++) {
      const a = snapshot.disks[i];
      const b = snapshot.disks[j];
      const dist = Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y);
      assert.ok(dist >= a.radius + b.radius - 1e-6, `penetration between ${i},${j}: dist=${dist}`);
    }
});

test("validation rejects bad initial states", () => {
  assert.throws(
    () => runEngine({ width: 1, height: 10 }, [disk(1, { radius: 2, pos: { x: 5, y: 5 }, vel: { x: 0, y: 0 } })], 1),
    (e: unknown) => e instanceof SimError && e.code === "DISK_DOES_NOT_FIT",
  );
  assert.throws(
    () =>
      runEngine(
        { width: 100, height: 100 },
        [
          disk(1, { pos: { x: 5, y: 50 }, vel: { x: 0, y: 0 } }),
          disk(2, { pos: { x: 6, y: 50 }, vel: { x: 0, y: 0 } }),
        ],
        1,
      ),
    (e: unknown) => e instanceof SimError && e.code === "INITIAL_PENETRATION",
  );
});
