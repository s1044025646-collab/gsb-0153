import { DatabaseSync } from "node:sqlite";

/**
 * Idempotent schema migrations. Re-running applyMigrations is safe: each is
 * guarded and tracked in schema_migrations.
 */
export function applyMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  const applied = new Set(
    db.prepare("SELECT version FROM schema_migrations").all().map((r: any) => Number(r.version)),
  );

  const migrations: { version: number; name: string; sql: string }[] = [
    {
      version: 1,
      name: "scenes",
      sql: `
        CREATE TABLE IF NOT EXISTS scenes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          width REAL NOT NULL,
          height REAL NOT NULL,
          time REAL NOT NULL DEFAULT 0,
          paused INTEGER NOT NULL DEFAULT 0,
          version INTEGER NOT NULL DEFAULT 1,
          stop_reason TEXT,
          tolerance_json TEXT NOT NULL,
          idempotency_key TEXT UNIQUE,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS disks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          scene_id INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
          disk_no INTEGER NOT NULL,
          radius REAL NOT NULL,
          mass REAL NOT NULL,
          restitution REAL NOT NULL,
          x REAL NOT NULL,
          y REAL NOT NULL,
          vx REAL NOT NULL,
          vy REAL NOT NULL,
          UNIQUE(scene_id, disk_no)
        );
        CREATE TABLE IF NOT EXISTS collisions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          scene_id INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
          seq INTEGER NOT NULL,
          time REAL NOT NULL,
          kind TEXT NOT NULL,
          disks_json TEXT NOT NULL,
          wall TEXT,
          normal_json TEXT NOT NULL,
          impulses_json TEXT NOT NULL,
          impulse_magnitude REAL NOT NULL,
          vel_before_json TEXT NOT NULL,
          vel_after_json TEXT NOT NULL,
          tolerance_json TEXT NOT NULL,
          simultaneous INTEGER NOT NULL,
          iterations INTEGER NOT NULL,
          converged INTEGER NOT NULL,
          version INTEGER NOT NULL,
          UNIQUE(scene_id, seq)
        );
        CREATE TABLE IF NOT EXISTS trajectory (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          scene_id INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
          disk_no INTEGER NOT NULL,
          time REAL NOT NULL,
          x REAL NOT NULL,
          y REAL NOT NULL,
          vx REAL NOT NULL,
          vy REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_collisions_scene_time ON collisions(scene_id, time);
        CREATE INDEX IF NOT EXISTS idx_trajectory_scene_disk_time ON trajectory(scene_id, disk_no, time);
      `,
    },
    {
      version: 2,
      name: "run_requests",
      sql: `
        CREATE TABLE IF NOT EXISTS run_requests (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          scene_id INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
          idempotency_key TEXT NOT NULL,
          request_json TEXT NOT NULL,
          result_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(scene_id, idempotency_key)
        );
      `,
    },
  ];

  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?,?,?)").run(
        m.version,
        m.name,
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  applyMigrations(db);
  return db;
}
