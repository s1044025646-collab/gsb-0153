#!/usr/bin/env node
import { openDb } from "./db.js";
import { SimService } from "./service.js";
import { FICTIONAL_SCENES, listPresets } from "./scenes.js";
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { SimError } from "./types.js";

const args = process.argv.slice(2);
const cmd = args[0] ?? "help";

const dbPath = process.env["DISK_SIM_DB"] ?? resolve("data/disk-sim.db");

function withDb<T>(fn: (svc: SimService, db: DatabaseSync) => T): T {
  const db = openDb(dbPath);
  const svc = new SimService(db);
  try {
    return fn(svc, db);
  } finally {
    db.close();
  }
}

function fmt(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(4);
}

function printStatus(label: string, s: ReturnType<SimService["getStatus"]>): void {
  console.log(`\n== ${label} | t=${fmt(s.t)} events=${s.eventSeq} ==`);
  for (const d of s.disks) {
    console.log(
      `  disk ${d.id}: pos=(${fmt(d.x)}, ${fmt(d.y)}) vel=(${fmt(d.vx)}, ${fmt(d.vy)})`,
    );
  }
  console.log(
    `  momentum=(${fmt(s.momentum.x)}, ${fmt(s.momentum.y)}) KE=${fmt(s.kineticEnergy)}`,
  );
  console.log(
    `  wall external impulse on disks=(${fmt(s.wallImpulse.x)}, ${fmt(s.wallImpulse.y)}) over ${s.wallImpulseCount} wall hit(s)`,
  );
  if (s.stoppedReason) console.log(`  STOPPED: ${s.stoppedReason}`);
}

function printEvent(e: {
  seq: number;
  kind: string;
  t: number;
  a: number;
  b: number;
  nx: number;
  ny: number;
  impulse: number;
  iterations: number;
  converged: boolean;
  vaxBefore: number;
  vayBefore: number;
  vbxBefore: number;
  vbyBefore: number;
  vaxAfter: number;
  vayAfter: number;
  vbxAfter: number;
  vbyAfter: number;
}): void {
  const who = e.kind === "disk-disk" ? `disks ${e.a} & ${e.b}` : `disk ${e.a} -> wall ${e.b}`;
  console.log(`\n#${e.seq} t=${fmt(e.t)} [${e.kind}] ${who}`);
  console.log(`  normal=(${fmt(e.nx)}, ${fmt(e.ny)}) impulse j=${fmt(e.impulse)}`);
  console.log(
    `  A vel before=(${fmt(e.vaxBefore)}, ${fmt(e.vayBefore)}) after=(${fmt(e.vaxAfter)}, ${fmt(e.vayAfter)})`,
  );
  if (e.kind === "disk-disk") {
    console.log(
      `  B vel before=(${fmt(e.vbxBefore)}, ${fmt(e.vbyBefore)}) after=(${fmt(e.vbxAfter)}, ${fmt(e.vbyAfter)})`,
    );
  }
  console.log(`  solver iterations=${e.iterations} converged=${e.converged}`);
}

function parseSceneFile(path: string) {
  return JSON.parse(readFileSync(path, "utf8")) as Parameters<SimService["createScene"]>[1] & {
    name?: string;
  };
}

