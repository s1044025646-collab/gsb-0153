import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tempDb, trackDb } from "./helpers.js";
import { openDb } from "../src/db.js";
import { SimService } from "../src/service.js";
import { createApiServer, listenLocal } from "../src/api.js";
import { FICTIONAL_SCENES } from "../src/scenes.js";
import type { Server } from "node:http";

let server: Server;
let base: string;
let dbPath: string;
let cleanup: () => void;

before(async () => {
  const tmp = tempDb();
  cleanup = tmp.close;
  dbPath = tmp.path;
  const svc = new SimService(openDb(dbPath));
  trackDb(dbPath, () => svc.db.close());
  server = createApiServer(svc);
  const port = await listenLocal(server, 0);
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  cleanup();
});

async function jsonRequest(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

test("health", async () => {
  const { status, json } = await jsonRequest("GET", "/health");
  assert.equal(status, 200);
  assert.equal(json.status, "ok");
});

test("create scene validation error code", async () => {
  const { status, json } = await jsonRequest("POST", "/scenes", {
    name: "bad",
    width: -1,
    height: 10,
    restitution: 1,
    disks: [{ id: 1, r: 1, m: 1, x: 5, y: 5, vx: 0, vy: 0 }],
  });
  assert.equal(status, 400);
  assert.equal(json.error.code, "INVALID_CONTAINER");
});

test("full lifecycle via HTTP with idempotent create", async () => {
  const payload = { name: "api1", ...FICTIONAL_SCENES["headon"]!() };
  const first = await jsonRequest("POST", "/scenes", payload, {
    "idempotency-key": "http-1",
  });
  assert.equal(first.status, 201);
  const replay = await jsonRequest("POST", "/scenes", payload, {
    "idempotency-key": "http-1",
  });
  assert.equal(replay.json.id, first.json.id);
  assert.equal(replay.json.reused, true);

  const id = first.json.id;
  const run = await jsonRequest("POST", `/scenes/${id}/run`, { duration: 2.5 }, {
    "idempotency-key": "run-1",
  });
  assert.equal(run.status, 200);
  assert.ok(run.json.newEvents >= 1);
  const runAgain = await jsonRequest("POST", `/scenes/${id}/run`, { duration: 2.5 }, {
    "idempotency-key": "run-1",
  });
  assert.equal(runAgain.json.reused, true);

  const events = await jsonRequest("GET", `/scenes/${id}/events?page=1&pageSize=1`);
  assert.equal(events.json.pageSize, 1);
  assert.ok(events.json.total >= 1);

  const traj = await jsonRequest("GET", `/scenes/${id}/trajectory`);
  assert.ok(Array.isArray(traj.json.items));

  const status = await jsonRequest("GET", `/scenes/${id}`);
  assert.equal(status.status, 200);
  assert.ok(typeof status.json.kineticEnergy === "number");
});

test("404 for unknown scene and unknown route", async () => {
  const a = await jsonRequest("GET", "/scenes/99999");
  assert.equal(a.status, 404);
  const b = await jsonRequest("GET", "/nope");
  assert.equal(b.status, 404);
  assert.equal(b.json.error.code, "NO_ROUTE");
});

test("invalid JSON rejected with explicit code", async () => {
  const res = await fetch(base + "/scenes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  const json = await res.json();
  assert.equal(res.status, 400);
  assert.equal(json.error.code, "INVALID_JSON");
});

test("persistence across a fresh process-open of the same database file", async () => {
  const svc2 = new SimService(openDb(dbPath));
  trackDb(dbPath, () => svc2.db.close());
  const list = svc2.listScenes(1, 10);
  assert.ok(list.items.some((s) => s.name === "api1"));
});
