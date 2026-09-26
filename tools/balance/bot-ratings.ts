/**
 * `pnpm bot-ratings` — measures how strong each ranked bot luck (server/bot.ts BOT_LUCK) is and writes
 * packages/game/src/generated/bot-ratings.json, the ratings ranked battles against bots are scored with.
 *
 * Every luck plays plain bot runs (one ordinary run = the start rating) at rounds 2–14, both sides of each
 * pairing; its win rate over all of them becomes an Elo difference. Rerun it after balance changes: bots
 * shop with the same rules as players, so their strength moves with the content.
 *
 *   pnpm bot-ratings [--quick] [--seed <salt>]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BOT_LUCK, botTeam, luckyBotTeam, META_RULES, simulateBattle } from "../../packages/game/src/index.ts";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const QUICK = process.argv.includes("--quick");
const SALT = argValue("--seed") ?? "";
const ROUNDS = [2, 4, 6, 8, 10, 12, 14];
/** Pairings per luck and round; each is played from both sides. */
const PAIRS = QUICK ? 30 : 150;

interface JobResult {
  key: string;
  round: number;
  score: number;
  games: number;
}

function runJob(key: string, round: number): JobResult {
  const luck = BOT_LUCK.find((l) => l.key === key)!;
  let score = 0;
  for (let i = 0; i < PAIRS; i++) {
    const mine = luckyBotTeam(`${SALT}luck-${key}-${round}-${i}`, round, luck);
    const ref = botTeam(`${SALT}ref-${round}-${i}`, round);
    const a = simulateBattle({ seed: `${SALT}a-${round}-${i}`, teams: [mine, ref] }).winner;
    const b = simulateBattle({ seed: `${SALT}b-${round}-${i}`, teams: [ref, mine] }).winner;
    score += (a === 0 ? 1 : a === null ? 0.5 : 0) + (b === 1 ? 1 : b === null ? 0.5 : 0);
  }
  return { key, round, score, games: PAIRS * 2 };
}

/** Elo difference for a win rate (clamped so a lopsided sample stays finite). */
function eloDiff(rate: number): number {
  const p = Math.max(0.02, Math.min(0.98, rate));
  return 400 * Math.log10(p / (1 - p));
}

function runWorker(args: string[], out: string): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), ...args, "--out", out], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    child.on("exit", (code) => (code === 0 ? done() : fail(new Error(`worker ${args.join(" ")} exited ${code}`))));
  });
}

async function main(): Promise<void> {
  const jobArg = process.argv.indexOf("--job");
  if (jobArg >= 0) {
    writeFileSync(argValue("--out")!, JSON.stringify(runJob(process.argv[jobArg + 1]!, Number(process.argv[jobArg + 2]))));
    return;
  }
  const started = Date.now();
  const dir = mkdtempSync(join(tmpdir(), "pokebattles-bot-ratings-"));
  const flags = [...(QUICK ? ["--quick"] : []), ...(SALT ? ["--seed", SALT] : [])];
  const lucks = BOT_LUCK.filter((l) => l.runs > 1);
  // Late rounds are the slowest jobs: queue them first.
  const jobs = [...ROUNDS].reverse().flatMap((round) => lucks.map((l) => ({ key: l.key, round })));
  const queue = [...jobs];
  const file = (j: { key: string; round: number }) => join(dir, `${j.key}-${j.round}.json`);
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(jobs.length, cpus().length)) }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        await runWorker(["--job", job.key, String(job.round), ...flags], file(job));
        console.error(`  ${job.key} round ${job.round} done (${Math.round((Date.now() - started) / 1000)}s)`);
      }
    }),
  );
  const results = jobs.map((j) => JSON.parse(readFileSync(file(j), "utf8")) as JobResult);

  const ratings: Record<string, number> = {};
  const perRound: Record<string, Record<number, number>> = {};
  const games: Record<string, number> = {};
  for (const luck of BOT_LUCK) {
    if (luck.runs <= 1) {
      ratings[luck.key] = META_RULES.startRating;
      continue;
    }
    const mine = results.filter((r) => r.key === luck.key);
    const score = mine.reduce((s, r) => s + r.score, 0);
    games[luck.key] = mine.reduce((s, r) => s + r.games, 0);
    ratings[luck.key] = META_RULES.startRating + Math.round(eloDiff(score / games[luck.key]!) / 5) * 5;
    perRound[luck.key] = Object.fromEntries(mine.sort((a, b) => a.round - b.round).map((r) => [r.round, Math.round(eloDiff(r.score / r.games))]));
  }
  for (const luck of BOT_LUCK) {
    const rounds = perRound[luck.key];
    console.log(
      `${luck.key.padEnd(7)} ${ratings[luck.key]}${rounds ? `  (${games[luck.key]} games; by round ${Object.entries(rounds).map(([r, d]) => `${r}:${d >= 0 ? "+" : ""}${d}`).join(" ")})` : "  (anchor)"}`,
    );
  }
  const command = `pnpm bot-ratings${QUICK ? " --quick" : ""}${SALT ? ` --seed ${SALT}` : ""}`;
  const out = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "packages", "game", "src", "generated", "bot-ratings.json");
  writeFileSync(out, JSON.stringify({ command, games, ratings, eloByRound: perRound }, null, 2) + "\n");
  console.error(`wrote ${out} (${Math.round((Date.now() - started) / 1000)}s)`);
}

await main();
