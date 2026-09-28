import { CHAMPION_KEYS, WINS_TO_CLEAR, type BattleLog, type ShopLog } from "@pokebattles/game";
import type { Queryable } from "./db.ts";
import type { RunContext } from "./store.ts";

/**
 * Balance statistics from what players actually did (docs/DESIGN.md §8): finished runs (run_results)
 * and every battle (battles). Bot opponents are left out of per-team numbers because a bot's team is
 * not a player's choice; they still count toward a player's own battle win rate.
 *
 * Battles recorded since build tags exist also carry a per-Pokémon summary (`detail`: damage, KOs,
 * survival) and the player's shop phase (`shop`: offers seen, bought, sold, rerolls, gold), and runs carry
 * how they started (`context`). Older rows simply lack those and only count toward the older sections.
 */
export interface StatsFilter {
  /** Only data from this time on (ms since epoch). */
  since?: number;
  /** Only data up to this time (ms since epoch). */
  until?: number;
  /** true: ranked only, false: normal only, undefined: both. */
  ranked?: boolean;
  /** Only data recorded by this server build (the report lists the builds). */
  build?: string;
  /** Battles before this round are left out of species/item numbers (early boards say little). */
  minRound?: number;
  /** Species/items need this many battles to be listed in the report. */
  minSample?: number;
}

export interface ChampionStats {
  champion: string;
  runs: number;
  pickRate: number;
  avgWins: number;
  clearRate: number;
  /** Runs by final wins, index 0–10. */
  winsHistogram: number[];
  battles: number;
  winRate: number;
  /** Battles against other players' ghosts only. */
  pvpBattles: number;
  pvpWinRate: number;
}

export interface EntryStats {
  key: string;
  /** Battles where a team had it on the board (counted once per team). */
  battles: number;
  winRate: number;
  /** Finished runs whose final board had it. */
  runs: number;
  avgWins: number;
}

/** How the Pokémon with a species / ability / touching item fought (battles with a detail summary). */
export interface PerfStats {
  key: string;
  /** Pokémon counted (one per battle). */
  n: number;
  /** Damage it did relative to the average teammate's (1 = an average share of its side's damage). */
  carry: number;
  kos: number;
  /** Share still standing at the end of the battle. */
  survival: number;
  /** Share standing on its side's front line (the front-most row its team uses, which enemies hit first). */
  front: number;
  level: number;
}

export interface OfferStats {
  key: string;
  /** Times it was in a shop the player saw (a locked slot counts again every round it stays). */
  offered: number;
  bought: number;
  pickRate: number;
  sold: number;
}

/** A champion's shop phases, per round on average. */
export interface EconomyStats {
  champion: string;
  rounds: number;
  goldStart: number;
  goldEnd: number;
  rerolls: number;
  spent: number;
  sold: number;
  sellGold: number;
  arranged: number;
}

export interface GroupStats {
  group: string;
  runs: number;
  avgWins: number;
  /** Average of (wins − that champion's average): above 0 = better than the champion usually does. */
  vsChampion: number;
}

export interface PlayerStats {
  player: string;
  runs: number;
  avgWins: number;
  vsChampion: number;
  /** Most played champions, e.g. "red×12 alder×3". */
  champions: string;
  /** Rating after the player's latest ranked run in the data. */
  rating: number | null;
}

export interface BuildStats {
  build: string;
  firstAt: number;
  lastAt: number;
  runs: number;
  battles: number;
}

