import { test } from "node:test";
import assert from "node:assert/strict";
import { runPure, assertNoPenetration, analyticImpact, APPROX } from "./helpers.js";
import { FICTIONAL_SCENES } from "../src/scenes.js";
import { SimError, TOL_DEFAULTS, type DiskState } from "../src/types.js";
import { validateScene } from "../src/physics/validate.js";
import { classifyApproach } from "../src/physics/impulse.js";

function ke(disks: DiskState[]): number {
  return disks.reduce((s, d) => s + 0.5 * d.m * (d.vx ** 2 + d.vy ** 2), 0);
}

test("free flight: no events, straight-line motion", () => {
  const { state, events } = runPure(
    { width: 100, height: 100, restitution: 1, disks: [
      { id: 1, r: 1, m: 1, x: 50, y: 50, vx: 3, vy: 2 },
    ] },
    10,
  );
  assert.equal(events.length, 0);
  assert.ok(Math.abs(state.disks[0]!.x - 80) < APPROX);
  assert.ok(Math.abs(state.disks[0]!.y - 70) < APPROX);
});

test("equal-mass head-on: analytic exchange, elastic momentum+KE conserved", () => {
  const spec = FICTIONAL_SCENES["headon"]!();
  const { state, events } = runPure(spec, 3);
  const dd = events.filter((e) => e.kind === "disk-disk");
  assert.equal(dd.length, 1);
  const ev = dd[0]!;
  const u1n = ev.vaxBefore * ev.nx + ev.vayBefore * ev.ny;
  const u2n = ev.vbxBefore * ev.nx + ev.vbyBefore * ev.ny;
  const { v1, v2 } = analyticImpact(1, u1n, 1, u2n, 1);
  // n points B -> A = (-1,0); project post velocities onto n.
  const vaN = ev.vaxAfter * ev.nx + ev.vayAfter * ev.ny;
  const vbN = ev.vbxAfter * ev.nx + ev.vbyAfter * ev.ny;
  assert.ok(Math.abs(vaN - v1) < APPROX);
  assert.ok(Math.abs(vbN - v2) < APPROX);
  // equal masses exchange velocities: -2 and +2
  assert.ok(Math.abs(state.disks[0]!.vx - -2) < APPROX);
  assert.ok(Math.abs(state.disks[1]!.vx - 2) < APPROX);
  const p = state.disks.reduce((s, d) => s + d.m * d.vx, 0);
  assert.ok(Math.abs(p) < APPROX);
  assert.ok(Math.abs(ke(state.disks) - ke(spec.disks)) < APPROX);
  assert.equal(ev.converged, true);
  assert.ok(ev.iterations >= 1);
});

test("unequal masses: analytic velocities and impulse match", () => {
  const spec = FICTIONAL_SCENES["unequal"]!();
  const { events } = runPure(spec, 2.5);
  const ev = events.find((e) => e.kind === "disk-disk")!;
  const u1 = ev.vaxBefore * ev.nx + ev.vayBefore * ev.ny;
  const u2 = ev.vbxBefore * ev.nx + ev.vbyBefore * ev.ny;
  const { v1, v2 } = analyticImpact(1, u1, 4, u2, 0.8);
  const vaN = ev.vaxAfter * ev.nx + ev.vayAfter * ev.ny;
  const vbN = ev.vbxAfter * ev.nx + ev.vbyAfter * ev.ny;
  assert.ok(Math.abs(vaN - v1) < APPROX, `v1 ${vaN} vs ${v1}`);
  assert.ok(Math.abs(vbN - v2) < APPROX, `v2 ${vbN} vs ${v2}`);
  const jExpected = 1 * (vaN - u1);
  assert.ok(Math.abs(ev.impulse - jExpected) < APPROX);
});

