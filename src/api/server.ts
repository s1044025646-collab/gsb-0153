import http from "node:http";
import { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { SceneRepository } from "../db/repo.js";
import { applyMigrations } from "../db/migrate.js";
import { SimError } from "../physics/validate.js";
import { parsePage } from "./pagination.js";

const HTTP_STATUS: Record<string, number> = {
  VALIDATION: 400,
  BAD_REQUEST: 400,
  NON_POSITIVE_MASS: 422,
  NON_POSITIVE_RADIUS: 422,
  BAD_RESTITUTION: 422,
  BAD_CONTAINER: 422,
  INITIAL_PENETRATION: 422,
  DISK_DOES_NOT_FIT: 422,
  EVENT_LOOP_LIMIT: 409,
  NOT_FOUND: 404,
  CONFLICT: 409,
};

export interface AppDeps {
  db: DatabaseSync;
  clock?: () => number;
}

export function createApp(deps: AppDeps) {
  applyMigrations(deps.db);
  const repo = new SceneRepository(deps.db, deps.clock);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const method = req.method ?? "GET";
      const idem = req.headers["idempotency-key"];
      const idemKey = Array.isArray(idem) ? idem[0] : idem;

      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };

      const readBody = async (): Promise<any> => {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw) return {};
        try {
          return JSON.parse(raw);
        } catch {
          throw new SimError("BAD_REQUEST", "request body must be valid JSON");
        }
      };

      const sceneMatch = url.pathname.match(/^\/api\/scenes(?:\/(\d+))?$/);

      if (method === "GET" && url.pathname === "/api/health") {
        return send(200, { ok: true });
      }

      if (method === "POST" && url.pathname === "/api/scenes") {
        const body = await readBody();
        const r = repo.createScene({ ...body, idempotencyKey: body.idempotencyKey ?? idemKey ?? undefined });
        return send(r.reused ? 200 : 201, r);
      }

      if (method === "GET" && sceneMatch && !sceneMatch[1]) {
        const page = parsePage(url);
        const { items, total } = repo.listScenes(page);
        return send(200, {
          items: items.map((r) => ({
            id: r.id,
            name: r.name,
            width: r.width,
            height: r.height,
            time: r.time,
            paused: !!r.paused,
            version: r.version,
            stopReason: r.stop_reason,
          })),
          total,
          limit: page.limit,
          offset: page.offset,
        });
      }

      const sub = url.pathname.match(/^\/api\/scenes\/(\d+)(\/(run|pause|resume|collisions|trajectory|stats))?$/);
      if (sub) {
        const id = Number(sub[1]);
        const action = sub[3];
        if (method === "GET" && !action) {
          const loaded = repo.loadScene(id);
          return send(200, {
            id,
            width: loaded.container.width,
            height: loaded.container.height,
            time: loaded.snapshot.time,
            paused: loaded.snapshot.paused,
            version: loaded.snapshot.version,
            stopReason: loaded.snapshot.stopReason,
            tolerance: loaded.tolerance,
            disks: loaded.disks,
          });
        }
        if (method === "POST" && action === "run") {
          const body = await readBody();
          if (typeof body.targetTime !== "number")
            throw new SimError("VALIDATION", "targetTime (number) is required");
          const r = repo.run(id, body.targetTime, {
            idempotencyKey: body.idempotencyKey ?? idemKey ?? undefined,
            toleranceOverride: body.tolerance,
          });
          return send(r.reused ? 200 : 200, {
            time: r.snapshot.time,
            version: r.snapshot.version,
            stopReason: r.stopReason,
            disks: r.snapshot.disks,
            collisions: r.collisions.length,
            reused: r.reused,
          });
        }
        if (method === "POST" && action === "pause") {
          repo.setPaused(id, true);
          return send(200, { id, paused: true });
        }
        if (method === "POST" && action === "resume") {
          repo.setPaused(id, false);
          return send(200, { id, paused: false });
        }
        if (method === "GET" && action === "collisions") {
          const page = parsePage(url);
          const { items, total } = repo.listCollisions(id, page);
          return send(200, { items, total, limit: page.limit, offset: page.offset });
        }
        if (method === "GET" && action === "trajectory") {
          const diskNo = url.searchParams.get("diskNo");
          const items = repo.trajectory(id, diskNo === null ? undefined : Number(diskNo));
          return send(200, { items });
        }
        if (method === "GET" && action === "stats") {
          return send(200, repo.stats(id));
        }
      }

      send(404, { error: { code: "NOT_FOUND", message: `no route for ${method} ${url.pathname}` } });
    } catch (err) {
      if (err instanceof SimError) {
        const status = HTTP_STATUS[err.code] ?? 500;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: err.code, message: err.message, details: err.details ?? null } }));
        return;
      }
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "INTERNAL", message: (err as Error).message } }));
    }
  });

  return server;
}

/** Bind only to loopback; port 0 lets the OS assign a free port automatically. */
export function listenLocal(server: http.Server, port = 0, host = "127.0.0.1"): Promise<{ port: number; host: string }> {
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address() as AddressInfo;
      resolve({ port: addr.port, host: addr.address });
    });
  });
}

export { applyMigrations };