export interface StatsReport {
  generatedAt: number;
  filter: StatsFilter;
  totals: { players: number; runs: number; battles: number; pvpBattles: number };
  /** Every build that recorded data (unfiltered), oldest first; "-" is data from before build tags. */
  builds: BuildStats[];
  champions: ChampionStats[];
  subclasses: { subclass: string; runs: number; pickRate: number; avgWins: number; clearRate: number }[];
  /** matchups[a][b]: a's win rate against b in battles between players. */
  matchups: Record<string, Record<string, { battles: number; winRate: number }>>;
  /** Battle win rate per champion by round range. */
  roundCurve: { champion: string; buckets: { rounds: string; battles: number; winRate: number }[] }[];
  species: EntryStats[];
  items: EntryStats[];
  /** From battles with a detail summary. */
  performance: { battles: number; species: PerfStats[]; abilities: PerfStats[]; items: PerfStats[] };
  /** From shop logs: how often an offer is taken when shown. */
  offers: OfferStats[];
  economy: EconomyStats[];
  /**
   * Players by number of runs, and how consistent players are: the correlation between their odd and even
   * runs (wins against their champion's average). Near 0 = results are luck; the higher, the more a player's
   * level shows (reliability = the same, corrected to all their runs).
   */
  players: { list: PlayerStats[]; consistency: { players: number; r: number; reliability: number } | null };
  /** Runs by how many runs the player had finished before. */
  experience: GroupStats[];
  poolStages: GroupStats[];
  startItems: GroupStats[];
}

/** JSONB values: already parsed by the driver, or JSON text. */
type Json<T> = T | string | null;

export interface StatsRunRow {
  run_id: string;
  champion: string;
  subclass: string | null;
  wins: number;
  species: Json<string[]>;
  items: Json<string[]>;
  user_id: string;
  username: string | null;
  ranked: boolean | number;
  rating_after: number | null;
  ended_at: string | number;
  context: Json<RunContext>;
}

export interface StatsBattleRow {
  round: number;
  outcome: string;
  ghost: boolean | number;
  champion: string | null;
  opp_champion: string | null;
  species: Json<string[]>;
  items: Json<string[]>;
  opp_species: Json<string[]>;
  opp_items: Json<string[]>;
  detail: Json<BattleLog>;
  shop: Json<ShopLog>;
}

export interface StatsBuildRow {
  build: string | null;
  first_at: string | number;
  last_at: string | number;
  runs: number | string;
  battles: number | string;
}

const score = (outcome: string) => (outcome === "win" ? 1 : outcome === "draw" ? 0.5 : 0);
const rate = (sum: number, n: number) => (n > 0 ? Math.round((sum / n) * 1000) / 1000 : 0);
const round3 = (x: number) => Math.round(x * 1000) / 1000;
function parse<T>(value: Json<T>): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}
const keys = (list: Json<string[]>): string[] => parse(list) ?? [];

class Tally {
  private readonly m = new Map<string, { battles: number; score: number; runs: number; wins: number }>();
  private get(key: string) {
    let e = this.m.get(key);
    if (!e) this.m.set(key, (e = { battles: 0, score: 0, runs: 0, wins: 0 }));
    return e;
  }
  battle(keys: string[], s: number) {
    for (const k of new Set(keys)) {
      const e = this.get(k);
      e.battles++;
      e.score += s;
    }
  }
  run(keys: string[], wins: number) {
    for (const k of new Set(keys)) {
      const e = this.get(k);
      e.runs++;
      e.wins += wins;
    }
  }
  list(): EntryStats[] {
    return [...this.m.entries()]
      .map(([key, e]) => ({ key, battles: e.battles, winRate: rate(e.score, e.battles), runs: e.runs, avgWins: rate(e.wins, e.runs) }))
      .sort((a, b) => b.battles - a.battles || (a.key < b.key ? -1 : 1));
  }
}

class PerfTally {
  private readonly m = new Map<string, { n: number; carry: number; carryN: number; kos: number; alive: number; front: number; level: number }>();
  add(key: string, x: { carry: number | null; kos: number; alive: boolean; front: boolean; level: number }) {
    let e = this.m.get(key);
    if (!e) this.m.set(key, (e = { n: 0, carry: 0, carryN: 0, kos: 0, alive: 0, front: 0, level: 0 }));
    e.n++;
    if (x.carry !== null) {
      e.carry += x.carry;
      e.carryN++;
    }
    e.kos += x.kos;
    if (x.alive) e.alive++;
    if (x.front) e.front++;
    e.level += x.level;
  }
  list(): PerfStats[] {
    return [...this.m.entries()]
      .map(([key, e]) => ({
        key,
        n: e.n,
        carry: rate(e.carry, e.carryN),
        kos: rate(e.kos, e.n),
        survival: rate(e.alive, e.n),
        front: rate(e.front, e.n),
        level: Math.round((e.level / Math.max(1, e.n)) * 10) / 10,
      }))
      .sort((a, b) => b.n - a.n || (a.key < b.key ? -1 : 1));
  }
}

