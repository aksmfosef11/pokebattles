import { inBoard } from "../board.ts";
import { battleLog, type BattleLog } from "../battle/log.ts";
import { simulateBattle } from "../battle/sim.ts";
import { CHAMPIONS, type ChampionKey } from "../content/champions.ts";
import { randomSeed, rngFor } from "../rng.ts";
import { cellsOf } from "../run/layout.ts";
import { migrateRun } from "../run/migrate.ts";
import { applyRoundResult, prepareForBattle, snapshotTeam } from "../run/progression.ts";
import { applyActions, createRun, type StartItem } from "../run/reducer.ts";
import { replayShop, type ShopLog } from "../run/shoplog.ts";
import type { StarterSetup } from "../run/pokemon.ts";
import { GameError, type Action, type BattleOutcome, type Notice, type RunState, type TeamCosmetics, type TeamSnapshot } from "../run/types.ts";
import { META_RULES, type RunReward } from "../meta/progress.ts";
import { botTeam, rankedBot } from "./bot.ts";

export interface RunRecord {
  runId: string;
  playerId: string;
  /** The run at the start of its current round (the server's copy includes the seed). */
  state: RunState;
  /**
   * This round's actions the server already committed because they drew on the seed (commitActions).
   * They cannot be taken back; whatever the client sends next is applied after them.
   */
  pending?: Action[];
  createdAt: number;
  updatedAt: number;
}

export interface GhostRecord {
  id: string;
  runId: string;
  playerId: string;
  round: number;
  wins: number;
  losses: number;
  team: TeamSnapshot;
  createdAt: number;
  /** Saved by a ranked run; ranked and normal runs only meet their own kind. */
  ranked?: boolean;
  /** The owner's rating when the ghost was saved (ranked only). */
  rating?: number | null;
}

export interface BattleRecord {
  id: string;
  runId: string;
  playerId: string;
  round: number;
  seed: string;
  ghostId: string | null;
  outcome: BattleOutcome;
  createdAt: number;
  ranked: boolean;
  /** [player, opponent] as they fought; kept (in summary) for balance statistics. */
  teams: [TeamSnapshot, TeamSnapshot];
  /** Per-Pokémon battle summary (balance statistics). */
  detail?: BattleLog;
  /** The player's shop phase before this battle (balance statistics). */
  shop?: ShopLog;
}

/** Persistence used by the game server (PostgreSQL) and the offline client (localStorage). */
/** Every placed piece of a stored team lies on the current board. */
export function snapshotFitsBoard(team: TeamSnapshot): boolean {
  return team.pieces.every((p) => !p.place || cellsOf(p).every(inBoard));
}

export interface GameStore {
  getRun(runId: string): Promise<RunRecord | null>;
  putRun(record: RunRecord): Promise<void>;
  addGhost(ghost: GhostRecord): Promise<void>;
  /**
   * Recent ghosts of `round` not belonging to `playerId`, from ranked or normal runs only, and at most
   * one per player (their latest), so one player's many runs cannot fill the opponent pool. With
   * `ratings`, only ghosts saved at a rating in that range (a missing rating counts as the start rating).
   */
  findGhosts(round: number, playerId: string, limit: number, ranked: boolean, ratings?: RatingRange): Promise<GhostRecord[]>;
  addBattle(battle: BattleRecord): Promise<void>;
}

export interface RatingRange {
  min: number;
  max: number;
}

export interface OpponentInfo {
  name: string;
  champion: ChampionKey;
  ghost: boolean;
  /** Ranked runs: the rating this battle is scored against (the ghost owner's then, or the bot's strength). */
  rating?: number;
}

const ghostRating = (g: GhostRecord) => g.rating ?? META_RULES.startRating;

export interface TurnResponse {
  /** State after the round (next shop, or ended). */
  state: RunState;
  /** Points, rating and unlocks from the run that just ended (added by the API layer). */
  reward?: RunReward;
  /** Notices from the pre-battle step (evolution stones, candies). */
  preBattleNotices: Notice[];
  battle: {
    seed: string;
    teams: [TeamSnapshot, TeamSnapshot];
    opponent: OpponentInfo;
    outcome: BattleOutcome;
  };
}

export const MAX_ACTIONS_PER_TURN = 500;

/**
 * What a player may see of their run: everything but the seed, which decides future rerolls,
 * Poké Ball results and bot opponents. A state without a seed refuses those actions locally.
 */
export function publicState(state: RunState): RunState {
  return { ...state, seed: "" };
}

