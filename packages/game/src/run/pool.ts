import { CHAMPIONS, isLanceKin, type ChampionKey } from "../content/champions.ts";
import { CONTENT, getSpecies, type Tier } from "../content/index.ts";

const TIERS: Tier[] = [1, 2, 3, 4, 5];

/**
 * Whose pool: a champion (the full pool), or a run whose player has not unlocked every line of it yet.
 * `lockedLines` holds first stages of evolution lines (lineBase) kept out of this run's shop.
 */
export type PoolKey = ChampionKey | { champion: ChampionKey; lockedLines?: readonly string[] };

interface PoolData {
  all: Set<string>;
  byTier: Record<Tier, string[]>;
}

const pools = new Map<string, PoolData>();

function keyOf(key: PoolKey): { champion: ChampionKey; locked: readonly string[]; id: string } {
  if (typeof key === "string") return { champion: key, locked: [], id: key };
  const locked = key.lockedLines ?? [];
  return { champion: key.champion, locked, id: locked.length ? `${key.champion}|${[...locked].sort().join(",")}` : key.champion };
}

/** First stage of a Pokémon's evolution line (within the roster). */
export function lineBase(key: string): string {
  let cur = key;
  for (let prevo = getSpecies(cur).prevo; prevo; prevo = getSpecies(cur).prevo) cur = prevo;
  return cur;
}

function buildPool(champion: ChampionKey, locked: ReadonlySet<string>): PoolData {
  const def = CHAMPIONS[champion];
  const all = new Set<string>();
  for (const s of Object.values(CONTENT.species)) if (s.generation === def.generation) all.add(s.key);
  // The squad's whole line (Charmander → Charmeleon → Charizard for Leon), whatever its generation.
  for (const key of def.squad) {
    for (let cur: string | null = key; cur; cur = getSpecies(cur).prevo) all.add(cur);
  }
  if (locked.size > 0) for (const key of [...all]) if (locked.has(lineBase(key))) all.delete(key);
  const byTier: Record<Tier, string[]> = { 1: [], 2: [], 3: [], 4: [], 5: [] };
  const sorted = [...all].map(getSpecies).sort((a, b) => a.id - b.id || (a.key < b.key ? -1 : 1));
  for (const s of sorted) if (s.shop) byTier[s.tier].push(s.key);
  return { all, byTier };
}

function pool(key: PoolKey): PoolData {
  const { champion, locked, id } = keyOf(key);
  let p = pools.get(id);
  if (!p) {
    p = buildPool(champion, new Set(locked));
    pools.set(id, p);
  }
  return p;
}

/**
 * Species a champion's shop, Poké Balls and Vouchers can offer: every Pokémon of the champion's
 * generation plus the evolution lines of their real squad (Leon's Charizard, Diantha's Gardevoir…),
 * minus the lines a run's player has not unlocked yet.
 * Evolutions are never restricted, so a pool member can still evolve into another generation.
 */
export function championPool(key: PoolKey): ReadonlySet<string> {
  return pool(key).all;
}

const reaches = new Map<string, Set<string>>();

/** Every species a champion's run can hold: the pool plus whatever its members evolve into (or spawn). */
export function championReach(key: PoolKey): ReadonlySet<string> {
  const { id } = keyOf(key);
  let out = reaches.get(id);
  if (!out) {
    out = new Set();
    const queue = [...pool(key).all];
    while (queue.length > 0) {
      const k = queue.pop()!;
      const s = CONTENT.species[k];
      if (!s || out.has(k)) continue;
      out.add(k);
      for (const e of s.evolutions) queue.push(e.to, ...(e.spawn ? [e.spawn] : []));
    }
    reaches.set(id, out);
  }
  return out;
}

/** Shop-eligible pool species of one tier; falls back to the nearest tier that has any. */
export function championSpeciesOfTier(key: PoolKey, tier: Tier): { tier: Tier; species: string[] } {
  const { byTier } = pool(key);
  const order = [...TIERS].sort((a, b) => Math.abs(a - tier) - Math.abs(b - tier) || a - b);
  for (const t of order) if (byTier[t].length > 0) return { tier: t, species: byTier[t] };
  return { tier, species: [] };
}

const lanceLines = new Map<string, boolean>();

/**
 * Lance's shop and evolution perks cover whole lines that grow into Dragon or Flying types
 * (Charmander → Charizard, Horsea → Kingdra, Magikarp → Gyarados), not only the ones that already are.
 */
export function isLanceKinLine(key: string): boolean {
  let kin = lanceLines.get(key);
  if (kin === undefined) {
    const s = getSpecies(key);
    kin = isLanceKin(s.types) || s.evolutions.some((e) => isLanceKinLine(e.to));
    lanceLines.set(key, kin);
  }
  return kin;
}

export function championSpeciesByTier(key: PoolKey): Readonly<Record<Tier, string[]>> {
  return pool(key).byTier;
}

// ───────────────────────────── unlocking a champion's pool