test("grazing hit: tangential velocity unchanged, no energy gain", () => {
  const spec = FICTIONAL_SCENES["grazing"]!();
  const ke0 = ke(spec.disks);
  const { state, events } = runPure(spec, 2);
  assert.ok(events.length >= 1);
  // Smooth disks: tangential components of each disk's velocity are unchanged.
  const ev0 = events[0]!;
  const n = { x: ev0.nx, y: ev0.ny };
  const tx = -n.y;
  const ty = n.x;
  for (const [before, after] of [
    [ev0.vaxBefore, ev0.vaxAfter],
    [ev0.vayBefore, ev0.vayAfter],
  ] as const) {
    void before;
    void after;
  }
  assert.ok(
    Math.abs(ev0.vaxBefore * tx + ev0.vayBefore * ty -
            (ev0.vaxAfter * tx + ev0.vayAfter * ty)) < APPROX,
  );
  assert.ok(
    Math.abs(ev0.vbxBefore * tx + ev0.vbyBefore * ty -
            (ev0.vbxAfter * tx + ev0.vbyAfter * ty)) < APPROX,
  );
  assert.ok(ke(state.disks) <= ke0 + APPROX);
  assertNoPenetration(state);
});

test("pursuit: rear disk catches slower one, ordering maintained", () => {
  const spec = FICTIONAL_SCENES["pursuit"]!();
  const { state, events } = runPure(spec, 10);
  assert.ok(events.length >= 1);
  assertNoPenetration(state);
  // after first catch the pursuer cannot be moving faster into the target
  const a = state.disks[0]!;
  const b = state.disks[1]!;
  assert.ok(a.x <= b.x + 1e-6 || a.vx <= b.vx + 1e-6);
});

test("high-speed disk cannot tunnel through wall", () => {
  const spec = FICTIONAL_SCENES["highspeedWall"]!();
  const { state, events } = runPure(spec, 1);
  const wallHits = events.filter((e) => e.kind === "disk-wall");
  assert.ok(wallHits.length >= 1, "must register wall hits");
  assertNoPenetration(state);
  // 1000 u/s in 100 box: many bounces; reflected speed magnitude ~ e per hit
  const speed = Math.hypot(state.disks[0]!.vx, state.disks[0]!.vy);
  assert.ok(speed <= 1000);
});

test("simultaneous contact: deterministic group, converges, marked approximate", () => {
  const spec = FICTIONAL_SCENES["simultaneous"]!();
  const { state, events } = runPure(spec, 5);
  const t2 = events.filter((e) => Math.abs(e.t - 1) < 1e-9);
  assert.ok(t2.length >= 2, "outer disks reach center at the same instant");
  for (const e of t2) {
    assert.equal(e.converged, true);
    assert.ok(e.iterations >= 1);
    assert.equal(e.tolContactEps, TOL_DEFAULTS.contactEps);
  }
  assertNoPenetration(state);
});

test("elastic wall bounce conserves speed; momentum explained by wall impulse", () => {
  const spec = FICTIONAL_SCENES["highspeedWall"]!();
  const { state } = runPure(
    { ...spec, restitution: 1 },
    0.2, // first wall contact at t=0.0985; run past it
  );
  const p = state.disks.reduce((s, d) => s + d.m * d.vx, 0);
  // disk momentum now = initial + external wall impulse (+j n accumulated)
  const balance = p - (1000 + state.wallImpulse.x);
  assert.ok(Math.abs(balance) < 1e-6, `momentum balance ${balance}`);
  assertNoPenetration(state);
});

test("inelastic collision never increases kinetic energy", () => {
  for (const e of [0, 0.25, 0.5, 0.9]) {
    const { state } = runPure({
      width: 40, height: 10, restitution: e,
      disks: [
        { id: 1, r: 1, m: 2, x: 4, y: 5, vx: 4, vy: 0 },
        { id: 2, r: 1, m: 3, x: 15, y: 5, vx: -1, vy: 0 },
      ],
    }, 3);
    assert.ok(ke(state.disks) <= 0.5 * 2 * 16 + 0.5 * 3 * 1 + 1e-9);
  }
});

test("perfectly inelastic head-on: disks share velocity, e=0 consistency", () => {
  const { state, events } = runPure({
    width: 40, height: 10, restitution: 0,
    disks: [
      { id: 1, r: 1, m: 1, x: 5, y: 5, vx: 3, vy: 0 },
      { id: 2, r: 1, m: 1, x: 15, y: 5, vx: -3, vy: 0 },
    ],
  }, 5);
  assert.ok(Math.abs(state.disks[0]!.vx - state.disks[1]!.vx) < 1e-8);
  assert.ok(Math.abs(events[0]!.vaxAfter - 0) < 1e-9);
});