async function ownRun(store: GameStore, playerId: string, runId: string): Promise<RunRecord> {
  const record = await store.getRun(runId);
  if (!record || record.playerId !== playerId) throw new GameError("run_not_found");
  return record;
}

/** The run as its player left it: the round's start plus the actions already committed this round. */
export function currentState(record: RunRecord): RunState {
  const start = migrateRun(record.state);
  if (!record.pending?.length) return start;
  try {
    return applyActions(start, record.pending);
  } catch {
    // Only a rules change between commit and now can get here; fall back to the round's start.
    return start;
  }
}

export async function loadRun(store: GameStore, params: { playerId: string; runId: string }): Promise<RunState> {
  return currentState(await ownRun(store, params.playerId, params.runId));
}

/**
 * Applies and commits this round's actions up to one that needs the seed (a reroll, opening a Poké
 * Ball, choosing a subclass). The client sends only what it did since the last commit; the result
 * cannot be undone, so trying several orders to see different outcomes is impossible.
 */
export async function commitActions(
  store: GameStore,
  params: { playerId: string; runId: string; round: number; actions: Action[] },
): Promise<RunState> {
  const record = await ownRun(store, params.playerId, params.runId);
  const start = migrateRun(record.state);
  if (start.phase === "ended") throw new GameError("run_ended");
  if (start.round !== params.round) throw new GameError("round_mismatch");
  const all = [...(record.pending ?? []), ...params.actions];
  if (all.length > MAX_ACTIONS_PER_TURN) throw new GameError("too_many_actions");
  const after = applyActions(start, all);
  await store.putRun({ ...record, pending: all, updatedAt: Date.now() });
  return after;
}
export const NAME_MAX = 16;

export function sanitizeName(name: unknown): string {
  const s = typeof name === "string" ? name.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, "").trim() : "";
  return [...s].slice(0, NAME_MAX).join("") || "Trainer";
}

export async function startRun(
  store: GameStore,
  params: {
    playerId: string;
    playerName: string;
    champion: ChampionKey;
    seed?: string;
    /** Pool lines this player has not unlocked (meta/progress.ts runOptionsFor). */
    lockedLines?: readonly string[];
    ranked?: boolean;
    /** The player's trained starter (runOptionsFor). */
    starter?: StarterSetup;
    /** Start-of-run items, already paid for with points. */
    startItems?: readonly StartItem[];
    /** The player's looks (runOptionsFor). */
    cosmetics?: TeamCosmetics;
  },
): Promise<RunState> {
  if (!CHAMPIONS[params.champion]) throw new GameError("invalid_champion");
  const runId = randomSeed().slice(0, 20);
  const state = createRun({
    runId,
    seed: params.seed ?? randomSeed(),
    playerName: sanitizeName(params.playerName),
    champion: params.champion,
    ...(params.lockedLines ? { lockedLines: params.lockedLines } : {}),
    ...(params.ranked ? { ranked: true } : {}),
    ...(params.starter ? { starter: params.starter } : {}),
    ...(params.startItems?.length ? { startItems: params.startItems } : {}),
    ...(params.cosmetics ? { cosmetics: params.cosmetics } : {}),
  });
  const now = Date.now();
  await store.putRun({ runId, playerId: params.playerId, state, createdAt: now, updatedAt: now });
  return state;
}

function battleOutcome(winner: 0 | 1 | null): BattleOutcome {
  return winner === 0 ? "win" : winner === 1 ? "loss" : "draw";
}

/**
 * Server-authoritative round: replays the client's shop actions from the stored state with the same
 * pure reducer, stores the resulting board as a ghost, fights another player's ghost from the same
 * round (or a bot), and advances the run. Ranked runs meet ranked ghosts within META_RULES.ratingWindow
 * of their rating, or else a bot whose luck matches it (never more than a somewhat lucky ordinary run).
 */
