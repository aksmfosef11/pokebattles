import type { Db } from "./db.ts";

/**
 * Schema changes in order. A database remembers which versions it has (schema_migrations), so a new
 * column is a new entry here — never an edit of an entry that already shipped. One SQL statement per
 * string (PGlite runs one statement per query).
 */
const MIGRATIONS: { version: number; name: string; up: string[] }[] = [
  {
    version: 1,
    name: "initial",
    up: [
      `CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        password TEXT NOT NULL,
        profile JSONB NOT NULL,
        rating INTEGER NOT NULL,
        ranked_runs INTEGER NOT NULL DEFAULT 0,
        created_at BIGINT NOT NULL
      )`,
      // IDs are unique regardless of case ("Alpha1" and "alpha1" are the same trainer).
      `CREATE UNIQUE INDEX users_username_lower ON users (lower(username))`,
      `CREATE INDEX users_rating ON users (ranked_runs, rating)`,
      `CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        created_at BIGINT NOT NULL
      )`,
      `CREATE INDEX sessions_user ON sessions (user_id)`,
      `CREATE TABLE runs (
        run_id TEXT PRIMARY KEY,
        player_id TEXT NOT NULL,
        state JSONB NOT NULL,
        pending JSONB,
        ranked BOOLEAN NOT NULL DEFAULT FALSE,
        phase TEXT NOT NULL DEFAULT '',
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      )`,
      `CREATE INDEX runs_player ON runs (player_id, updated_at)`,
      `CREATE INDEX runs_active ON runs (player_id, ranked, phase)`,
      `CREATE TABLE ghosts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        player_id TEXT NOT NULL,
        round INTEGER NOT NULL,
        wins INTEGER NOT NULL,
        losses INTEGER NOT NULL,
        team JSONB NOT NULL,
        ranked BOOLEAN NOT NULL DEFAULT FALSE,
        rating INTEGER,
        created_at BIGINT NOT NULL
      )`,
      `CREATE INDEX ghosts_match ON ghosts (round, ranked, created_at)`,
      `CREATE TABLE battles (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        player_id TEXT,
        round INTEGER NOT NULL,
        seed TEXT NOT NULL,
        ghost_id TEXT,
        outcome TEXT NOT NULL,
        ranked BOOLEAN NOT NULL DEFAULT FALSE,
        ghost BOOLEAN NOT NULL DEFAULT FALSE,
        champion TEXT,
        subclass TEXT,
        wins INTEGER,
        losses INTEGER,
        species JSONB,
        items JSONB,
        opp_champion TEXT,
        opp_subclass TEXT,
        opp_species JSONB,
        opp_items JSONB,
        created_at BIGINT NOT NULL
      )`,
      `CREATE INDEX battles_created ON battles (created_at)`,
      `CREATE TABLE run_results (
        run_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        champion TEXT NOT NULL,
        subclass TEXT,
        ranked BOOLEAN NOT NULL,
        wins INTEGER NOT NULL,
        losses INTEGER NOT NULL,
        rounds INTEGER NOT NULL,
        points INTEGER NOT NULL,
        rating_before INTEGER,
        rating_after INTEGER,
        species JSONB NOT NULL,
        items JSONB NOT NULL,
        ended_at BIGINT NOT NULL
      )`,
      `CREATE INDEX run_results_ended ON run_results (ended_at)`,
    ],
  },
  {
    version: 2,
    name: "balance detail",
    up: [
      // Per-Pokémon battle summary (game battle/log.ts) and the player's shop phase before it (run/shoplog.ts).
      `ALTER TABLE battles ADD COLUMN detail JSONB`,
      `ALTER TABLE battles ADD COLUMN shop JSONB`,
      // The server build that recorded a row: statistics can be split before/after a balance patch.
      `ALTER TABLE battles ADD COLUMN build TEXT`,
      `ALTER TABLE run_results ADD COLUMN build TEXT`,
      // How the run started (pool stage, start items, starter training, the player's experience).
      `ALTER TABLE runs ADD COLUMN context JSONB`,
      `ALTER TABLE run_results ADD COLUMN context JSONB`,
      `CREATE INDEX battles_run ON battles (run_id)`,
      `CREATE INDEX run_results_user ON run_results (user_id, ended_at)`,
    ],
  },
];

/** Any constant: server instances starting together take turns migrating. */
const MIGRATION_LOCK = 72_311_904;

/** Brings the database up to the latest schema; returns the versions it applied. */
export async function migrate(db: Db): Promise<number[]> {
  return db.tx(async (q) => {
    await q.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
    await q.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at BIGINT NOT NULL)`);
    const have = new Set((await q.query<{ version: number }>("SELECT version FROM schema_migrations")).map((r) => Number(r.version)));
    const applied: number[] = [];
    for (const m of MIGRATIONS) {
      if (have.has(m.version)) continue;
      for (const sql of m.up) await q.query(sql);
      await q.query("INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, $3)", [m.version, m.name, Date.now()]);
      applied.push(m.version);
    }
    return applied;
  });
}