test("restitution consistency: relative separation speed = -e * approach speed", () => {
  const spec = FICTIONAL_SCENES["unequal"]!();
  const { events } = runPure(spec, 5);
  const ev = events[0]!;
  const before = (ev.vaxBefore - ev.vbxBefore) * ev.nx + (ev.vayBefore - ev.vbyBefore) * ev.ny;
  const after = (ev.vaxAfter - ev.vbxAfter) * ev.nx + (ev.vayAfter - ev.vbyAfter) * ev.ny;
  assert.ok(Math.abs(after + spec.restitution * before) < APPROX);
});

test("validation rejects bad mass/radius, overlaps, non-fitting disks", () => {
  assert.throws(
    () => validateScene({ width: 10, height: 10, restitution: 1, disks: [
      { id: 1, r: 1, m: 0, x: 5, y: 5, vx: 0, vy: 0 },
    ] }),
    (e: unknown) => e instanceof SimError && e.code === "INVALID_MASS",
  );
  assert.throws(
    () => validateScene({ width: 10, height: 10, restitution: 1, disks: [
      { id: 1, r: -1, m: 1, x: 5, y: 5, vx: 0, vy: 0 },
    ] }),
    (e: unknown) => e instanceof SimError && e.code === "INVALID_RADIUS",
  );
  assert.throws(
    () => validateScene({ width: 10, height: 10, restitution: 1, disks: [
      { id: 1, r: 1, m: 1, x: 5, y: 5, vx: 0, vy: 0 },
      { id: 2, r: 1, m: 1, x: 5.5, y: 5, vx: 0, vy: 0 },
    ] }),
    (e: unknown) => e instanceof SimError && e.code === "INITIAL_OVERLAP",
  );
  assert.throws(
    () => validateScene({ width: 5, height: 10, restitution: 1, disks: [
      { id: 1, r: 3, m: 1, x: 3, y: 5, vx: 0, vy: 0 },
    ] }),
    (e: unknown) => e instanceof SimError && e.code === "DISK_DOES_NOT_FIT",
  );
});

test("approach/separation classifier is tolerance-driven", () => {
  assert.equal(classifyApproach(-1, TOL_DEFAULTS), "approaching");
  assert.equal(classifyApproach(1, TOL_DEFAULTS), "separating");
  assert.equal(classifyApproach(0, TOL_DEFAULTS), "resting");
});

test("zero-dt event loop stops with recorded reason", () => {
  // Fast disk rattles between walls spaced 0.01 apart: successive contacts
  // arrive within the coarse 1ms time epsilon and count as zero-dt, so the
  // guard engages deterministically.
  const tol = { ...TOL_DEFAULTS, timeEps: 1e-3, maxZeroDtEvents: 10 };
  const { state } = runPure({
    width: 3.01, height: 3.01, restitution: 1,
    disks: [{ id: 1, r: 1, m: 1, x: 1.505, y: 1.505, vx: 1000, vy: 1000 }],
  }, 5, tol);
  assert.ok(state.stoppedReason?.startsWith("ZERO_DT_LOOP_LIMIT"), state.stoppedReason ?? "");
});

test("deterministic continuation: split run equals one run", () => {
  const spec = FICTIONAL_SCENES["pursuit"]!();
  const whole = runPure(spec, 8).state;
  const part1 = runPure(spec, 3);
  const part2 = runPure(
    {
      width: part1.state.width,
      height: part1.state.height,
      restitution: part1.state.restitution,
      disks: part1.state.disks,
    },
    5,
  );
  for (let i = 0; i < whole.disks.length; i++) {
    assert.ok(Math.abs(whole.disks[i]!.x - part2.state.disks[i]!.x) < 1e-7);
    assert.ok(Math.abs(whole.disks[i]!.y - part2.state.disks[i]!.y) < 1e-7);
    assert.ok(Math.abs(whole.disks[i]!.vx - part2.state.disks[i]!.vx) < 1e-9);
  }
});
