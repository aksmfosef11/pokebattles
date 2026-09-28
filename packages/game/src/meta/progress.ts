/**
 * Account progression outside a run (docs/DESIGN.md §8): champion points, buying champions,
 * unlocking each champion's shop Pokémon by playing them (or with points), training their starters,
 * start-of-run items, and the ranked rating.
 * Pure functions; the server (PostgreSQL) and the offline client (localStorage) store the Profile.
 */
import { CHAMPION_KEYS, CHAMPIONS, type ChampionKey } from "../content/champions.ts";
import { STAT_KEYS, type Stats } from "../content/schema.ts";
import type { Rng } from "../rng.ts";
import { abilityOptions, MAX_IV, type StarterSetup } from "../run/pokemon.ts";
import { lockedLinesAt, POOL_UNLOCK_RUNS, poolStageFor, speciesOfStage } from "../run/pool.ts";
import { START_ITEMS, type StartItem } from "../run/reducer.ts";
import { WINS_TO_CLEAR } from "../run/shop.ts";
import { GameError, type RoundLog, type RunState } from "../run/types.ts";
import { NATURES, type Nature } from "../stats.ts";

/** The latest nature or ability draw for a starter, waiting for the player to keep it or let it go. */
export type StarterDraw = { kind: "nature"; nature: Nature } | { kind: "ability"; ability: string; hidden: boolean };

/**
 * A champion's starter Pokémon as trained with points. What is not kept is rolled every run, as for
 * anyone else; the IV bonus is added to each run's rolled IVs.
 */
export interface StarterTraining extends StarterSetup {
  draw?: StarterDraw;
}

export interface Profile {
  /** Earned by every finished run, spent on champions, pool stages, starter training and start items. */
  points: number;
  /** Champions this player can start runs with. The first one is free. */
  champions: ChampionKey[];
  /** Finished runs per champion; they open that champion's shop pool in stages (POOL_UNLOCK_RUNS). */
  runs: Partial<Record<ChampionKey, number>>;
  /** Pool stages bought with points per champion; each one keeps that champion's pool a stage ahead of their runs. */
  poolBought: Partial<Record<ChampionKey, number>>;
  starters: Partial<Record<ChampionKey, StarterTraining>>;
  rating: number;
  rankedRuns: number;
}

export const META_RULES = {
  championPrice: 120,
  /** One stage of a champion's shop pool (POOL_UNLOCK_RUNS), for players with points but no wish to replay them. */
  poolStagePrice: 60,
  /**
   * Starter training, per champion: a random nature or ability (other than the kept one) that the
   * player keeps or not, or +1 IV bonus on a random stat below the cap. Small and capped on purpose.
   */
  natureDrawPrice: 60,
  abilityDrawPrice: 80,
  ivPointPrice: 25,
  /** Each start-of-run item (START_ITEMS), at most one of each per run. */
  startItemPrice: 40,
  pointsPerBattle: 2,
  pointsPerWin: 4,
  clearBonus: 20,
  /** Also the strength of a plain bot run, which anchors the scale (server/bot.ts BOT_RATINGS). */
  startRating: 1000,
  /** Elo K per ranked battle; a run's battles are settled together when it ends. */
  ratingK: 16,
  /** Ranked runs meet ghosts saved within this many rating points of theirs, else a bot of about their rating. */
  ratingWindow: 300,
} as const;

/** Rank badges by rating, named after real Poké Balls (names and icons come from the item locale). */
export const RANK_TIERS: readonly { min: number; item: string }[] = [
  { min: 1400, item: "MASTER_BALL" },
  { min: 1250, item: "ULTRA_BALL" },
  { min: 1100, item: "GREAT_BALL" },
  { min: 0, item: "POKE_BALL" },
];

export function newProfile(): Profile {
  return { points: 0, champions: [], runs: {}, poolBought: {}, starters: {}, rating: META_RULES.startRating, rankedRuns: 0 };
}