class Groups {
  private readonly m = new Map<string, { runs: number; wins: number; resid: number }>();
  constructor(private readonly order: readonly string[]) {}
  add(group: string, wins: number, resid: number) {
    const e = this.m.get(group) ?? { runs: 0, wins: 0, resid: 0 };
    e.runs++;
    e.wins += wins;
    e.resid += resid;
    this.m.set(group, e);
  }
  list(): GroupStats[] {
    return this.order.flatMap((group) => {
      const e = this.m.get(group);
      return e ? [{ group, runs: e.runs, avgWins: rate(e.wins, e.runs), vsChampion: rate(e.resid, e.runs) }] : [];
    });
  }
}

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
    syy += (ys[i]! - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
}

const ROUND_BUCKETS: readonly [string, number, number][] = [
  ["1–3", 1, 3],
  ["4–6", 4, 6],
  ["7–9", 7, 9],
  ["10–12", 10, 12],
  ["13+", 13, Infinity],
];
const EXPERIENCE = ["first run", "2–5", "6–20", "21+"] as const;
const experienceGroup = (finishedBefore: number) => (finishedBefore === 0 ? "first run" : finishedBefore <= 4 ? "2–5" : finishedBefore <= 19 ? "6–20" : "21+");
/** Players need this many runs to count toward the consistency figure, which needs this many players. */
const CONSISTENCY_MIN_RUNS = 6;
const CONSISTENCY_MIN_PLAYERS = 5;

export interface StatsRows {
  runs: StatsRunRow[];
  battles: StatsBattleRow[];
  builds?: StatsBuildRow[];
}

/** WHERE conditions and parameters for a time column, ranked and build. */
function where(filter: StatsFilter, timeColumn: string, prefix = ""): { sql: string; params: unknown[] } {
  const params: unknown[] = [filter.since ?? 0];
  const conds = [`${prefix}${timeColumn} >= $1`];
  if (filter.until !== undefined) {
    params.push(filter.until);
    conds.push(`${prefix}${timeColumn} <= $${params.length}`);
  }
  if (filter.ranked !== undefined) {
    params.push(filter.ranked);
    conds.push(`${prefix}ranked = $${params.length}`);
  }
  if (filter.build !== undefined) {
    if (filter.build === "-") conds.push(`${prefix}build IS NULL`);
    else {
      params.push(filter.build);
      conds.push(`${prefix}build = $${params.length}`);
    }
  }
  return { sql: conds.join(" AND "), params };
}

/** The finished runs and battles the report is built from. */
export async function loadStatsRows(db: Queryable, filter: StatsFilter = {}): Promise<StatsRows> {
  const r = where(filter, "ended_at", "r.");
  const runs = await db.query<StatsRunRow>(
    `SELECT r.run_id, r.champion, r.subclass, r.wins, r.species, r.items, r.user_id, u.username, r.ranked, r.rating_after, r.ended_at, r.context
     FROM run_results r LEFT JOIN users u ON u.id = r.user_id WHERE ${r.sql} ORDER BY r.ended_at`,
    r.params,
  );
  const b = where(filter, "created_at");
  const battles = await db.query<StatsBattleRow>(
    `SELECT round, outcome, ghost, champion, opp_champion, species, items, opp_species, opp_items, detail, shop
     FROM battles WHERE ${b.sql} AND champion IS NOT NULL`,
    b.params,
  );
  const builds = await db.query<StatsBuildRow>(
    `SELECT build, MIN(t) AS first_at, MAX(t) AS last_at, SUM(runs)::int AS runs, SUM(battles)::int AS battles FROM (
       SELECT build, ended_at AS t, 1 AS runs, 0 AS battles FROM run_results
       UNION ALL SELECT build, created_at AS t, 0 AS runs, 1 AS battles FROM battles
     ) x GROUP BY build ORDER BY MIN(t)`,
  );
  return { runs, battles, builds };
}

