import { openDb } from "./db.js";
import { SimService } from "./service.js";
import { createApiServer, listenLocal } from "./api.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const dbPath = process.env["DISK_SIM_DB"] ?? resolve("data/disk-sim.db");
const port = Number(process.env["DISK_SIM_PORT"] ?? 0);

const db = openDb(dbPath);
const service = new SimService(db);
const server = createApiServer(service);

const actualPort = await listenLocal(server, port);
const info = { port: actualPort, host: "127.0.0.1", db: dbPath, pid: process.pid };
const infoPath = process.env["DISK_SIM_INFO"] ?? resolve("data/server.json");
mkdirSync(dirname(infoPath), { recursive: true });
writeFileSync(infoPath, JSON.stringify(info, null, 2));
console.log(`disk-sim listening on http://127.0.0.1:${actualPort} (pid ${process.pid})`);
console.log(`db: ${dbPath}`);

const shutdown = (): void => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
