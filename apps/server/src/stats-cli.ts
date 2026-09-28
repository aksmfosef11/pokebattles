/**
 * Balance statistics from the server database, as Markdown.
 *
 *   pnpm stats                                   # whole history, both modes
 *   pnpm stats --since 2026-09-01 --ranked       # ranked runs since a date
 *   pnpm stats --min-round 8 --out docs/stats-report.md
 *   pnpm stats --json                            # the raw report
 *   pnpm stats --build 3fa9c01b2e                # only what one server build recorded (the report lists builds)
 *   pnpm stats --since 2026-09-29 --until 2026-10-05
 *   pnpm stats --export rows.json                # raw runs and battles (battle detail, shop logs) for other analysis
 *
 * The database is DATABASE_URL (PostgreSQL) when set, else the PGlite folder from --pgdata,
 * POKEBATTLES_PGDATA or apps/server/data/pglite. A PGlite folder opens in one process only: stop the
 * dev server first.
 *
 * Docker: docker compose exec server node dist/stats.mjs --since 2026-09-01
 */
import { existsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dbConfigFromEnv, openDb } from "./db.ts";
import { collectStats, exportRows, statsMarkdown, type StatsFilter } from "./stats.ts";

const args = process.argv.slice(2);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const here = dirname(fileURLToPath(import.meta.url));
const pgdata = value("--pgdata");
const config = dbConfigFromEnv(resolve(here, "..", "data", "pglite"), pgdata ? { ...process.env, DATABASE_URL: "", POKEBATTLES_PGDATA: pgdata } : process.env);
if ("pgdata" in config && !existsSync(config.pgdata)) {
  console.error(`no database at ${config.pgdata} (use --pgdata, POKEBATTLES_PGDATA or DATABASE_URL)`);
  process.exit(1);
}

const filter: StatsFilter = {};
const time = (v: string) => (/^\d+$/.test(v) ? Number(v) : Date.parse(v));
const since = value("--since");
if (since) filter.since = time(since);
const until = value("--until");
if (until) filter.until = time(until);
const build = value("--build");
if (build) filter.build = build;
if (args.includes("--ranked")) filter.ranked = true;
if (args.includes("--normal")) filter.ranked = false;
if (value("--min-round")) filter.minRound = Number(value("--min-round"));
if (value("--min-sample")) filter.minSample = Number(value("--min-sample"));

const db = await openDb(config).catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
const exportTo = value("--export");
if (exportTo) {
  try {
    writeFileSync(exportTo, JSON.stringify({ generatedAt: Date.now(), ...(await exportRows(db, filter, Number(value("--limit") ?? 100_000))) }));
  } finally {
    await db.close();
  }
  console.log(`wrote ${exportTo}`);
  process.exit(0);
}

let report;
try {
  report = await collectStats(db, filter);
} finally {
  await db.close();
}

const text = args.includes("--json") ? JSON.stringify(report, null, 2) + "\n" : statsMarkdown(report, filter);
const out = value("--out");
if (out) {
  writeFileSync(out, text);
  console.log(`wrote ${out}`);
} else {
  process.stdout.write(text);
}
