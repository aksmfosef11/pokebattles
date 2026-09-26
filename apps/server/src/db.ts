import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";

/** Something SQL can run on: the database itself, or one transaction. */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
}

/**
 * PostgreSQL, reached through `pg` (a real server, `DATABASE_URL`) or PGlite (Postgres compiled to
 * WASM, running in this process). Both speak the same SQL, so the store does not care which.
 */
export interface Db extends Queryable {
  readonly kind: "postgres" | "pglite";
  /** Where the data lives, for the start-up log (no password). */
  readonly label: string;
  /** Runs `fn` in one transaction on one connection; a throw rolls it back. Use only `q` inside. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export type DbConfig =
  | { url: string; poolMax?: number; /** Schema to work in (tests use a throwaway one). */ searchPath?: string }
  | { pgdata: string }
  | { memory: true };

/** SQLSTATE of a unique or primary-key violation. */
export const UNIQUE_VIOLATION = "23505";

export function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string } | null)?.code === UNIQUE_VIOLATION;
}

class PoolDb implements Db {
  readonly kind = "postgres";

  constructor(
    private readonly pool: pg.Pool,
    readonly label: string,
  ) {}

  async query<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    return (await this.pool.query(sql, params as unknown[])).rows as T[];
  }

  async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn({ query: async <R>(sql: string, params: readonly unknown[] = []) => (await client.query(sql, params as unknown[])).rows as R[] });
      await client.query("COMMIT");
      return out;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}

class LiteDb implements Db {
  readonly kind = "pglite";

  constructor(
    private readonly lite: PGlite,
    readonly label: string,
    private readonly onClose: () => void = () => undefined,
  ) {}

  async query<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    return (await this.lite.query<T>(sql, params as unknown[])).rows;
  }

  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    return this.lite.transaction((t) => fn({ query: async <R>(sql: string, params: readonly unknown[] = []) => (await t.query<R>(sql, params as unknown[])).rows }));
  }

  async close(): Promise<void> {
    await this.lite.close();
    this.onClose();
  }
}

function describeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.port ? `:${u.port}` : ""}${u.pathname}`;
  } catch {
    return "postgres";
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === "EPERM";
  }
}

/**
 * A PGlite folder must only be open in one process (two would corrupt it): a lock file next to it
 * holds the owner's pid. A lock left by a process that died is taken over.
 */
function lockDataDir(dir: string): () => void {
  const lock = `${dir}.lock`;
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, "utf8").trim());
    if (pid && pid !== process.pid && pidAlive(pid)) {
      throw new Error(`PGlite data ${dir} is already open in process ${pid} (stop it first, or use DATABASE_URL with a real PostgreSQL)`);
    }
  }
  writeFileSync(lock, String(process.pid));
  return () => rmSync(lock, { force: true });
}

export async function openDb(config: DbConfig): Promise<Db> {
  if ("url" in config) {
    if (config.searchPath && !/^\w+$/.test(config.searchPath)) throw new Error(`bad schema name ${config.searchPath}`);
    const pool = new pg.Pool({
      connectionString: config.url,
      max: config.poolMax ?? 10,
      ...(config.searchPath ? { options: `-c search_path=${config.searchPath}` } : {}),
    });
    // An idle connection dropped by the server must not crash the process; the pool replaces it.
    pool.on("error", (err) => console.error("postgres pool:", err.message));
    const db = new PoolDb(pool, `PostgreSQL ${describeUrl(config.url)}`);
    try {
      await db.query("SELECT 1");
    } catch (e) {
      await pool.end().catch(() => undefined);
      throw e;
    }
    return db;
  }
  if ("memory" in config) {
    const lite = await PGlite.create();
    return new LiteDb(lite, "PGlite (in memory)");
  }
  mkdirSync(dirname(config.pgdata), { recursive: true });
  const unlock = lockDataDir(config.pgdata);
  try {
    const lite = await PGlite.create(config.pgdata);
    return new LiteDb(lite, `PGlite ${config.pgdata}`, unlock);
  } catch (e) {
    unlock();
    throw e;
  }
}

/**
 * The server's database from the environment: `DATABASE_URL` (PostgreSQL) when set, otherwise the
 * embedded PGlite folder `POKEBATTLES_PGDATA` (or `defaultPgdata`).
 */
export function dbConfigFromEnv(defaultPgdata: string, env: NodeJS.ProcessEnv = process.env): DbConfig {
  const url = env.DATABASE_URL?.trim();
  if (url) {
    const poolMax = Number(env.PG_POOL_MAX);
    return { url, ...(Number.isFinite(poolMax) && poolMax > 0 ? { poolMax } : {}) };
  }
  return { pgdata: env.POKEBATTLES_PGDATA?.trim() || defaultPgdata };
}
