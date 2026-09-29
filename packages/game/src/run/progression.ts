import { CANDY_JAR_EXTRA_LEVELS, COIN_CASE_EXTRA_GOLD, poweredByBag } from "../board.ts";
import { CHAMPION_RULES } from "../content/champions.ts";
import { getSpecies, ITEMS } from "../content/index.ts";
import type { EvolutionDef } from "../content/schema.ts";
import { rngFor } from "../rng.ts";
import { checkPlacement, claimPlacement, computeAdjacency } from "./layout.ts";
import { evolveAbility, MAX_LEVEL, moveSlotsFor, newPokemon, refreshMoves, rollTraits } from "./pokemon.ts";
import { isLanceKinLine, lineBase } from "./pool.ts";
import { basePartyCap, bigPartyCount, INCOME, MAX_ROUNDS, partyCap, partyCount, rollShop, shopSize, STASH_LIMIT, SUBCLASS_ROUND, WINS_TO_CLEAR } from "./shop.ts";
import type { BattleOutcome, Notice, PokemonPiece, RoundLog, RunState, TeamCosmetics, TeamSnapshot } from "./types.ts";

export const XP_WIN = 4;
export const XP_LOSS = 3;
export const RARE_CANDY_LEVELS = 3;
export const RARER_CANDY_LEVELS = 6;
export const LUCKY_EGG_LEVELS = 2;
export const EXP_SHARE_LEVELS = 1;
export const MACHO_BRACE_LEVELS = 2;
export const TRADE_FALLBACK_LEVEL = 40;

export function evolutionLevel(state: RunState, mon: PokemonPiece, evo: EvolutionDef): number | null {
  if (evo.level === undefined) return null;
  const types = getSpecies(mon.species).types;
  let level = evo.level;
  if (state.champion === "lance" && isLanceKinLine(mon.species)) level = Math.floor(level * CHAMPION_RULES.lance.dragonEvoLevelMultiplier);
  if (state.champion === "alder" && types.includes("bug")) level = Math.floor(level * CHAMPION_RULES.alder.bugEvoLevelMultiplier);
  return Math.max(1, level);
}

function placedMons(state: RunState): PokemonPiece[] {
  return Object.values(state.pieces)
    .filter((p): p is PokemonPiece => p.kind === "pokemon" && p.place !== null)
    .sort((a, b) => (a.uid < b.uid ? -1 : 1));
}

/**
 * Evolution always happens. The Pokémon grows over its current spot and items in the way go to the
 * stash; if another Pokémon is in the way it moves to the nearest spot on the bags that only costs
 * items; and if no bag area can hold it at all, it evolves into the stash.
 */
function evolve(state: RunState, mon: PokemonPiece, to: string, evo: EvolutionDef, notices: Notice[]): boolean {
  const from = getSpecies(mon.species);
  const target = getSpecies(to);
  const trial: PokemonPiece = { ...mon, species: to };
  if (mon.place) {
    const claim = claimPlacement({ ...state.pieces, [mon.uid]: trial }, trial, mon.place);
    if (!claim) {
      mon.place = null;
      notices.push({ key: "notice.evolvedToStash", params: { species: to } });
    } else {
      for (const uid of claim.displaced) {
        const item = state.pieces[uid];
        if (item?.kind !== "item") continue;
        item.place = null;
        notices.push({ key: "notice.itemStashed", params: { item: item.item, ...(item.param ? { param: item.param } : {}) } });
      }
      mon.place = claim.place;
    }
    // Alder's extra slots only take 1×1 Pokémon: one that outgrows them waits in the stash.
    if (mon.place && state.champion === "alder" && bigPartyCount({ pieces: { ...state.pieces, [mon.uid]: trial } }) > basePartyCap(state.round)) {
      mon.place = null;
      notices.push({ key: "notice.evolvedToStash", params: { species: to } });
    }
  }
  const spawnFrom = mon.place ? computeAdjacency(state.pieces).freeNeighbours.get(mon.uid) ?? [] : [];
  mon.species = to;
  mon.ability = evolveAbility(from, target, mon.ability, mon.hiddenAbility);
  mon.pendingEvolution = null;
  refreshMoves(mon, moveSlotsFor(state.subclass));
  notices.push({ key: "notice.evolved", params: { from: from.key, to } });

  if (evo.spawn) {
    // The spawn takes a free adjacent cell if the party has room, otherwise waits in the stash.
    const partyRoom = partyCount(state) < partyCap(state);
    const cell = partyRoom
      ? spawnFrom.find((c) => !Object.values(state.pieces).some((p) => p.uid !== mon.uid && p.place && p.place.x === c.x && p.place.y === c.y))
      : undefined;
    const stashed = Object.values(state.pieces).filter((p) => p.place === null).length;
    if (cell || stashed < STASH_LIMIT) {
      const rng = rngFor(state.seed, "spawn", mon.uid, state.round);
      const uid = `u${state.nextUid++}`;
      const spawned = newPokemon(uid, evo.spawn, mon.level, rollTraits(evo.spawn, rng), 0, moveSlotsFor(state.subclass));
      state.pieces[uid] = spawned;
      const place = cell ? { x: cell.x, y: cell.y, rot: 0 as const } : null;
      if (place && checkPlacement(state.pieces, spawned, place) === null) spawned.place = place;
      notices.push({ key: "notice.spawned", params: { species: evo.spawn } });
    }
  }
  return true;
}