function normalizeTraining(input: unknown): StarterTraining | null {
  if (!input || typeof input !== "object") return null;
  const t = input as Record<string, unknown>;
  const out: StarterTraining = {};
  if (NATURES.includes(t.nature as Nature)) out.nature = t.nature as Nature;
  const kept = t.ability as Record<string, unknown> | undefined;
  if (kept && typeof kept.ability === "string") out.ability = { ability: kept.ability, hidden: kept.hidden === true };
  const bonus: Partial<Stats> = {};
  for (const k of STAT_KEYS) {
    const v = (t.ivBonus as Record<string, unknown> | undefined)?.[k];
    if (typeof v === "number" && v >= 1) bonus[k] = Math.min(MAX_IV, Math.floor(v));
  }
  if (Object.keys(bonus).length > 0) out.ivBonus = bonus;
  const d = t.draw as Record<string, unknown> | undefined;
  if (d?.kind === "nature" && NATURES.includes(d.nature as Nature)) out.draw = { kind: "nature", nature: d.nature as Nature };
  else if (d?.kind === "ability" && typeof d.ability === "string") out.draw = { kind: "ability", ability: d.ability, hidden: d.hidden === true };
  return Object.keys(out).length > 0 ? out : null;
}

/** Fills in fields missing from a stored profile (older saves, hand-edited rows). */
export function normalizeProfile(input: Partial<Profile> | null | undefined): Profile {
  const base = newProfile();
  if (!input || typeof input !== "object") return base;
  const champions = Array.isArray(input.champions) ? input.champions.filter((c) => CHAMPION_KEYS.includes(c)) : [];
  const runs: Profile["runs"] = {};
  const poolBought: Profile["poolBought"] = {};
  const starters: Profile["starters"] = {};
  for (const c of CHAMPION_KEYS) {
    const training = normalizeTraining(input.starters?.[c]);
    if (training) starters[c] = training;
    const n = input.runs?.[c];
    if (typeof n === "number" && n > 0) runs[c] = Math.floor(n);
    const b = input.poolBought?.[c];
    if (typeof b === "number" && b >= 1) poolBought[c] = Math.min(POOL_UNLOCK_RUNS.length - 1, Math.floor(b));
  }
  return {
    points: typeof input.points === "number" ? Math.max(0, Math.floor(input.points)) : base.points,
    champions: [...new Set(champions)],
    runs,
    poolBought,
    starters,
    rating: typeof input.rating === "number" ? Math.max(0, Math.round(input.rating)) : base.rating,
    rankedRuns: typeof input.rankedRuns === "number" ? Math.max(0, Math.floor(input.rankedRuns)) : 0,
  };
}

function requireChampion(champion: unknown): ChampionKey {
  if (typeof champion !== "string" || !CHAMPION_KEYS.includes(champion as ChampionKey)) throw new GameError("invalid_champion");
  return champion as ChampionKey;
}

/** A new player's free first champion. */
export function chooseStarter(profile: Profile, champion: unknown): Profile {
  const key = requireChampion(champion);
  if (profile.champions.length > 0) throw new GameError("starter_chosen");
  return { ...profile, champions: [key] };
}

export function buyChampion(profile: Profile, champion: unknown): Profile {
  const key = requireChampion(champion);
  if (profile.champions.length === 0) throw new GameError("starter_first");
  if (profile.champions.includes(key)) throw new GameError("champion_owned");
  if (profile.points < META_RULES.championPrice) throw new GameError("not_enough_points");
  return { ...profile, points: profile.points - META_RULES.championPrice, champions: [...profile.champions, key] };
}

export function championRuns(profile: Profile, champion: ChampionKey): number {
  return profile.runs[champion] ?? 0;
}

const LAST_POOL_STAGE = POOL_UNLOCK_RUNS.length - 1;

/** Stage of a champion's pool: what their finished runs opened, plus the stages bought with points. */
export function poolStage(profile: Profile, champion: ChampionKey): number {
  return Math.min(LAST_POOL_STAGE, poolStageFor(championRuns(profile, champion)) + (profile.poolBought[champion] ?? 0));
}