try {
  switch (cmd) {
    case "help":
    case "--help":
    case "-h": {
      console.log(`diskcli - 2D disk collision simulator

Usage:
  diskcli init [preset] --name NAME [--file scene.json]
      presets: ${listPresets().join(", ")}
  diskcli run ID --duration T [--key IDEMPOTENCY-KEY]
  diskcli events ID [--page N] [--page-size N]
  diskcli event ID SEQ
  diskcli status ID
  diskcli compare ID --restitution E --name NEWNAME --duration T
  diskcli trajectory ID [--out file.csv]
  diskcli list
  diskcli demo
  diskcli serve [--port P]
  diskcli stop
`);
      break;
    }

    case "init": {
      const preset = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
      const name = opt(args, "--name") ?? `scene-${Date.now()}`;
      const file = opt(args, "--file");
      const spec = file
        ? parseSceneFile(file)
        : preset && FICTIONAL_SCENES[preset]
          ? FICTIONAL_SCENES[preset]!()
          : FICTIONAL_SCENES["headon"]!();
      withDb((svc) => {
        const created = svc.createScene(name, spec);
        console.log(`created scene '${name}' id=${created.id} (${spec.disks.length} disks)`);
        printStatus("initial", svc.getStatus(created.id));
      });
      break;
    }

    case "run": {
      const id = Number(args[1]);
      const duration = Number(opt(args, "--duration") ?? fail("--duration required"));
      const key = opt(args, "--key");
      withDb((svc) => {
        const before = svc.getStatus(id);
        printStatus("before run", before);
        const r = svc.run(id, duration, key);
        console.log(`\nadvanced ${fmt(duration)}s, ${r.newEvents} new collision event(s)` +
          (r.reused ? " (idempotent replay, state unchanged)" : ""));
        printStatus("after run", r.after);
        for (const e of r.events) printEvent(e);
      });
      break;
    }

    case "events": {
      const id = Number(args[1]);
      const page = Number(opt(args, "--page") ?? "1");
      const pageSize = Number(opt(args, "--page-size") ?? "20");
      withDb((svc) => {
        const r = svc.listEvents(id, page, pageSize);
        console.log(`events page ${r.page}/${r.totalPages} (total ${r.total})`);
        for (const e of r.items) printEvent(e);
      });
      break;
    }

    case "event": {
      withDb((svc) => printEvent(svc.getEvent(Number(args[1]), Number(args[2]))));
      break;
    }

    case "status": {
      withDb((svc) => printStatus("status", svc.getStatus(Number(args[1]))));
      break;
    }

    case "list": {
      withDb((svc) => {
        const r = svc.listScenes(1, 100);
        for (const s of r.items) {
          console.log(`#${s.id} '${s.name}' e=${s.restitution} created=${s.created_at}`);
        }
      });
      break;
    }

    case "compare": {
      const id = Number(args[1]);
      const e = Number(opt(args, "--restitution") ?? fail("--restitution required"));
      const newName = opt(args, "--name") ?? fail("--name required");
      const duration = Number(opt(args, "--duration") ?? "10");
      withDb((svc) => {
        const cloneId = svc.cloneWithRestitution(id, newName, e);
        svc.run(cloneId, duration);
        const a = svc.getStatus(id);
        const b = svc.getStatus(cloneId);
        console.log("restitution comparison after same duration:");
        printStatus(`original scene #${id}`, a);
        printStatus(`clone #${cloneId} e=${e}`, b);
      });
      break;
    }

    case "trajectory": {
      const id = Number(args[1]);
      const out = opt(args, "--out");
      withDb((svc) => {
        const rows = svc.exportTrajectory(id);
        const csv = ["t,disk,x,y,vx,vy", ...rows.map((r) =>
          `${r.t},${r.disk_id},${r.x},${r.y},${r.vx},${r.vy}`)]
          .join("\n");
        if (out) {
          writeFileSync(out, csv);
          console.log(`wrote ${rows.length} samples to ${out}`);
        } else {
          console.log(csv);
        }
      });
      break;
    }

    case "demo": {
      runDemo();
      break;
    }

    case "serve": {
      const port = Number(opt(args, "--port") ?? process.env["DISK_SIM_PORT"] ?? "0");
      const child = spawn(
        process.execPath,
        [fileUrlToPath(new URL("./server.js", import.meta.url).href)],
        {
          stdio: "inherit",
          env: { ...process.env, DISK_SIM_PORT: String(port) },
          detached: true,
        },
      );
      child.unref();
      console.log(`server starting (pid ${child.pid})`);
      break;
    }

    case "stop": {
      stopServer();
      break;
    }

    default:
      console.error(`unknown command: ${cmd} (try 'diskcli help')`);
      process.exitCode = 2;
  }
} catch (err) {
  if (err instanceof SimError) {
    console.error(`error [${err.code}]: ${err.message}`);
    if (err.details) console.error(JSON.stringify(err.details));
    process.exitCode = 1;
  } else {
    throw err;
  }
}

function opt(a: string[], key: string): string | undefined {
  const i = a.indexOf(key);
  return i >= 0 ? a[i + 1] : undefined;
}
function fail(m: string): never {
  throw new SimError("BAD_CLI_ARGS", m);
}

function fileUrlToPath(u: string): string {
  return process.platform === "win32"
    ? decodeURIComponent(u.replace(/^file:\/\/\//, "").replace(/\//g, "\\"))
    : u.replace(/^file:\/\//, "");
}

function stopServer(): void {
  const infoPath = resolve("data/server.json");
  if (!existsSync(infoPath)) {
    console.log("no server info file found; nothing to stop");
    return;
  }
  const info = JSON.parse(readFileSync(infoPath, "utf8")) as { pid: number };
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(info.pid), "/T", "/F"], { stdio: "inherit" });
  } else {
    spawnSync("kill", [String(info.pid)], { stdio: "inherit" });
  }
  console.log(`stopped pid ${info.pid}`);
}

/** Deterministic end-to-end demo using its own database file under data/. */
function runDemo(): void {
  process.env["DISK_SIM_DB"] = resolve("data/demo.db");
  const db = openDb(process.env["DISK_SIM_DB"]!);
  const svc = new SimService(db);
  try {
    const name = "demo-headon";
    const existing = svc.repo.findSceneByName(name);
    const id = existing
      ? existing.id
      : svc.createScene(name, FICTIONAL_SCENES["headon"]!()).id;
    console.log(`--- repeatable demo on scene #${id} '${name}' ---`);
    printStatus("start", svc.getStatus(id));
    const r1 = svc.run(id, 2.0, "demo-run-1");
    console.log(`\nrun 2.0s -> ${r1.newEvents} event(s)` +
      (r1.reused ? " [idempotent]" : ""));
    const firstEvents = svc.listEvents(id, 1, 10).items;
    for (const e of firstEvents) printEvent(e);
    printStatus("after first run", r1.after);
    const r2 = svc.run(id, 3.0, "demo-run-2");
    console.log(`\nrun another 3.0s -> ${r2.newEvents} event(s)`);
    printStatus("after second run", r2.after);
    // Idempotency: re-running with the SAME key on a fresh service instance
    // returns the stored response; to show no double-advance, open second view.
    const svc2 = new SimService(db);
    const beforeReplay = svc2.getStatus(id).t;
    const replayed = svc2.run(id, 2.0, "demo-run-1");
    const afterReplay = svc2.getStatus(id).t;
    console.log(
      `\nidempotent replay: t before=${fmt(beforeReplay)} after=${fmt(afterReplay)} reused=${replayed.reused}`,
    );
  } finally {
    db.close();
  }
}