function retryPending(state: RunState, notices: Notice[]): void {
  for (const mon of placedMons(state)) {
    if (!mon.pendingEvolution) continue;
    const evo = getSpecies(mon.species).evolutions.find((e) => e.to === mon.pendingEvolution);
    if (evo) evolve(state, mon, mon.pendingEvolution, evo, notices);
  }
}

/** End-of-shop effects: Rare Candy, evolution items, pending evolutions. Runs before the snapshot. */
export function prepareForBattle(prev: RunState): RunState {
  const state: RunState = structuredClone(prev);
  const notices: Notice[] = [];
  let adj = computeAdjacency(state.pieces);
  for (const item of Object.values(state.pieces).sort((a, b) => (a.uid < b.uid ? -1 : 1))) {
    if (item.kind !== "item" || !item.place || (item.item !== "RARE_CANDY" && item.item !== "RARER_CANDY")) continue;
    const holders = adj.holdersOf.get(item.uid) ?? [];
    if (holders.length === 0) continue;
    const levels =
      (item.item === "RARER_CANDY" ? RARER_CANDY_LEVELS : RARE_CANDY_LEVELS) +
      (poweredByBag(item.item, adj.bagUnder.get(item.uid)) ? CANDY_JAR_EXTRA_LEVELS : 0);
    for (const uid of holders) {
      const mon = state.pieces[uid] as PokemonPiece;
      mon.level = Math.min(MAX_LEVEL, mon.level + levels);
      refreshMoves(mon, moveSlotsFor(state.subclass));
      notices.push({ key: "notice.candy", params: { species: mon.species, levels } });
    }
    delete state.pieces[item.uid];
  }
  adj = computeAdjacency(state.pieces);
  for (const item of Object.values(state.pieces).sort((a, b) => (a.uid < b.uid ? -1 : 1))) {
    if (item.kind !== "item" || !item.place || ITEMS[item.item]?.family !== "evolution") continue;
    for (const uid of adj.holdersOf.get(item.uid) ?? []) {
      const mon = state.pieces[uid];
      if (!mon || mon.kind !== "pokemon") continue;
      const evo = getSpecies(mon.species).evolutions.find((e) => e.item === item.item);
      if (!evo) continue;
      if (evolve(state, mon, evo.to, evo, notices)) {
        delete state.pieces[item.uid];
        adj = computeAdjacency(state.pieces);
        break;
      }
    }
  }
  retryPending(state, notices);
  state.notices = notices;
  return state;
}

export function snapshotTeam(state: RunState): TeamSnapshot {
  const pieces = structuredClone(Object.values(state.pieces).filter((p) => p.place !== null));
  const snap: TeamSnapshot = {
    name: state.playerName,
    champion: state.champion,
    subclass: state.subclass,
    round: state.round,
    wins: state.wins,
    losses: state.losses,
    streak: state.streak,
    ace: state.ace,
    pieces,
  };
  // Looks travel with the ghost; shiny lines only for the Pokémon actually on the board.
  const looks = state.cosmetics;
  if (looks) {
    const onBoard = new Set(pieces.flatMap((p) => (p.kind === "pokemon" ? [lineBase(p.species)] : [])));
    const shinyLines = (looks.shinyLines ?? []).filter((l) => onBoard.has(l));
    const cosmetics: TeamCosmetics = { ...(shinyLines.length > 0 ? { shinyLines } : {}), ...(looks.arena ? { arena: looks.arena } : {}) };
    if (Object.keys(cosmetics).length > 0) snap.cosmetics = cosmetics;
  }
  return snap;
}

export interface RoundResult {
  outcome: BattleOutcome;
  /** uids of this player's Pokémon that fainted */
  fainted: string[];
  /** gold earned inside the battle (Pay Day, Amulet Coin, Golden Punch, Pickup) */
  battleGold: number;
  opponent: RoundLog["opponent"];
}