/** The next stage of a champion's pool: how many more runs it takes (or its point price) and what it adds. */
export function nextPoolUnlock(profile: Profile, champion: ChampionKey): { runsLeft: number; species: string[] } | null {
  const stage = poolStage(profile, champion);
  if (stage >= LAST_POOL_STAGE) return null;
  // Bought stages sit on top of the ones runs open, so the next one comes with the runs of an earlier run stage.
  const need = POOL_UNLOCK_RUNS[stage + 1 - (profile.poolBought[champion] ?? 0)]!;
  return { runsLeft: need - championRuns(profile, champion), species: speciesOfStage(champion, stage + 1) };
}

/** Opens the next stage of an owned champion's pool for points; later runs keep opening stages on top of it. */
export function buyPoolStage(profile: Profile, champion: unknown): Profile {
  const key = requireOwned(profile, champion);
  if (poolStage(profile, key) >= LAST_POOL_STAGE) throw new GameError("pool_full");
  const paid = pay(profile, META_RULES.poolStagePrice);
  return { ...paid, poolBought: { ...paid.poolBought, [key]: (paid.poolBought[key] ?? 0) + 1 } };
}

function requireOwned(profile: Profile, champion: unknown): ChampionKey {
  const key = requireChampion(champion);
  if (!profile.champions.includes(key)) throw new GameError("champion_locked");
  return key;
}

function pay(profile: Profile, price: number): Profile {
  if (profile.points < price) throw new GameError("not_enough_points");
  return { ...profile, points: profile.points - price };
}

export function starterTraining(profile: Profile, champion: ChampionKey): StarterTraining {
  return profile.starters[champion] ?? {};
}

function withTraining(profile: Profile, champion: ChampionKey, training: StarterTraining): Profile {
  return { ...profile, starters: { ...profile.starters, [champion]: training } };
}

/** What a run uses of the training: the kept nature and ability and the IV bonus (not a waiting draw). */
export function starterSetup(profile: Profile, champion: ChampionKey): StarterSetup {
  const { draw: _draw, ...setup } = starterTraining(profile, champion);
  return setup;
}

export type StarterTrainingKind = "nature" | "ability" | "iv";

/**
 * Spends points on an owned champion's starter: a nature or ability draw (a random one other than the
 * kept one, which the player then keeps or lets go with keepStarterDraw; a new draw replaces one still
 * waiting), or +1 IV bonus on a random stat still below MAX_IV. The server passes an unseeded rng.
 */
export function trainStarter(profile: Profile, champion: unknown, kind: unknown, rng: Rng): Profile {
  const key = requireOwned(profile, champion);
  const t = starterTraining(profile, key);
  switch (kind) {
    case "nature": {
      const paid = pay(profile, META_RULES.natureDrawPrice);
      return withTraining(paid, key, { ...t, draw: { kind: "nature", nature: rng.pick(NATURES.filter((n) => n !== t.nature)) } });
    }
    case "ability": {
      const kept = t.ability;
      const options = abilityOptions(CHAMPIONS[key].starter.species).filter((o) => !(kept && o.ability === kept.ability && o.hidden === kept.hidden));
      if (options.length === 0) throw new GameError("nothing_to_draw");
      const paid = pay(profile, META_RULES.abilityDrawPrice);
      const pick = rng.pick(options);
      return withTraining(paid, key, { ...t, draw: { kind: "ability", ability: pick.ability, hidden: pick.hidden } });
    }
    case "iv": {
      const open = STAT_KEYS.filter((k) => (t.ivBonus?.[k] ?? 0) < MAX_IV);
      if (open.length === 0) throw new GameError("iv_maxed");
      const paid = pay(profile, META_RULES.ivPointPrice);
      const stat = rng.pick(open);
      return withTraining(paid, key, { ...t, ivBonus: { ...t.ivBonus, [stat]: (t.ivBonus?.[stat] ?? 0) + 1 } });
    }
    default:
      throw new GameError("bad_action");
  }
}

