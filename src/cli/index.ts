#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { openDatabase } from "../db/migrate.js";
import { SceneRepository } from "../db/repo.js";
import { SimError } from "../physics/validate.js";
import { DEFAULT_TOLERANCE, type Disk } from "../physics/types.js";

interface CliOptions {
  db: string;
}

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else flags[key] = "true";
    } else positional.push(a);
  }
  return { positional, flags };
}

function fmtVel(v: { x: number; y: number }): string {
  return `(${v.x.toFixed(4)}, ${v.y.toFixed(4)})`;
}

function printScene(title: string, repo: SceneRepository, id: number): void {
  if (id < 0) {
    console.log(`\n=== ${title} ===`);
    return;
  }
  const s = repo.stats(id);
  const { disks } = repo.loadScene(id);
  console.log(`\n=== ${title} (scene ${id}) ===`);
  console.log(`time=${s.time.toFixed(6)} paused=${s.paused} version=${s.version}`);
  console.log(`momentum=${fmtVel(s.momentum)} KE=${s.kineticEnergy.toFixed(6)} wallImpulse=${fmtVel(s.wallImpulse)}`);
  if (s.stopReason) console.log(`stopReason=${s.stopReason}`);
  for (const d of disks) {
    console.log(
      `  disk ${d.id}: m=${d.mass} r=${d.radius} e=${d.restitution} ` +
        `pos=${fmtVel(d.pos)} vel=${fmtVel(d.vel)}`,
    );
  }
}

function help(): void {
  console.log(
    [
      "disk-sim - event-driven 2D disk collision simulator",
      "",
      "Usage:",
      "  disk-sim init-demo [--name NAME]",
      "  disk-sim list [--limit N] [--offset N]",
      "  disk-sim show <sceneId>",
      "  disk-sim run <sceneId> --time T [--tolerance-json JSON] [--idempotency-key K]",
      "  disk-sim pause <sceneId>",
      "  disk-sim resume <sceneId>",
      "  disk-sim collisions <sceneId> [--limit N] [--offset N]",
      "  disk-sim compare <sceneId> --time T --e E1,E2,...",
      "  disk-sim export <sceneId> [--out FILE] [--disk-no N]",
      "  disk-sim stats <sceneId>",
      "",
      "Options:",
      "  --db PATH   SQLite file (default ./data/disk-sim.sqlite)",
    ].join("\n"),
  );
}

function demoScene(name: string) {
  return {
    name,
    container: { width: 20, height: 10 },
    disks: [
      { radius: 1, mass: 1, restitution: 1, pos: { x: 3, y: 5 }, vel: { x: 2, y: 0 } },
      { radius: 1, mass: 1, restitution: 1, pos: { x: 8, y: 5 }, vel: { x: -1, y: 0 } },
      { radius: 1.5, mass: 4, restitution: 0.8, pos: { x: 14, y: 5 }, vel: { x: -0.5, y: 0 } },
    ],
  };
}