export async function playRound(
  store: GameStore,
  params: { playerId: string; runId: string; round: number; actions: Action[]; /** Player's rating (ranked runs). */ rating?: number },
): Promise<TurnResponse> {
  const record = await ownRun(store, params.playerId, params.runId);
  const current = migrateRun(record.state);
  if (current.phase === "ended") throw new GameError("run_ended");
  if (current.round !== params.round) throw new GameError("round_mismatch");
  const actions = [...(record.pending ?? []), ...params.actions];
  if (actions.length > MAX_ACTIONS_PER_TURN) throw new GameError("too_many_actions");

  const { state: afterShop, log: shop } = replayShop(current, actions);
  if (afterShop.phase !== "shop") throw new GameError("wrong_phase");
  const prepared = prepareForBattle(afterShop);
  const you = snapshotTeam(prepared);

  const matchRng = rngFor(current.seed, "match", current.round);
  // Ghosts saved before the board shrank may not fit it any more.
  const ranked = !!current.ranked;
  const rating = ranked ? (params.rating ?? META_RULES.startRating) : null;
  const window = rating === null ? undefined : { min: rating - META_RULES.ratingWindow, max: rating + META_RULES.ratingWindow };
  const ghosts = (await store.findGhosts(current.round, params.playerId, 30, ranked, window)).filter((g) => snapshotFitsBoard(g.team));
  let opponentTeam: TeamSnapshot;
  let ghostId: string | null = null;
  let opponent: OpponentInfo;
  if (ghosts.length > 0) {
    const closeness = (g: GhostRecord) =>
      (1 / (1 + Math.abs(g.wins - current.wins))) * (rating !== null ? 1 / (1 + Math.abs(ghostRating(g) - rating) / 100) : 1);
    const pick = matchRng.weighted(ghosts.map((g) => [g, closeness(g)] as const));
    opponentTeam = pick.team;
    ghostId = pick.id;
    opponent = { name: pick.team.name, champion: pick.team.champion, ghost: true, ...(rating !== null ? { rating: ghostRating(pick) } : {}) };
  } else if (rating !== null) {
    const bot = rankedBot(`${current.seed}:${current.round}`, current.round, rating);
    opponentTeam = bot.team;
    opponent = { name: "", champion: bot.team.champion, ghost: false, rating: bot.rating };
  } else {
    opponentTeam = botTeam(`${current.seed}:${current.round}`, current.round);
    opponent = { name: "", champion: opponentTeam.champion, ghost: false };
  }

  const now = Date.now();
  // An empty board is no opponent (and would be a free win handed to whoever meets it).
  if (you.pieces.some((p) => p.kind === "pokemon")) {
    await store.addGhost({
      id: `${current.runId}:${current.round}`,
      runId: current.runId,
      playerId: params.playerId,
      round: current.round,
      wins: current.wins,
      losses: current.losses,
      team: you,
      createdAt: now,
      ranked,
      rating,
    });
  }

  // A fresh seed, not one derived from the run's: the client gets it to replay the battle.
  const seed = randomSeed();
  const teams: [TeamSnapshot, TeamSnapshot] = [you, opponentTeam];
  const result = simulateBattle({ seed, teams });
  const outcome = battleOutcome(result.winner);
  const next = applyRoundResult(prepared, {
    outcome,
    fainted: result.fainted[0],
    battleGold: result.rewards[0].gold,
    opponent,
  });
  await store.putRun({ ...record, state: next, pending: [], updatedAt: now });
  await store.addBattle({
    id: `${current.runId}:${current.round}`,
    runId: current.runId,
    playerId: params.playerId,
    round: current.round,
    seed,
    ghostId,
    outcome,
    createdAt: now,
    ranked,
    teams,
    detail: battleLog(result, teams),
    shop,
  });
  return { state: next, preBattleNotices: prepared.notices, battle: { seed, teams, opponent, outcome } };
}

/** In-memory store for tests and the offline client (which persists it itself). */
export class MemoryStore implements GameStore {
  runs = new Map<string, RunRecord>();
  ghosts: GhostRecord[] = [];
  battles: BattleRecord[] = [];

  async getRun(runId: string) {
    return structuredClone(this.runs.get(runId) ?? null);
  }
  async putRun(record: RunRecord) {
    this.runs.set(record.runId, structuredClone(record));
  }
  async addGhost(ghost: GhostRecord) {
    this.ghosts = this.ghosts.filter((g) => g.id !== ghost.id);
    this.ghosts.push(structuredClone(ghost));
    if (this.ghosts.length > 400) this.ghosts.splice(0, this.ghosts.length - 400);
  }
  async findGhosts(round: number, playerId: string, limit: number, ranked: boolean, ratings?: RatingRange) {
    const inRange = (g: GhostRecord) => !ratings || (ghostRating(g) >= ratings.min && ghostRating(g) <= ratings.max);
    const latest = new Map<string, GhostRecord>();
    for (const g of this.ghosts) if (g.round === round && g.playerId !== playerId && !!g.ranked === ranked && inRange(g)) latest.set(g.playerId, g);
    return [...latest.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-limit)
      .map((g) => structuredClone(g));
  }
  async addBattle(battle: BattleRecord) {
    this.battles.push(battle);
    if (this.battles.length > 200) this.battles.shift();
  }
}
