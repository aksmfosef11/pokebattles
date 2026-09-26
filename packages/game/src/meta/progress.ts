/**
 * Account progression outside a run (docs/DESIGN.md §9): champion points, buying champions,
 * unlocking each champion's shop Pokémon by playing them, and the ranked rating.
 * Pure functions; the server (PostgreSQL) and the offline client (localStorage) store the Profile.
 */
import { CHAMPION_KEYS, type ChampionKey } from "../content/champions.ts";
import { lockedLinesAt, POOL_UNLOCK_RUNS, poolStageFor, speciesOfStage } from "../run/pool.ts";
import { WINS_TO_CLEAR } from "../run/shop.ts";
import { GameError, type RoundLog, type RunState } from "../run/types.ts";

export interface Profile {
  /** Earned by every finished run, spent on champions. */
  points: number;
  /** Champions this player can start runs with. The first one is free. */
  champions: ChampionKey[];
  /** Finished runs per champion; they open that champion's shop pool in stages (POOL_UNLOCK_RUNS). */
  runs: Partial<Record<ChampionKey, number>>;
  rating: number;
  rankedRuns: number;
}

export const META_RULES = {
  championPrice: 120,
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
  return { points: 0, champions: [], runs: {}, rating: META_RULES.startRating, rankedRuns: 0 };
}

/** Fills in fields missing from a stored profile (older saves, hand-edited rows). */
export function normalizeProfile(input: Partial<Profile> | null | undefined): Profile {
  const base = newProfile();
  if (!input || typeof input !== "object") return base;
  const champions = Array.isArray(input.champions) ? input.champions.filter((c) => CHAMPION_KEYS.includes(c)) : [];
  const runs: Profile["runs"] = {};
  for (const c of CHAMPION_KEYS) {
    const n = input.runs?.[c];
    if (typeof n === "number" && n > 0) runs[c] = Math.floor(n);
  }
  return {
    points: typeof input.points === "number" ? Math.max(0, Math.floor(input.points)) : base.points,
    champions: [...new Set(champions)],
    runs,
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

export function poolStage(profile: Profile, champion: ChampionKey): number {
  return poolStageFor(championRuns(profile, champion));
}

/** The next stage of a champion's pool: how many more runs it takes and what it adds. */
export function nextPoolUnlock(profile: Profile, champion: ChampionKey): { runsLeft: number; species: string[] } | null {
  const stage = poolStage(profile, champion);
  const need = POOL_UNLOCK_RUNS[stage + 1];
  if (need === undefined) return null;
  return { runsLeft: need - championRuns(profile, champion), species: speciesOfStage(champion, stage + 1) };
}

/** What a new run with this champion starts with; throws unless the player owns the champion. */
export function runOptionsFor(profile: Profile, champion: unknown): { champion: ChampionKey; lockedLines: string[] } {
  const key = requireChampion(champion);
  if (!profile.champions.includes(key)) throw new GameError("champion_locked");
  return { champion: key, lockedLines: lockedLinesAt(key, poolStage(profile, key)) };
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
