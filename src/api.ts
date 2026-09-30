import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { SimService } from "./service.js";
import { SimError } from "./types.js";

interface HttpError {
  error: { code: string; message: string; details?: unknown };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
  });
  res.end(json);
}

function readJson(req: IncomingMessage, maxBytes = 1_000_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new SimError("PAYLOAD_TOO_LARGE", "request body exceeds 1MB"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new SimError("INVALID_JSON", "body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

export function createApiServer(service: SimService): Server {
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      if (err instanceof SimError) {
        const status = statusFor(err.code);
        const body: HttpError = {
          error: { code: err.code, message: err.message, details: err.details },
        };
        send(res, status, body);
        return;
      }
      const e = err as { code?: string; message?: string };
      if (e?.code === "NOT_FOUND") {
        send(res, 404, { error: { code: "NOT_FOUND", message: "resource not found" } });
        return;
      }
      send(res, 500, {
        error: { code: "INTERNAL", message: e?.message ?? "internal error" },
      });
    });
  });
  return server;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";

    if (method === "GET" && path === "/health") {
      send(res, 200, { status: "ok" });
      return;
    }

    const sceneMatch = /^\/scenes\/(\d+)$/.exec(path);
    const eventsMatch = /^\/scenes\/(\d+)\/events$/.exec(path);
    const eventMatch = /^\/scenes\/(\d+)\/events\/(\d+)$/.exec(path);
    const runMatch = /^\/scenes\/(\d+)\/run$/.exec(path);
    const trajMatch = /^\/scenes\/(\d+)\/trajectory$/.exec(path);
    const compareMatch = /^\/scenes\/(\d+)\/compare-restitution$/.exec(path);

    if (method === "GET" && path === "/scenes") {
      send(
        res,
        200,
        service.listScenes(url.searchParams.get("page"), url.searchParams.get("pageSize")),
      );
      return;
    }
    if (method === "POST" && path === "/scenes") {
      const body = (await readJson(req)) as Record<string, unknown>;
      const spec = parseSceneBody(body);
      const key = idemKey(req);
      send(res, 201, service.createScene(String(body["name"] ?? ""), spec, key));
      return;
    }
    if (sceneMatch && method === "GET") {
      send(res, 200, service.getStatus(Number(sceneMatch[1]!)));
      return;
    }
    if (eventsMatch && method === "GET") {
      send(
        res,
        200,
        service.listEvents(
          Number(eventsMatch[1]!),
          Number(url.searchParams.get("page") ?? 1),
          Number(url.searchParams.get("pageSize") ?? 50),
        ),
      );
      return;
    }
    if (eventMatch && method === "GET") {
      send(res, 200, service.getEvent(Number(eventMatch[1]!), Number(eventMatch[2]!)));
      return;
    }
    if (runMatch && method === "POST") {
      const body = (await readJson(req)) as Record<string, unknown>;
      const duration = Number(body["duration"]);
      send(
        res,
        200,
        service.run(Number(runMatch[1]!), duration, idemKey(req)),
      );
      return;
    }
    if (trajMatch && method === "GET") {
      send(res, 200, { items: service.exportTrajectory(Number(trajMatch[1]!)) });
      return;
    }
    if (compareMatch && method === "POST") {
      const body = (await readJson(req)) as Record<string, unknown>;
      const restitution = Number(body["restitution"]);
      const newName = String(body["name"] ?? "");
      const id = service.cloneWithRestitution(
        Number(compareMatch[1]!),
        newName,
        restitution,
      );
      send(res, 201, { id, name: newName, restitution });
      return;
    }
    send(res, 404, { error: { code: "NO_ROUTE", message: `${method} ${path}` } });
  }
}

function statusFor(code: string): number {
  switch (code) {
    case "NOT_FOUND":
      return 404;
    case "NAME_CONFLICT":
      return 409;
    case "SCENE_STOPPED":
      return 409;
    case "PAYLOAD_TOO_LARGE":
      return 413;
    default:
      return 400;
  }
}

function idemKey(req: IncomingMessage): string | undefined {
  const v = req.headers["idempotency-key"];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function parseSceneBody(body: Record<string, unknown>) {
  const disks = body["disks"];
  if (!Array.isArray(disks)) {
    throw new SimError("INVALID_DISKS", "disks must be an array");
  }
  return {
    width: Number(body["width"]),
    height: Number(body["height"]),
    restitution: Number(body["restitution"]),
    disks: disks.map((raw) => {
      const d = raw as Record<string, unknown>;
      return {
        id: Number(d["id"]),
        r: Number(d["r"]),
        m: Number(d["m"]),
        x: Number(d["x"]),
        y: Number(d["y"]),
        vx: Number(d["vx"]),
        vy: Number(d["vy"]),
      };
    }),
  };
}

/** Bind to loopback only; port 0 lets the OS assign an ephemeral free port. */
export function listenLocal(server: Server, port = 0): Promise<number> {
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}