/**
 * Finished runs with a champion that open each stage of their shop pool. Stage 0 (a new player)
 * is the champion's real squad and starter lines, its counter lines (COUNTER_LINES) and a quarter of the rest;
 * after 6 runs the pool is full.
 */
export const POOL_UNLOCK_RUNS: readonly number[] = [0, 2, 4, 6];

const stageCache = new Map<ChampionKey, string[][]>();

/**
 * Lines every stage-0 pool has, because without them a new player of the champion has nothing that beats another
 * champion's signature type (checked 2026-09-28): Lance against Red's Electric (Phanpy) and Diantha's Fairy
 * (Skarmory), Kukui against Red (Mudbray), Diantha against Red (Bunnelby, added to the roster for this).
 */
export const COUNTER_LINES: Partial<Record<ChampionKey, readonly string[]>> = {
  lance: ["PHANPY", "SKARMORY"],
  kukui: ["MUDBRAY"],
  diantha: ["BUNNELBY"],
};

/**
 * Lines added to the roster after the stages were first dealt. They take no turn in the dealing, so adding them
 * moves no other line to another stage (a player's unlocked lines stay the same).
 */
const LINES_ADDED_LATER: ReadonlySet<string> = new Set(["BUNNELBY"]);

/**
 * Evolution lines (by first stage) that each unlock stage adds to a champion's pool. The lines that
 * are not the squad's are sorted by their highest shop tier and dealt out in turn, so every stage
 * brings a mix of early and late Pokémon; legendaries (and sub-legendaries) are dealt from the last stage back.
 */
export function poolUnlockStages(champion: ChampionKey): readonly (readonly string[])[] {
  let stages = stageCache.get(champion);
  if (!stages) {
    const def = CHAMPIONS[champion];
    const lines = new Map<string, { tier: number; id: number; legend: boolean }>();
    for (const key of championPool(champion)) {
      const base = lineBase(key);
      const line = lines.get(base) ?? { tier: 0, id: getSpecies(base).id, legend: false };
      const s = getSpecies(key);
      if (s.shop) line.tier = Math.max(line.tier, s.tier);
      if (s.legendary || s.mythical || s.subLegendary) line.legend = true;
      lines.set(base, line);
    }
    const core = new Set([def.starter.species, ...def.squad].map(lineBase).filter((k) => lines.has(k)));
    const rest = [...lines.keys()]
      .filter((k) => !core.has(k))
      .sort((a, b) => lines.get(a)!.tier - lines.get(b)!.tier || lines.get(a)!.id - lines.get(b)!.id || (a < b ? -1 : 1));
    stages = POOL_UNLOCK_RUNS.map(() => [] as string[]);
    const n = stages.length;
    stages[0]!.push(...[...core].sort((a, b) => lines.get(a)!.id - lines.get(b)!.id));
    // Legendary lines are never in the starting pool; the last stage gets the first one.
    const dealt = rest.filter((k) => !LINES_ADDED_LATER.has(k));
    const legends = dealt.filter((k) => lines.get(k)!.legend);
    dealt.filter((k) => !lines.get(k)!.legend).forEach((k, i) => stages![i % n]!.push(k));
    legends.forEach((k, i) => stages![n > 1 ? n - 1 - (i % (n - 1)) : 0]!.push(k));
    // Counter lines move to stage 0 from wherever the dealing put them, so the other lines keep their stage.
    const counters = new Set((COUNTER_LINES[champion] ?? []).filter((k) => lines.has(k)));
    for (const stage of stages) for (let i = stage.length - 1; i >= 0; i--) if (counters.has(stage[i]!)) stage.splice(i, 1);
    stages[0]!.push(...[...counters].sort((a, b) => lines.get(a)!.id - lines.get(b)!.id));
    // A later line that counters nothing goes to the last stage (the reward end).
    stages[n - 1]!.push(...rest.filter((k) => LINES_ADDED_LATER.has(k) && !counters.has(k)));
    stageCache.set(champion, stages);
  }
  return stages;
}

/** Stage of a champion's pool opened after `runs` finished runs with them. */
export function poolStageFor(runs: number): number {
  let stage = 0;
  POOL_UNLOCK_RUNS.forEach((need, i) => {
    if (runs >= need) stage = i;
  });
  return stage;
}

/** Lines still locked at `stage` (empty once the pool is full). */
export function lockedLinesAt(champion: ChampionKey, stage: number): string[] {
  return poolUnlockStages(champion).slice(stage + 1).flat();
}

/** Pool species one stage adds, in dex order (for "newly unlocked" lists). */
export function speciesOfStage(champion: ChampionKey, stage: number): string[] {
  const lines = new Set(poolUnlockStages(champion)[stage] ?? []);
  return [...championPool(champion)]
    .filter((k) => lines.has(lineBase(k)))
    .map(getSpecies)
    .sort((a, b) => a.id - b.id || (a.key < b.key ? -1 : 1))
    .map((s) => s.key);
}
