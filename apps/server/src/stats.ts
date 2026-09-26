import { CHAMPION_KEYS, WINS_TO_CLEAR } from "@pokebattles/game";
import type { Queryable } from "./db.ts";

/**
 * Balance statistics from what players actually did (docs/DESIGN.md §9): finished runs (run_results)
 * and every battle (battles). Bot opponents are left out of per-team numbers because a bot's team is
 * not a player's choice; they still count toward a player's own battle win rate.
 */
export interface StatsFilter {
  /** Only data from this time on (ms since epoch). */
  since?: number;
  /** true: ranked only, false: normal only, undefined: both. */
  ranked?: boolean;
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

export interface StatsReport {
  generatedAt: number;
  filter: StatsFilter;
  totals: { players: number; runs: number; battles: number; pvpBattles: number };
  champions: ChampionStats[];
  subclasses: { subclass: string; runs: number; pickRate: number; avgWins: number; clearRate: number }[];
  /** matchups[a][b]: a's win rate against b in battles between players. */
  matchups: Record<string, Record<string, { battles: number; winRate: number }>>;
  species: EntryStats[];
  items: EntryStats[];
}

/** Species/item key lists: JSONB arrays (already parsed by the driver), or JSON text. */
type KeyList = string[] | string | null;

export interface StatsRunRow {
  champion: string;
  subclass: string | null;
  wins: number;
  species: KeyList;
  items: KeyList;
  user_id: string;
}

export interface StatsBattleRow {
  round: number;
  outcome: string;
  ghost: boolean | number;
  champion: string | null;
  opp_champion: string | null;
  species: KeyList;
  items: KeyList;
  opp_species: KeyList;
  opp_items: KeyList;
}

export interface StatsRows {
  runs: StatsRunRow[];
  battles: StatsBattleRow[];
}

const score = (outcome: string) => (outcome === "win" ? 1 : outcome === "draw" ? 0.5 : 0);
const rate = (sum: number, n: number) => (n > 0 ? Math.round((sum / n) * 1000) / 1000 : 0);
const parse = (list: KeyList): string[] => {
  if (Array.isArray(list)) return list;
  try {
    return list ? (JSON.parse(list) as string[]) : [];
  } catch {
    return [];
  }
};

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

/** The finished runs and battles the report is built from. */
export async function loadStatsRows(db: Queryable, filter: StatsFilter = {}): Promise<StatsRows> {
  const params: unknown[] = [filter.since ?? 0];
  if (filter.ranked !== undefined) params.push(filter.ranked);
  const rankedSql = filter.ranked === undefined ? "" : " AND ranked = $2";
  const runs = await db.query<StatsRunRow>(`SELECT champion, subclass, wins, species, items, user_id FROM run_results WHERE ended_at >= $1${rankedSql}`, params);
  const battles = await db.query<StatsBattleRow>(
    `SELECT round, outcome, ghost, champion, opp_champion, species, items, opp_species, opp_items
     FROM battles WHERE created_at >= $1 AND champion IS NOT NULL${rankedSql}`,
    params,
  );
  return { runs, battles };
}

/** Loads and aggregates in one go (admin endpoint, CLI). */
export async function collectStats(db: Queryable, filter: StatsFilter = {}): Promise<StatsReport> {
  return aggregateStats(await loadStatsRows(db, filter), filter);
}

export function aggregateStats({ runs, battles }: StatsRows, filter: StatsFilter = {}): StatsReport {
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
    species.run(parse(r.species), r.wins);
    items.run(parse(r.items), r.wins);
  }