export function applyRoundResult(prev: RunState, result: RoundResult): RunState {
  const state: RunState = structuredClone(prev);
  const notices: Notice[] = [...state.notices];
  const { outcome } = result;
  if (outcome === "win") {
    state.wins++;
    state.streak++;
  } else if (outcome === "loss") {
    state.losses++;
    state.lives--;
    state.streak = state.subclass === "leon_champtime" ? Math.floor(state.streak / 2) : 0;
  }

  const adj = computeAdjacency(state.pieces);
  const fainted = new Set(result.fainted);
  for (const mon of placedMons(state)) {
    const items = adj.itemsOf.get(mon.uid) ?? [];
    const n = (k: string) => items.filter((i) => i.item === k).length;
    mon.battles += 1 + n("SOOTHE_BELL");
    let gain = outcome === "win" ? XP_WIN : XP_LOSS;
    if (fainted.has(mon.uid)) gain -= 1;
    gain += LUCKY_EGG_LEVELS * n("LUCKY_EGG") + EXP_SHARE_LEVELS * n("EXP_SHARE") + MACHO_BRACE_LEVELS * n("MACHO_BRACE");
    if (state.champion === "red" && state.ace === mon.uid) {
      if (state.round % CHAMPION_RULES.red.aceExtraLevelEvery === 0) gain += CHAMPION_RULES.red.aceExtraLevels;
      if (outcome === "win") mon.aceBonus = Math.min(CHAMPION_RULES.red.aceWinStatCap, mon.aceBonus + CHAMPION_RULES.red.aceWinStatBonus);
    }
    const before = mon.level;
    mon.level = Math.min(MAX_LEVEL, mon.level + Math.max(0, gain));
    if (mon.level !== before) refreshMoves(mon, moveSlotsFor(state.subclass));
  }

  for (const mon of placedMons(state)) {
    const species = getSpecies(mon.species);
    const allies = (adj.alliesOf.get(mon.uid) ?? []).map((u) => state.pieces[u]).filter((p): p is PokemonPiece => p?.kind === "pokemon");
    for (const evo of species.evolutions) {
      if (evo.item) continue;
      const lvl = evolutionLevel(state, mon, evo);
      if (lvl !== null && mon.level < lvl) continue;
      if (evo.battles !== undefined && mon.battles < evo.battles) continue;
      if (evo.onResult && evo.onResult !== outcome) continue;
      if (evo.adjacentType && !allies.some((a) => getSpecies(a.species).types.includes(evo.adjacentType!))) continue;
      if (lvl === null && evo.battles === undefined) continue;
      evolve(state, mon, evo.to, evo, notices);
      break;
    }
  }

  const under = computeAdjacency(state.pieces).bagUnder;
  for (const p of Object.values(state.pieces)) {
    if (p.kind !== "item") continue;
    p.age++;
    if ((p.item === "NUGGET" || p.item === "BIG_NUGGET") && poweredByBag(p.item, under.get(p.uid))) {
      p.caseGold = (p.caseGold ?? 0) + COIN_CASE_EXTRA_GOLD;
    }
  }

  // Gold for the next round.
  const nextRound = state.round + 1;
  const income: Record<string, number> = { base: INCOME[Math.min(nextRound, INCOME.length) - 1] ?? 16 };
  if (outcome === "loss") income.consolation = 1;
  if (state.champion === "steven") income.devon = CHAMPION_RULES.steven.extraIncome;
  if (state.champion === "leon" && state.streak > 0) income.streak = Math.min(state.streak, CHAMPION_RULES.leon.streakIncomeCap);
  if (state.champion === "geeta") {
    const cap = state.subclass === "geeta_investor" ? CHAMPION_RULES.geeta.investorInterestCap : CHAMPION_RULES.geeta.interestCap;
    const interest = Math.min(cap, Math.floor(state.gold / CHAMPION_RULES.geeta.interestPer));
    if (interest > 0) income.interest = interest;
  }
  if (result.battleGold > 0) income.battle = result.battleGold;
  let total = 0;
  for (const v of Object.values(income)) total += v;
  state.gold += total;
  notices.push({ key: "notice.income", params: { ...income, total } });

  state.log.push({ round: state.round, outcome, opponent: result.opponent, goldEarned: total });
  state.lastOutcome = outcome;
  state.round = nextRound;
  state.rerolls = 0;
  state.notices = notices;

  if (state.wins >= WINS_TO_CLEAR || state.lives <= 0 || state.round > MAX_ROUNDS) {
    state.phase = "ended";
    state.shop = [];
    return state;
  }
  if (shopSize(state.round) > shopSize(state.round - 1)) notices.push({ key: "notice.shopGrew", params: { n: shopSize(state.round) } });
  if (state.round === SUBCLASS_ROUND && !state.subclass) {
    state.phase = "subclass";
    state.shop = state.shop.map((s) => (s.locked ? s : { offer: null, locked: false, sale: false }));
  } else {
    state.phase = "shop";
    state.shop = rollShop(state, 0);
  }
  return state;
}