/** Raw rows for analysis elsewhere (GET /api/admin/export, `pnpm stats --export`), oldest first. */
export async function exportRows(db: Queryable, filter: StatsFilter = {}, limit = 20000): Promise<{ runs: unknown[]; battles: unknown[] }> {
  const r = where(filter, "ended_at", "r.");
  const runs = await db.query(
    `SELECT r.*, u.username FROM run_results r LEFT JOIN users u ON u.id = r.user_id WHERE ${r.sql} ORDER BY r.ended_at LIMIT ${Math.floor(limit)}`,
    r.params,
  );
  const b = where(filter, "created_at");
  const battles = await db.query(`SELECT * FROM battles WHERE ${b.sql} ORDER BY created_at LIMIT ${Math.floor(limit)}`, b.params);
  return { runs, battles };
}

/** Loads and aggregates in one go (admin endpoint, CLI). */
export async function collectStats(db: Queryable, filter: StatsFilter = {}): Promise<StatsReport> {
  return aggregateStats(await loadStatsRows(db, filter), filter);
}

export function aggregateStats({ runs, battles, builds = [] }: StatsRows, filter: StatsFilter = {}): StatsReport {
  const minRound = filter.minRound ?? 1;

  const champ = new Map<string, ChampionStats>();
  for (const c of CHAMPION_KEYS) {
    champ.set(c, { champion: c, runs: 0, pickRate: 0, avgWins: 0, clearRate: 0, winsHistogram: Array(WINS_TO_CLEAR + 1).fill(0), battles: 0, winRate: 0, pvpBattles: 0, pvpWinRate: 0 });
  }
  const sub = new Map<string, { champion: string; runs: number; wins: number; clears: number }>();
  const species = new Tally();
  const items = new Tally();

  for (const r of runs) {
    const c = champ.get(r.champion);
    if (!c) continue;
    c.runs++;
    c.avgWins += r.wins;
    if (r.wins >= WINS_TO_CLEAR) c.clearRate++;
    c.winsHistogram[Math.min(WINS_TO_CLEAR, r.wins)]!++;
    if (r.subclass) {
      const s = sub.get(r.subclass) ?? { champion: r.champion, runs: 0, wins: 0, clears: 0 };
      s.runs++;
      s.wins += r.wins;
      if (r.wins >= WINS_TO_CLEAR) s.clears++;
      sub.set(r.subclass, s);
    }
    species.run(keys(r.species), r.wins);
    items.run(keys(r.items), r.wins);
  }

  const pvp = new Map<string, { score: number; n: number }>();
  const matchups: StatsReport["matchups"] = {};
  const cell = (a: string, b: string) => ((matchups[a] ??= {})[b] ??= { battles: 0, winRate: 0 });
  const matchScore = new Map<string, number>();
  const curve = new Map<string, { score: number; n: number }[]>();
  const perfSpecies = new PerfTally();
  const perfAbilities = new PerfTally();
  const perfItems = new PerfTally();
  let detailBattles = 0;
  const offers = new Map<string, { offered: number; bought: number; sold: number }>();
  const offer = (key: string) => {
    let e = offers.get(key);
    if (!e) offers.set(key, (e = { offered: 0, bought: 0, sold: 0 }));
    return e;
  };
  const economy = new Map<string, Omit<EconomyStats, "champion">>();
  let pvpBattles = 0;
  for (const b of battles) {
    const s = score(b.outcome);
    const c = champ.get(b.champion ?? "");
    if (c) {
      c.battles++;
      c.winRate += s;
      const buckets = curve.get(c.champion) ?? ROUND_BUCKETS.map(() => ({ score: 0, n: 0 }));
      const i = ROUND_BUCKETS.findIndex(([, lo, hi]) => b.round >= lo && b.round <= hi);
      if (i >= 0) {
        buckets[i]!.score += s;
        buckets[i]!.n++;
      }
      curve.set(c.champion, buckets);
    }
    if (b.ghost && b.opp_champion) {
      pvpBattles++;
      for (const [side, other, sc] of [
        [b.champion!, b.opp_champion, s],
        [b.opp_champion, b.champion!, 1 - s],
      ] as const) {
        const p = pvp.get(side) ?? { score: 0, n: 0 };
        p.score += sc;
        p.n++;
        pvp.set(side, p);
        cell(side, other).battles++;
        matchScore.set(`${side}|${other}`, (matchScore.get(`${side}|${other}`) ?? 0) + sc);
      }
    }

    // The shop phase belongs to the player, whatever round it was.
    const shop = parse(b.shop);
    if (shop && b.champion) {
      for (const k of shop.offered) offer(k).offered++;
      for (const k of shop.bought) offer(k).bought++;
      for (const k of shop.sold) offer(k).sold++;
      const e = economy.get(b.champion) ?? { rounds: 0, goldStart: 0, goldEnd: 0, rerolls: 0, spent: 0, sold: 0, sellGold: 0, arranged: 0 };
      e.rounds++;
      e.goldStart += shop.goldStart;
      e.goldEnd += shop.goldEnd;
      e.rerolls += shop.rerolls;
      e.spent += shop.spent;
      e.sold += shop.sold.length;
      e.sellGold += shop.sellGold;
      e.arranged += shop.arranged;
      economy.set(b.champion, e);
    }

    if (b.round < minRound) continue;
    species.battle(keys(b.species), s);
    items.battle(keys(b.items), s);
    if (b.ghost) {
      species.battle(keys(b.opp_species), 1 - s);
      items.battle(keys(b.opp_items), 1 - s);
    }
    const detail = parse(b.detail);
    if (detail) {
      detailBattles++;
      // The player's side always; the opponent's only when it was another player's ghost.
      for (const side of b.ghost ? [0, 1] : [0]) {
        const mine = detail.battlers.filter((x) => x.side === side);
        const dealt = mine.reduce((a, x) => a + x.dealt, 0);
        const average = mine.length > 0 ? dealt / mine.length : 0;
        const frontRow = Math.min(...mine.map((x) => x.row));
        for (const x of mine) {
          const entry = { carry: average > 0 ? x.dealt / average : null, kos: x.kos, alive: !x.fainted, front: x.row === frontRow, level: x.level };
          perfSpecies.add(x.species, entry);
          perfAbilities.add(x.ability, entry);
          for (const it of x.items) perfItems.add(it, entry);
        }
      }
    }
  }
  for (const [a, row] of Object.entries(matchups)) {
    for (const [b, m] of Object.entries(row)) m.winRate = rate(matchScore.get(`${a}|${b}`) ?? 0, m.battles);
  }

  const totalRuns = runs.length;
  const champions = [...champ.values()].map((c) => {
    const p = pvp.get(c.champion) ?? { score: 0, n: 0 };
    return {
      ...c,
      pickRate: rate(c.runs, totalRuns),
      avgWins: rate(c.avgWins, c.runs),
      clearRate: rate(c.clearRate, c.runs),
      winRate: rate(c.winRate, c.battles),
      pvpBattles: p.n,
      pvpWinRate: rate(p.score, p.n),
    };
  });
  const subclasses = [...sub.entries()]
    .map(([subclass, s]) => ({
      subclass,
      runs: s.runs,
      pickRate: rate(s.runs, [...sub.values()].filter((o) => o.champion === s.champion).reduce((n, o) => n + o.runs, 0)),
      avgWins: rate(s.wins, s.runs),
      clearRate: rate(s.clears, s.runs),
    }))
    .sort((a, b) => (a.subclass < b.subclass ? -1 : 1));

  // ── players, experience and how runs started: wins measured against the champion's average
  const champAvg = new Map(champions.map((c) => [c.champion, c.avgWins]));
  const resid = (r: StatsRunRow) => r.wins - (champAvg.get(r.champion) ?? 0);
  const byUser = new Map<string, StatsRunRow[]>();
  for (const r of runs) {
    const list = byUser.get(r.user_id) ?? [];
    list.push(r);
    byUser.set(r.user_id, list);
  }
  const experience = new Groups(EXPERIENCE);
  const poolStages = new Groups(["stage 0", "stage 1", "stage 2", "stage 3"]);
  const startItems = new Groups(["none", "1", "2"]);
  const players: PlayerStats[] = [];
  const odd: number[] = [];
  const even: number[] = [];
  for (const [userId, list] of byUser) {
    list.sort((a, b) => Number(a.ended_at) - Number(b.ended_at));
    list.forEach((r, i) => {
      const ctx = parse(r.context);
      experience.add(experienceGroup(ctx?.finishedRuns ?? i), r.wins, resid(r));
      if (ctx) {
        poolStages.add(`stage ${ctx.poolStage}`, r.wins, resid(r));
        startItems.add(ctx.startItems.length === 0 ? "none" : String(ctx.startItems.length), r.wins, resid(r));
      }
    });
    const counts = new Map<string, number>();
    for (const r of list) counts.set(r.champion, (counts.get(r.champion) ?? 0) + 1);
    const rankedRuns = list.filter((r) => r.ranked && r.rating_after !== null);
    players.push({
      player: list[0]!.username ?? userId,
      runs: list.length,
      avgWins: rate(list.reduce((a, r) => a + r.wins, 0), list.length),
      vsChampion: rate(list.reduce((a, r) => a + resid(r), 0), list.length),
      champions: [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([c, n]) => `${c}×${n}`)
        .join(" "),
      rating: rankedRuns.length ? Number(rankedRuns[rankedRuns.length - 1]!.rating_after) : null,
    });
    if (list.length >= CONSISTENCY_MIN_RUNS) {
      const halves = [0, 1].map((h) => list.filter((_, i) => i % 2 === h).map(resid));
      odd.push(halves[0]!.reduce((a, b) => a + b, 0) / halves[0]!.length);
      even.push(halves[1]!.reduce((a, b) => a + b, 0) / halves[1]!.length);
    }
  }
  players.sort((a, b) => b.runs - a.runs || b.vsChampion - a.vsChampion);
  const r = odd.length >= CONSISTENCY_MIN_PLAYERS ? pearson(odd, even) : null;

  return {
    generatedAt: Date.now(),
    filter,
    totals: { players: byUser.size, runs: totalRuns, battles: battles.length, pvpBattles },
    builds: builds.map((x) => ({ build: x.build ?? "-", firstAt: Number(x.first_at), lastAt: Number(x.last_at), runs: Number(x.runs), battles: Number(x.battles) })),
    champions,
    subclasses,
    matchups,
    roundCurve: [...curve.entries()].map(([champion, buckets]) => ({
      champion,
      buckets: buckets.map((x, i) => ({ rounds: ROUND_BUCKETS[i]![0], battles: x.n, winRate: rate(x.score, x.n) })),
    })),
    species: species.list(),
    items: items.list(),
    performance: { battles: detailBattles, species: perfSpecies.list(), abilities: perfAbilities.list(), items: perfItems.list() },
    offers: [...offers.entries()]
      .map(([key, e]) => ({ key, offered: e.offered, bought: e.bought, pickRate: rate(e.bought, e.offered), sold: e.sold }))
      .sort((a, b) => b.offered - a.offered || (a.key < b.key ? -1 : 1)),
    economy: [...economy.entries()].map(([champion, e]) => ({
      champion,
      rounds: e.rounds,
      goldStart: rate(e.goldStart, e.rounds),
      goldEnd: rate(e.goldEnd, e.rounds),
      rerolls: rate(e.rerolls, e.rounds),
      spent: rate(e.spent, e.rounds),
      sold: rate(e.sold, e.rounds),
      sellGold: rate(e.sellGold, e.rounds),
      arranged: rate(e.arranged, e.rounds),
    })),
    players: {
      list: players,
      // Spearman–Brown: the odd/even halves stand for all of a player's runs. No consistency at all reads 0.
      consistency: r === null ? null : { players: odd.length, r: round3(r), reliability: round3(r > 0 ? (2 * r) / (1 + r) : 0) },
    },
    experience: experience.list(),
    poolStages: poolStages.list(),
    startItems: startItems.list(),
  };
}

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
const signed = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

