/**
 * Repeatable end-to-end demo driven entirely through the SQLite repository.
 * It uses a project-local database under ./data and prints before/after state,
 * analytic checks, wall-impulse accounting and a restitution comparison.
 */
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { openDatabase } from "../src/db/migrate.js";
import { SceneRepository } from "../src/db/repo.js";
import { kineticEnergy, totalMomentum } from "../src/physics/stats.js";

function approx(a: number, b: number, eps = 1e-7): boolean {
  return Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
}

function line(): void {
  console.log("-".repeat(72));
}

function main(): void {
  const dbPath = resolve("data/demo.sqlite");
  mkdirSync(dirname(dbPath), { recursive: true });
  rmSync(dbPath, { force: true });
  const db = openDatabase(dbPath);
  const repo = new SceneRepository(db);

  line();
  console.log("1) Create a deterministic fictitious scene (no gravity, smooth disks)");
  const created = repo.createScene({
    name: "demo",
    container: { width: 20, height: 10 },
    disks: [
      { radius: 1, mass: 1, restitution: 1, pos: { x: 2, y: 5 }, vel: { x: 3, y: 0 } },
      { radius: 1, mass: 1, restitution: 1, pos: { x: 6, y: 5 }, vel: { x: 0, y: 0 } },
      { radius: 1, mass: 2, restitution: 0.5, pos: { x: 17, y: 2 }, vel: { x: -1, y: 0 } },
    ],
  });
  const id = created.id;
  let st = repo.stats(id);
  console.log(`initial: t=${st.time} p=(${st.momentum.x},${st.momentum.y}) KE=${st.kineticEnergy}`);

  line();
  console.log("2) Run to t=2 (event-driven; exact contact times, no tunnelling)");
  const run = repo.run(id, 2);
  st = repo.stats(id);
  console.log(`final:   t=${st.time} p=(${st.momentum.x.toFixed(4)},${st.momentum.y.toFixed(4)}) KE=${st.kineticEnergy.toFixed(6)}`);
  console.log(`collisions this run: ${run.collisions.length}, stopReason=${run.stopReason ?? "none"}`);

  line();
  console.log("3) Collision records with before/after velocities and impulse");
  const { items } = repo.listCollisions(id, { limit: 100, offset: 0 });
  for (const c of items) {
    console.log(
      `#${c.id} t=${c.time.toFixed(6)} ${c.kind}${c.wall ? ":" + c.wall : ""} disks=[${c.disks}] ` +
        `|J|=${c.impulseMagnitude.toFixed(6)} simultaneous=${c.simultaneous} iters=${c.iterations} converged=${c.converged}`,
    );
    for (const im of c.impulses)
      console.log(`     before=${JSON.stringify(im.velBefore)} after=${JSON.stringify(im.velAfter)} J=${JSON.stringify(im.impulseOnFirst)}`);
  }

  line();
  console.log("4) Analytic check: equal-mass head-on elastic pair exchanges velocity");
  const analytic = repo.createScene({
    name: "analytic",
    container: { width: 100, height: 20 },
    disks: [
      { radius: 1, mass: 1, restitution: 1, pos: { x: 2, y: 10 }, vel: { x: 2, y: 0 } },
      { radius: 1, mass: 1, restitution: 1, pos: { x: 6, y: 10 }, vel: { x: 0, y: 0 } },
    ],
  });
  repo.run(analytic.id, 2);
  const dd = repo.loadScene(analytic.id).disks;
  console.log(`disk1.vx=${dd[0].vel.x} (expect 0), disk2.vx=${dd[1].vel.x} (expect 2)`);
  if (!approx(dd[0].vel.x, 0) || !approx(dd[1].vel.x, 2)) throw new Error("analytic check failed");

  line();
  console.log("5) Wall impulse bookkeeping (wall momentum is not a conservation failure)");
  const wall = repo.createScene({
    name: "wall",
    container: { width: 100, height: 100 },
    disks: [{ radius: 1, mass: 2, restitution: 1, pos: { x: 5, y: 50 }, vel: { x: 10, y: 0 } }],
  });
  repo.run(wall.id, 10);
  const ws = repo.stats(wall.id);
  console.log(`disk p.x=${ws.momentum.x} wallImpulse.x=${ws.wallImpulse.x} (expect -20 and +40)`);
  if (!approx(ws.momentum.x, -20) || !approx(ws.wallImpulse.x, 40)) throw new Error("wall impulse check failed");

  line();
  console.log("6) Compare restitution coefficients on an identical setup");
  for (const e of [0, 0.5, 1]) {
    const s = repo.createScene({
      name: `cmp-${e}`,
      container: { width: 100, height: 20 },
      disks: [
        { radius: 1, mass: 1, restitution: e, pos: { x: 2, y: 10 }, vel: { x: 3, y: 0 } },
        { radius: 1, mass: 2, restitution: e, pos: { x: 8, y: 10 }, vel: { x: 0, y: 0 } },
      ],
    });
    repo.run(s.id, 3);
    const cs = repo.stats(s.id);
    console.log(`e=${e}: KE=${cs.kineticEnergy.toFixed(6)} p.x=${cs.momentum.x.toFixed(4)}`);
  }

  line();
  console.log("7) Pause / resume and deterministic continuation");
  repo.setPaused(id, true);
  let blocked = false;
  try {
    repo.run(id, 3);
  } catch {
    blocked = true;
  }
  console.log(`run while paused rejected: ${blocked}`);
  repo.setPaused(id, false);
  repo.run(id, 3);
  const final = repo.stats(id);
  console.log(`resumed to t=${final.time}, KE=${final.kineticEnergy.toFixed(6)}`);

  line();
  console.log("8) Export trajectory points (project-local)");
  const traj = repo.trajectory(id);
  console.log(`disks tracked=${traj.length}, total samples=${traj.reduce((n, d) => n + d.points.length, 0)}`);
  console.log(`database left at: ${dbPath}`);
  db.close();
}

main();