function main(): void {
  const { positional, flags } = parseFlags(process.argv.slice(2));
  const cmd = positional[0];
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    help();
    return;
  }

  const opts: CliOptions = { db: flags.db ?? resolve("data/disk-sim.sqlite") };
  mkdirSync(dirname(opts.db), { recursive: true });
  const db = openDatabase(opts.db);
  const repo = new SceneRepository(db);

  try {
    switch (cmd) {
      case "init-demo": {
        const input = demoScene(flags.name ?? "demo");
        printScene("before create", repo, -1);
        const r = repo.createScene(input);
        printScene(`created scene (reused=${r.reused})`, repo, r.id);
        console.log(`sceneId=${r.id}`);
        break;
      }
      case "list": {
        const limit = Number(flags.limit ?? 50);
        const offset = Number(flags.offset ?? 0);
        const { items, total } = repo.listScenes({ limit, offset });
        console.log(`scenes ${offset + 1}-${offset + items.length} of ${total}`);
        for (const r of items)
          console.log(`  #${r.id} ${r.name} t=${r.time.toFixed(3)} paused=${!!r.paused} v=${r.version}`);
        break;
      }
      case "show":
      case "stats": {
        printScene(cmd === "show" ? "state" : "stats", repo, Number(positional[1]));
        break;
      }
      case "run": {
        const id = Number(positional[1]);
        const t = Number(flags.time);
        printScene("before run", repo, id);
        const r = repo.run(id, t, {
          idempotencyKey: flags["idempotency-key"],
          toleranceOverride: flags["tolerance-json"] ? JSON.parse(flags["tolerance-json"]) : undefined,
        });
        printScene(`after run to ${t} (new collisions=${r.collisions.length}, reused=${r.reused})`, repo, id);
        if (r.stopReason) console.log(`STOPPED: ${r.stopReason}`);
        break;
      }
      case "pause": {
        const id = Number(positional[1]);
        printScene("before pause", repo, id);
        repo.setPaused(id, true);
        printScene("after pause", repo, id);
        break;
      }
      case "resume": {
        const id = Number(positional[1]);
        printScene("before resume", repo, id);
        repo.setPaused(id, false);
        printScene("after resume", repo, id);
        break;
      }
      case "collisions": {
        const id = Number(positional[1]);
        const limit = Number(flags.limit ?? 50);
        const offset = Number(flags.offset ?? 0);
        const { items, total } = repo.listCollisions(id, { limit, offset });
        console.log(`collisions ${offset + 1}-${offset + items.length} of ${total}`);
        for (const c of items) {
          console.log(
            `  #${c.id} t=${c.time.toFixed(6)} ${c.kind} disks=[${c.disks.join(",")}] ` +
              `${c.wall ? "wall=" + c.wall + " " : ""}|J|=${c.impulseMagnitude.toFixed(6)} ` +
              `sim=${c.simultaneous} iters=${c.iterations} converged=${c.converged}`,
          );
          for (const im of c.impulses) {
            console.log(
              `      ${im.kind}[${(im.disks as number[]).join(",")}] vBefore=${im.velBefore
                .map(fmtVel)
                .join(" ")} vAfter=${im.velAfter.map(fmtVel).join(" ")} J=${fmtVel(im.impulseOnFirst)}`,
            );
          }
        }
        break;
      }
      case "compare": {
        const id = Number(positional[1]);
        const t = Number(flags.time);
        const es = String(flags.e ?? "")
          .split(",")
          .map(Number)
          .filter((n) => Number.isFinite(n));
        const base = repo.loadScene(id);
        for (const e of es) {
          const clone = {
            name: `compare-e${e}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            container: base.container,
            disks: base.disks.map((d: Disk) => ({
                           radius: d.radius,
              mass: d.mass,
              restitution: e,
              pos: { ...d.pos },
              vel: { ...d.vel },
            })),
          };
          const created = repo.createScene(clone);
          repo.run(created.id, t);
          const st = repo.stats(created.id);
          console.log(
            `e=${e}: KE=${st.kineticEnergy.toFixed(6)} momentum=${fmtVel(st.momentum)} wallImpulse=${fmtVel(st.wallImpulse)}`,
          );
        }
        break;
      }
      case "export": {
        const id = Number(positional[1]);
        const diskNo = flags["disk-no"] !== undefined ? Number(flags["disk-no"]) : undefined;
        const data = {
          exportedAt: new Date().toISOString(),
          tolerance: DEFAULT_TOLERANCE,
          trajectory: repo.trajectory(id, diskNo),
        };
        const json = JSON.stringify(data, null, 2);
        if (flags.out) {
          const out = resolve(flags.out);
          mkdirSync(dirname(out), { recursive: true });
          writeFileSync(out, json);
          console.log(`exported ${data.trajectory.reduce((n, d) => n + d.points.length, 0)} points to ${out}`);
        } else console.log(json);
        break;
      }
      default:
        console.error(`unknown command: ${cmd}`);
        help();
        process.exitCode = 2;
    }
  } catch (err) {
    if (err instanceof SimError) {
      console.error(`ERROR [${err.code}] ${err.message}`);
      if (err.details) console.error(JSON.stringify(err.details));
      process.exitCode = 1;
    } else {
      throw err;
    }
  } finally {
    db.close();
  }
}

main();