  const pvp = new Map<string, { score: number; n: number }>();
  const matchups: StatsReport["matchups"] = {};
  const cell = (a: string, b: string) => ((matchups[a] ??= {})[b] ??= { battles: 0, winRate: 0 });
  const matchScore = new Map<string, number>();
  let pvpBattles = 0;
  for (const b of battles) {
    const s = score(b.outcome);
    const c = champ.get(b.champion ?? "");
    if (c) {
      c.battles++;
      c.winRate += s;
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
    if (b.round < minRound) continue;
    species.battle(parse(b.species), s);
    items.battle(parse(b.items), s);
    if (b.ghost) {
      species.battle(parse(b.opp_species), 1 - s);
      items.battle(parse(b.opp_items), 1 - s);
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

  return {
    generatedAt: Date.now(),
    filter,
    totals: { players: new Set(runs.map((r) => r.user_id)).size, runs: totalRuns, battles: battles.length, pvpBattles },
    champions,
    subclasses,
    matchups,
    species: species.list(),
    items: items.list(),
  };
}

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;

/** The report as Markdown tables (for the CLI and `?format=md`). */
export function statsMarkdown(r: StatsReport, filter: StatsFilter = r.filter): string {
  const minSample = filter.minSample ?? 20;
  const out: string[] = [];
  const mode = filter.ranked === undefined ? "all" : filter.ranked ? "ranked" : "normal";
  out.push(`# PokéBattles balance stats`, "");
  out.push(
    `Generated ${new Date(r.generatedAt).toISOString()} · mode ${mode}` +
      (filter.since ? ` · since ${new Date(filter.since).toISOString().slice(0, 10)}` : "") +
      ` · species/items from round ${filter.minRound ?? 1}, at least ${minSample} battles`,
    "",
  );
  out.push(`Players ${r.totals.players} · finished runs ${r.totals.runs} · battles ${r.totals.battles} (vs players ${r.totals.pvpBattles})`, "");

  out.push("## Champions", "", "| champion | runs | pick | avg wins | clear | battle win | vs players | wins 0…10 |", "|---|---|---|---|---|---|---|---|");
  for (const c of [...r.champions].sort((a, b) => b.avgWins - a.avgWins)) {
    out.push(
      `| ${c.champion} | ${c.runs} | ${pct(c.pickRate)} | ${c.avgWins.toFixed(2)} | ${pct(c.clearRate)} | ${pct(c.winRate)} (${c.battles}) | ${pct(c.pvpWinRate)} (${c.pvpBattles}) | ${c.winsHistogram.join(" ")} |`,
    );
  }

  out.push("", "## Subclasses", "", "| subclass | runs | pick (within champion) | avg wins | clear |", "|---|---|---|---|---|");
  for (const s of r.subclasses) out.push(`| ${s.subclass} | ${s.runs} | ${pct(s.pickRate)} | ${s.avgWins.toFixed(2)} | ${pct(s.clearRate)} |`);

  const keys = CHAMPION_KEYS.filter((c) => r.matchups[c]);
  if (keys.length > 0) {
    out.push("", "## Matchups (row's win rate vs column, battles between players)", "", `| | ${keys.join(" | ")} |`, `|---|${keys.map(() => "---").join("|")}|`);
    for (const a of keys) {
      out.push(`| ${a} | ${keys.map((b) => (r.matchups[a]?.[b] ? `${pct(r.matchups[a]![b]!.winRate)} (${r.matchups[a]![b]!.battles})` : "–")).join(" | ")} |`);
    }
  }

  for (const [title, list] of [
    ["Species", r.species],
    ["Items", r.items],
  ] as const) {
    const listed = list.filter((e) => e.battles >= minSample).sort((a, b) => b.winRate - a.winRate);
    out.push("", `## ${title} (${listed.length} with enough battles; best 25 and worst 25 by battle win rate)`, "");
    out.push("| key | battles | battle win | final boards | avg wins |", "|---|---|---|---|---|");
    const shown = listed.length > 50 ? [...listed.slice(0, 25), null, ...listed.slice(-25)] : listed;
    for (const e of shown) {
      out.push(e ? `| ${e.key} | ${e.battles} | ${pct(e.winRate)} | ${e.runs} | ${e.avgWins.toFixed(2)} |` : "| … | | | | |");
    }
  }
  return out.join("\n") + "\n";
}