/** Best and worst `n` of a list already sorted best first, with a gap row between them. */
function ends<T>(list: T[], n = 25): (T | null)[] {
  return list.length > 2 * n ? [...list.slice(0, n), null, ...list.slice(-n)] : list;
}

/** The report as Markdown tables (for the CLI and `?format=md`). */
export function statsMarkdown(r: StatsReport, filter: StatsFilter = r.filter): string {
  const minSample = filter.minSample ?? 20;
  const out: string[] = [];
  const mode = filter.ranked === undefined ? "all" : filter.ranked ? "ranked" : "normal";
  out.push(`# PokéBattles balance stats`, "");
  out.push(
    `Generated ${new Date(r.generatedAt).toISOString()} · mode ${mode}` +
      (filter.since ? ` · since ${new Date(filter.since).toISOString().slice(0, 10)}` : "") +
      (filter.until ? ` · until ${new Date(filter.until).toISOString().slice(0, 10)}` : "") +
      (filter.build ? ` · build ${filter.build}` : "") +
      ` · species/items from round ${filter.minRound ?? 1}, at least ${minSample} battles`,
    "",
  );
  out.push(`Players ${r.totals.players} · finished runs ${r.totals.runs} · battles ${r.totals.battles} (vs players ${r.totals.pvpBattles})`, "");

  if (r.builds.length > 0) {
    out.push("## Builds (all data; filter with `build`)", "", "| build | first | last | runs | battles |", "|---|---|---|---|---|");
    for (const b of r.builds) out.push(`| ${b.build} | ${day(b.firstAt)} | ${day(b.lastAt)} | ${b.runs} | ${b.battles} |`);
    out.push("", "`-` = recorded before build tags (no battle detail, shop logs or run context).", "");
  }

  out.push("## Champions", "", "| champion | runs | pick | avg wins | clear | battle win | vs players | wins 0…10 |", "|---|---|---|---|---|---|---|---|");
  for (const c of [...r.champions].sort((a, b) => b.avgWins - a.avgWins)) {
    out.push(
      `| ${c.champion} | ${c.runs} | ${pct(c.pickRate)} | ${c.avgWins.toFixed(2)} | ${pct(c.clearRate)} | ${pct(c.winRate)} (${c.battles}) | ${pct(c.pvpWinRate)} (${c.pvpBattles}) | ${c.winsHistogram.join(" ")} |`,
    );
  }

  if (r.roundCurve.length > 0) {
    out.push("", "## Battle win rate by round", "", `| champion | ${ROUND_BUCKETS.map(([l]) => l).join(" | ")} |`, `|---|${ROUND_BUCKETS.map(() => "---").join("|")}|`);
    for (const c of r.roundCurve) out.push(`| ${c.champion} | ${c.buckets.map((b) => (b.battles ? `${pct(b.winRate)} (${b.battles})` : "–")).join(" | ")} |`);
  }

  out.push("", "## Subclasses", "", "| subclass | runs | pick (within champion) | avg wins | clear |", "|---|---|---|---|---|");
  for (const s of r.subclasses) out.push(`| ${s.subclass} | ${s.runs} | ${pct(s.pickRate)} | ${s.avgWins.toFixed(2)} | ${pct(s.clearRate)} |`);

  const champs = CHAMPION_KEYS.filter((c) => r.matchups[c]);
  if (champs.length > 0) {
    out.push("", "## Matchups (row's win rate vs column, battles between players)", "", `| | ${champs.join(" | ")} |`, `|---|${champs.map(() => "---").join("|")}|`);
    for (const a of champs) {
      out.push(`| ${a} | ${champs.map((b) => (r.matchups[a]?.[b] ? `${pct(r.matchups[a]![b]!.winRate)} (${r.matchups[a]![b]!.battles})` : "–")).join(" | ")} |`);
    }
  }

  if (r.economy.length > 0) {
    out.push("", "## Economy (per shop phase, from shop logs)", "", "| champion | shops | gold at start | gold left | rerolls | spent | sold (gold) | moves |", "|---|---|---|---|---|---|---|---|");
    for (const e of r.economy) {
      out.push(`| ${e.champion} | ${e.rounds} | ${e.goldStart.toFixed(1)} | ${e.goldEnd.toFixed(1)} | ${e.rerolls.toFixed(2)} | ${e.spent.toFixed(1)} | ${e.sold.toFixed(2)} (${e.sellGold.toFixed(1)}) | ${e.arranged.toFixed(1)} |`);
    }
  }

  out.push("", "## Players", "");
  const cons = r.players.consistency;
  out.push(
    cons
      ? `Consistency over ${cons.players} players with ${CONSISTENCY_MIN_RUNS}+ runs: odd vs even runs r = ${cons.r}, reliability ${cons.reliability} ` +
          "(0 = results are luck, 1 = a player's level decides; wins are measured against their champion's average)."
      : `Consistency needs at least ${CONSISTENCY_MIN_PLAYERS} players with ${CONSISTENCY_MIN_RUNS}+ runs.`,
    "",
  );
  out.push("| player | runs | avg wins | vs champion avg | champions | rating |", "|---|---|---|---|---|---|");
  for (const p of r.players.list.slice(0, 30)) out.push(`| ${p.player} | ${p.runs} | ${p.avgWins.toFixed(2)} | ${signed(p.vsChampion)} | ${p.champions} | ${p.rating ?? "–"} |`);

  for (const [title, list] of [
    ["Runs by the player's experience (runs finished before)", r.experience],
    ["Runs by pool unlock stage", r.poolStages],
    ["Runs by start items bought", r.startItems],
  ] as const) {
    if (list.length === 0) continue;
    out.push("", `## ${title}`, "", "| group | runs | avg wins | vs champion avg |", "|---|---|---|---|");
    for (const g of list) out.push(`| ${g.group} | ${g.runs} | ${g.avgWins.toFixed(2)} | ${signed(g.vsChampion)} |`);
  }

  for (const [title, list] of [
    ["Species", r.species],
    ["Items", r.items],
  ] as const) {
    const listed = list.filter((e) => e.battles >= minSample).sort((a, b) => b.winRate - a.winRate);
    out.push("", `## ${title} (${listed.length} with enough battles; best 25 and worst 25 by battle win rate)`, "");
    out.push("| key | battles | battle win | final boards | avg wins |", "|---|---|---|---|---|");
    for (const e of ends(listed)) out.push(e ? `| ${e.key} | ${e.battles} | ${pct(e.winRate)} | ${e.runs} | ${e.avgWins.toFixed(2)} |` : "| … | | | | |");
  }

  if (r.performance.battles > 0) {
    out.push(
      "",
      `## In battle (${r.performance.battles} battles with detail)`,
      "",
      "carry = damage dealt against the average teammate's (1.00 = an even share); KOs per battle; survived = still standing at the end; " +
        "front line = on the front-most row its team uses (hit first).",
    );
    for (const [title, list] of [
      ["Pokémon (starting species)", r.performance.species],
      ["Abilities", r.performance.abilities],
      ["Pokémon touching the item", r.performance.items],
    ] as const) {
      const listed = list.filter((e) => e.n >= minSample).sort((a, b) => b.carry - a.carry);
      out.push("", `### ${title}: ${listed.length} with ${minSample}+ appearances, by carry`, "");
      out.push("| key | appearances | carry | KOs | survived | front line | avg level |", "|---|---|---|---|---|---|---|");
      for (const e of ends(listed)) {
        out.push(e ? `| ${e.key} | ${e.n} | ${e.carry.toFixed(2)} | ${e.kos.toFixed(2)} | ${pct(e.survival)} | ${pct(e.front)} | ${e.level} |` : "| … | | | | | | |");
      }
    }
  }

  if (r.offers.length > 0) {
    for (const [title, prefix] of [
      ["Pokémon", "mon:"],
      ["Items and bags", ""],
    ] as const) {
      const listed = r.offers
        .filter((o) => (prefix ? o.key.startsWith(prefix) : !o.key.startsWith("mon:")) && o.offered >= minSample)
        .sort((a, b) => b.pickRate - a.pickRate);
      out.push("", `## Shop pick rate: ${title} (${listed.length} shown ${minSample}+ times)`, "", "| key | shown | bought | pick rate | sold |", "|---|---|---|---|---|");
      for (const o of ends(listed)) out.push(o ? `| ${o.key} | ${o.offered} | ${o.bought} | ${pct(o.pickRate)} | ${o.sold} |` : "| … | | | | |");
    }
  }
  return out.join("\n") + "\n";
}
