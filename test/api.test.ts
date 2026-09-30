import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createApp, listenLocal } from "../src/api/server.js";
import { tempDbPath } from "./helpers.js";

interface JsonRes {
  status: number;
  body: any;
}

async function request(
  base: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<JsonRes> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      base + path,
      {
        method,
        headers: {
          "content-type": "application/json",
          ...(data ? { "content-length": Buffer.byteLength(data) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : null });
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function startServer() {
  const dbPath = tempDbPath();
  const db = new DatabaseSync(dbPath);
  const app = createApp({ db });
  const { port, host } = await listenLocal(app, 0);
  const base = `http://${host}:${port}`;
  after(() => {
    app.close();
    db.close();
  });
  return base;
}

const sceneBody = () => ({
  name: `api-${Math.random().toString(36).slice(2)}`,
  container: { width: 30, height: 20 },
  disks: [
    { radius: 1, mass: 1, restitution: 1, pos: { x: 3, y: 5 }, vel: { x: 5, y: 0 } },
    { radius: 1, mass: 3, restitution: 0.5, pos: { x: 15, y: 5 }, vel: { x: -1, y: 0 } },
  ],
});

test("health and full lifecycle over HTTP with loopback bind", async () => {
  const base = await startServer();
  const h = await request(base, "GET", "/api/health");
  assert.equal(h.status, 200);
  assert.equal(h.body.ok, true);

  const created = await request(base, "POST", "/api/scenes", sceneBody());
  assert.equal(created.status, 201);
  const id = created.body.id;

  const run = await request(base, "POST", `/api/scenes/${id}/run`, { targetTime: 2 });
  assert.equal(run.status, 200);
  assert.ok(run.body.time === 2);

  const collisions = await request(base, "GET", `/api/scenes/${id}/collisions?limit=1&offset=0`);
  assert.equal(collisions.status, 200);
  assert.ok(collisions.body.total >= 1);
  assert.equal(collisions.body.items.length, 1);
  assert.equal(collisions.body.limit, 1);

  const stats = await request(base, "GET", `/api/scenes/${id}/stats`);
  assert.equal(stats.status, 200);
  assert.ok("momentum" in stats.body && "kineticEnergy" in stats.body && "wallImpulse" in stats.body);

  const traj = await request(base, "GET", `/api/scenes/${id}/trajectory`);
  assert.equal(traj.status, 200);
  assert.ok(traj.body.items.length === 2);
});

test("validation failures return explicit error codes", async () => {
  const base = await startServer();
  const bad = await request(base, "POST", "/api/scenes", {
    name: "bad",
    container: { width: 10, height: 10 },
    disks: [{ radius: 0, mass: 1, restitution: 1, pos: { x: 1, y: 1 }, vel: { x: 0, y: 0 } }],
  });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error.code, "NON_POSITIVE_RADIUS");

  const missing = await request(base, "POST", "/api/scenes", { name: "x" });
  assert.equal(missing.status, 422);
  assert.equal(missing.body.error.code, "BAD_CONTAINER");

  const notFound = await request(base, "GET", "/api/scenes/999999");
  assert.equal(notFound.status, 404);
  assert.equal(notFound.body.error.code, "NOT_FOUND");

  const badPage = await request(base, "GET", "/api/scenes?limit=0");
  assert.equal(badPage.status, 400);
  assert.equal(badPage.body.error.code, "VALIDATION");
});

test("pause then run conflicts, resume succeeds", async () => {
  const base = await startServer();
  const created = await request(base, "POST", "/api/scenes", sceneBody());
  const id = created.body.id;
  assert.equal((await request(base, "POST", `/api/scenes/${id}/pause`)).status, 200);
  const blocked = await request(base, "POST", `/api/scenes/${id}/run`, { targetTime: 1 });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, "CONFLICT");
  assert.equal((await request(base, "POST", `/api/scenes/${id}/resume`)).status, 200);
  const ok = await request(base, "POST", `/api/scenes/${id}/run`, { targetTime: 1 });
  assert.equal(ok.status, 200);
});

test("idempotency-key header makes repeated run a cached replay", async () => {
  const base = await startServer();
  const created = await request(base, "POST", "/api/scenes", sceneBody());
  const id = created.body.id;
  const r1 = await request(base, "POST", `/api/scenes/${id}/run`, { targetTime: 2 }, { "idempotency-key": "abc" });
  assert.equal(r1.body.reused, false);
  const r2 = await request(base, "POST", `/api/scenes/${id}/run`, { targetTime: 2 }, { "idempotency-key": "abc" });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.reused, true);
});

test("scene listing is paginated", async () => {
  const base = await startServer();
  for (let i = 0; i < 3; i++) await request(base, "POST", "/api/scenes", sceneBody());
  const page = await request(base, "GET", "/api/scenes?limit=2&offset=0");
  assert.equal(page.status, 200);
  assert.equal(page.body.items.length, 2);
  assert.ok(page.body.total >= 3);
});
