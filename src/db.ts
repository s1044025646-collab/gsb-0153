import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function openDb(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

const MIGRATIONS: { id: number; sql: string }[] = [
  {
    id: 1,
    sql: `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scenes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  width REAL NOT NULL,
  height REAL NOT NULL,
  restitution REAL NOT NULL,
  base_scene_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS disks (
  scene_id INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  disk_id INTEGER NOT NULL,
  r REAL NOT NULL,
  m REAL NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  vx REAL NOT NULL,
  vy REAL NOT NULL,
  PRIMARY KEY (scene_id, disk_id)
);
CREATE TABLE IF NOT EXISTS runtime (
  scene_id INTEGER PRIMARY KEY REFERENCES scenes(id) ON DELETE CASCADE,
  t REAL NOT NULL,
  event_seq INTEGER NOT NULL,
  wall_ix REAL NOT NULL,
  wall_iy REAL NOT NULL,
  wall_count INTEGER NOT NULL,
  stopped_reason TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  t REAL NOT NULL,
  disk_a INTEGER NOT NULL,
  disk_b INTEGER NOT NULL,
  nx REAL NOT NULL,
  ny REAL NOT NULL,
  impulse REAL NOT NULL,
  iterations INTEGER NOT NULL,
  converged INTEGER NOT NULL,
  va_xb REAL NOT NULL, va_yb REAL NOT NULL, vb_xb REAL NOT NULL, vb_yb REAL NOT NULL,
  va_xa REAL NOT NULL, va_ya REAL NOT NULL, vb_xa REAL NOT NULL, vb_ya REAL NOT NULL,
  tol_contact_eps REAL NOT NULL,
  tol_time_eps REAL NOT NULL,
  tol_resting_speed REAL NOT NULL,
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (scene_id, seq)
);
CREATE TABLE IF NOT EXISTS trajectories (
  scene_id INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  t REAL NOT NULL,
  disk_id INTEGER NOT NULL,
  x REAL NOT NULL, y REAL NOT NULL,
  vx REAL NOT NULL, vy REAL NOT NULL,
  PRIMARY KEY (scene_id, t, disk_id)
);
CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT PRIMARY KEY,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`,
  },
];

/** Repeatable migration: each statement is IF NOT EXISTS guarded and tracked by id. */
export function migrate(db: DatabaseSync): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);`,
  );
  const applied = new Set(
    db
      .prepare("SELECT id FROM schema_migrations")
      .all()
      .map((r) => (r as { id: number }).id),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    const tx = db.prepare(
      "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)",
    );
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      tx.run(m.id, new Date().toISOString());
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}
