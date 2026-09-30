import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { openDatabase } from "./db/migrate.js";
import { createApp, listenLocal } from "./api/server.js";

/**
 * Entry point. All data stays inside this project under ./data.
 * Binds to 127.0.0.1 only and picks an automatic free port by default.
 */
async function main() {
  const dbPath = process.env.DISK_SIM_DB ?? resolve("data/disk-sim.sqlite");
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  const app = createApp({ db });
  const port = Number(process.env.DISK_SIM_PORT ?? 0);
  const { port: actual, host } = await listenLocal(app, port);
  const base = `http://${host}:${actual}`;
  if (process.env.DISK_SIM_PORT_FILE) {
    writeFileSync(process.env.DISK_SIM_PORT_FILE, base, "utf8");
  }
  console.log(`[disk-sim] listening on ${base} (loopback only)`);
  console.log(`[disk-sim] database: ${dbPath}`);
  console.log(`[disk-sim] health:    ${base}/api/health`);

  const shutdown = () => {
    console.log("\n[disk-sim] shutting down ...");
    app.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