/** Keeps the waiting draw (replacing the kept nature or ability) or lets it go. */
export function keepStarterDraw(profile: Profile, champion: unknown, keep: unknown): Profile {
  const key = requireOwned(profile, champion);
  const { draw, ...rest } = starterTraining(profile, key);
  if (!draw) throw new GameError("no_draw");
  if (keep !== true) return withTraining(profile, key, rest);
  if (draw.kind === "nature") return withTraining(profile, key, { ...rest, nature: draw.nature });
  return withTraining(profile, key, { ...rest, ability: { ability: draw.ability, hidden: draw.hidden } });
}

/** A run's start items as sent by a client: distinct START_ITEMS, or nothing. */
export function readStartItems(input: unknown): StartItem[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new GameError("bad_action");
  const out: StartItem[] = [];
  for (const k of input) {
    if (!START_ITEMS.includes(k) || out.includes(k)) throw new GameError("bad_action");
    out.push(k);
  }
  return out;
}

export function payStartItems(profile: Profile, items: readonly StartItem[]): Profile {
  return items.length > 0 ? pay(profile, items.length * META_RULES.startItemPrice) : profile;
}

/** What a new run with this champion starts with; throws unless the player owns the champion. */
export function runOptionsFor(profile: Profile, champion: unknown): { champion: ChampionKey; lockedLines: string[]; starter: StarterSetup } {
  const key = requireOwned(profile, champion);
  return { champion: key, lockedLines: lockedLinesAt(key, poolStage(profile, key)), starter: starterSetup(profile, key) };
}

/** Champion points for a finished run: something for every battle, more for wins, a bonus for the trophy. */
export function runPoints(state: RunState): number {
  const cleared = state.wins >= WINS_TO_CLEAR;
  return state.log.length * META_RULES.pointsPerBattle + state.wins * META_RULES.pointsPerWin + (cleared ? META_RULES.clearBonus : 0);
}

/** Elo win expectancy of `rating` against `opponent`. */
export function expectedScore(rating: number, opponent: number): number {
  return 1 / (1 + 10 ** ((opponent - rating) / 400));
}

/**
 * Rating change of a ranked run: each battle is an Elo game against the opponent's rating (the ghost
 * owner's when it was saved, or the bot's measured strength), so beating bots below you gains little.
 * Battles logged without an opponent rating count as even.
 */
export function rankedDelta(rating: number, log: readonly RoundLog[]): number {
  let sum = 0;
  for (const l of log) {
    const score = l.outcome === "win" ? 1 : l.outcome === "draw" ? 0.5 : 0;
    sum += score - expectedScore(rating, l.opponent.rating ?? rating);
  }
  return Math.round(META_RULES.ratingK * sum);
}

export function rankTier(rating: number): string {
  return (RANK_TIERS.find((t) => rating >= t.min) ?? RANK_TIERS[RANK_TIERS.length - 1]!).item;
}

export interface RunReward {
  points: number;
  totalPoints: number;
  rating: { before: number; after: number } | null;
  /** Shop Pokémon this run unlocked for its champion. */
  unlocked: string[];
  /** Finished runs with this champion, this one included. */
  championRuns: number;
}

/** Applies a finished run to the player's profile. Call exactly once per run (the stores guard this by run id). */
export function settleRun(profile: Profile, state: RunState): { profile: Profile; reward: RunReward } {
  if (state.phase !== "ended") throw new GameError("run_not_ended");
  const points = runPoints(state);
  const before = poolStage(profile, state.champion);
  const runs = championRuns(profile, state.champion) + 1;
  const next: Profile = { ...profile, points: profile.points + points, runs: { ...profile.runs, [state.champion]: runs } };
  let rating: RunReward["rating"] = null;
  if (state.ranked) {
    const after = Math.max(0, profile.rating + rankedDelta(profile.rating, state.log));
    rating = { before: profile.rating, after };
    next.rating = after;
    next.rankedRuns = profile.rankedRuns + 1;
  }
  const unlocked: string[] = [];
  for (let stage = before + 1; stage <= poolStage(next, state.champion); stage++) unlocked.push(...speciesOfStage(state.champion, stage));
  return { profile: next, reward: { points, totalPoints: next.points, rating, unlocked, championRuns: runs } };
}
