import botRatings from "../generated/bot-ratings.json";
import { BAGS, BOARD_H, BOARD_W, cellKey, neighbours, placeShape, poweredByBag, type Placement } from "../board.ts";
import { CHAMPION_KEYS, CHAMPIONS, type ChampionKey } from "../content/champions.ts";
import { CONTENT, getSpecies, ITEMS } from "../content/index.ts";
import { rngFor, type Rng } from "../rng.ts";
import { checkPlacement, computeAdjacency, computeLayout, findFreePlacement } from "../run/layout.ts";
import { pieceShape } from "../run/pokemon.ts";
import { natureEffect, type Nature } from "../stats.ts";
import { applyRoundResult, prepareForBattle, snapshotTeam } from "../run/progression.ts";
import { lockedLinesAt } from "../run/pool.ts";
import { applyAction, createRun, START_ITEMS } from "../run/reducer.ts";
import { partyCap, partyCount, rerollCost, slotPrice, WINS_TO_CLEAR } from "../run/shop.ts";
import { GameError, type Action, type Offer, type Piece, type PokemonPiece, type RunState, type TeamSnapshot } from "../run/types.ts";

function tryAction(state: RunState, action: Action): RunState | null {
  try {
    return applyAction(state, action);
  } catch (e) {
    if (e instanceof GameError) return null;
    throw e;
  }
}

function ownedTypes(state: RunState): Set<string> {
  const out = new Set<string>();
  for (const p of Object.values(state.pieces)) if (p.kind === "pokemon" && p.place) for (const t of getSpecies(p.species).types) out.add(t);
  return out;
}

const power = (m: PokemonPiece) => getSpecies(m.species).bst + m.level * 4;

function weakestMember(state: RunState): PokemonPiece | null {
  const mons = Object.values(state.pieces).filter((p): p is PokemonPiece => p.kind === "pokemon" && p.place !== null);
  if (mons.length === 0) return null;
  return mons.reduce((a, b) => (power(b) < power(a) ? b : a));
}

function stashedMons(state: RunState): PokemonPiece[] {
  return Object.values(state.pieces)
    .filter((p): p is PokemonPiece => p.kind === "pokemon" && p.place === null)
    .sort((a, b) => power(b) - power(a) || (a.uid < b.uid ? -1 : 1));
}

function placeMon(state: RunState, uid: string): RunState | null {
  const mon = state.pieces[uid];
  if (!mon || partyCount(state) >= partyCap(state)) return null;
  const spot = findFreePlacement(state.pieces, mon, { x: 4, y: 2, rot: 0 });
  return spot ? tryAction(state, { t: "move", uid, place: spot }) : null;
}

/**
 * Evolutions that outgrew their spot land in the stash. Put them back like a player would: into a
 * free spot, over a weaker party member, or after shuffling items aside.
 */
/** Items in the stash (pushed there by evolutions): back on the board, or sold when there is no room. */
const KEEP_IN_STASH = new Set(["POKE_BALL", "GREAT_BALL", "ULTRA_BALL", "MASTER_BALL", "VOUCHER", "ROOT_FOSSIL", "CLAW_FOSSIL", "TM", ...START_ITEMS]);
function restoreItems(start: RunState): RunState {
  let state = start;
  const stashed = Object.values(state.pieces).filter((p) => p.kind === "item" && p.place === null && !KEEP_IN_STASH.has(p.item));
  for (const item of stashed) {
    const place = bestItemPlacement(state, state.pieces[item.uid]!);
    const next = place ? tryAction(state, { t: "move", uid: item.uid, place }) : null;
    state = next ?? tryAction(state, { t: "sell", uid: item.uid }) ?? state;
  }
  return state;
}

/** Benches `bench`, then lifts items off the board one by one until `uid` fits; the items go back where they help most. */
function fitAfterClearing(state: RunState, uid: string, bench: readonly PokemonPiece[]): RunState | null {
  // Cheap check first: does it fit even with the bench and every item off the board?
  const cleared: Record<string, Piece> = { ...state.pieces };
  for (const p of [...bench, ...Object.values(state.pieces).filter((p) => p.kind === "item" && p.place)]) cleared[p.uid] = { ...p, place: null };
  if (!findFreePlacement(cleared, state.pieces[uid]!, { x: 4, y: 2, rot: 0 })) return null;
  let trial: RunState | null = state;
  for (const m of bench) trial = trial && tryAction(trial, { t: "move", uid: m.uid, place: null });
  if (!trial) return null;
  const lifted: string[] = [];
  let placed = placeMon(trial, uid);
  for (const item of Object.values(trial.pieces).filter((p) => p.kind === "item" && p.place)) {
    if (placed) break;
    trial = tryAction(trial, { t: "move", uid: item.uid, place: null });
    if (!trial) return null;
    lifted.push(item.uid);
    placed = placeMon(trial, uid);
  }
  if (!placed) return null;
  for (const l of lifted) {
    const place = bestItemPlacement(placed, placed.pieces[l]!);
    if (place) placed = tryAction(placed, { t: "move", uid: l, place }) ?? placed;
  }
  return placed;
}

function restoreStash(start: RunState): RunState {
  let state = start;
  for (const mon of stashedMons(state)) {
    const direct = placeMon(state, mon.uid);
    if (direct) {
      state = direct;
      continue;
    }
    const weakest = weakestMember(state);
    if (weakest && power(mon) > power(weakest)) {
      const benched = tryAction(state, { t: "move", uid: weakest.uid, place: null });
      const swapped = benched && placeMon(benched, mon.uid);
      if (swapped) {
        state = swapped;
        continue;
      }
    }
    // Otherwise make room like a player would: items aside first, then a weaker member benched (weakest first),
    // and at last the two weakest together (a big legendary needs a 3×2 spot on a packed board).
    const weaker = placedMonsOf(state).filter((m) => power(m) < power(mon)).reverse();
    const plans: PokemonPiece[][] = partyCount(state) < partyCap(state) ? [[]] : [];
    for (const m of weaker) plans.push([m]);
    if (weaker.length >= 2) plans.push(weaker.slice(0, 2));
    for (const bench of plans) {
      const placed = fitAfterClearing(state, mon.uid, bench);
      if (placed) {
        state = placed;
        break;
      }
    }
  }
  return restoreItems(state);
}

function placedMonsOf(state: RunState): PokemonPiece[] {
  return Object.values(state.pieces)
    .filter((p): p is PokemonPiece => p.kind === "pokemon" && p.place !== null)
    .sort((a, b) => power(b) - power(a) || (a.uid < b.uid ? -1 : 1));
}

/**
 * The Pokémon an item is really meant for, like a player would think of it: the species of a Mega
 * Stone or species item, the Pokémon a stone evolves, a Pokémon with moves of a Z-Crystal's type,
 * a Pokémon of a Tera Shard's type (double STAB).
 */
function itemTarget(state: RunState, key: string, param?: string): PokemonPiece | null {
  const def = ITEMS[key];
  if (!def) return null;
  const mons = placedMonsOf(state);
  if (def.mega) return mons.find((m) => m.species === def.mega!.species) ?? null;
  if (def.forSpecies) return mons.find((m) => m.species === def.forSpecies) ?? null;
  if (def.forAbilities) return mons.find((m) => def.forAbilities!.includes(m.ability)) ?? null;
  if (def.family === "evolution") return mons.find((m) => getSpecies(m.species).evolutions.some((e) => e.item === key)) ?? null;
  if (def.family === "zCrystal" && def.type) {
    return mons.find((m) => m.moves.some((mv) => CONTENT.moves[mv]?.type === def.type && CONTENT.moves[mv]?.category !== "status")) ?? null;
  }
  if (key === "TERA_SHARD" && param) return mons.find((m) => getSpecies(m.species).types.includes(param as never)) ?? mons[0] ?? null;
  if (def.family === "dynamax") return mons[0] ?? null;
  // Steven: stones harden adjacent Rock and Steel Pokémon.
  if (state.champion === "steven" && def.stone) {
    return mons.find((m) => getSpecies(m.species).types.some((t) => t === "rock" || t === "steel")) ?? null;
  }
  return null;
}

/** Bag cells nothing stands on yet. */
function freeCells(state: RunState): number {
  const layout = computeLayout(Object.values(state.pieces));
  let used = 0;
  for (const p of Object.values(state.pieces)) if (p.place && p.kind !== "bag") used += pieceShape(p).length;
  return layout.usable.size - used;
}

function offerValue(state: RunState, offer: Offer): number {
  switch (offer.kind) {
    case "pokemon": {
      const value = 10 + offer.tier * 6 + (offer.shiny ? 3 : 0);
      if (partyCount(state) < partyCap(state)) return value;
      // Full party: only worth it as an upgrade over the weakest member.
      const weakest = weakestMember(state);
      const gain = weakest ? getSpecies(offer.species).bst + offer.level * 4 - (getSpecies(weakest.species).bst + weakest.level * 4) : 0;
      return gain > 60 ? value : 0;
    }
    case "item": {
      const def = ITEMS[offer.item]!;
      if (def.family === "typeBoost") return def.type && ownedTypes(state).has(def.type) ? 12 : 1;
      if (state.champion === "steven" && def.stone && itemTarget(state, offer.item)) return 14;
      if (def.family === "evolution") return itemTarget(state, offer.item) ? 18 : 1;
      if (def.family === "tm" || def.family === "fossil") return 3;
      if (def.family === "mega") return itemTarget(state, offer.item) ? 20 : 0;
      if (def.forAbilities) return itemTarget(state, offer.item) ? 16 : 0;
      if (def.family === "zCrystal") return itemTarget(state, offer.item) ? 14 : 2;
      if (offer.item === "TERA_SHARD") return offer.param && placedMonsOf(state).some((m) => getSpecies(m.species).types.includes(offer.param as never)) ? 14 : 5;
      return 8 + def.tier * 2;
    }
    case "bag": {
      // More room is urgent while an evolved Pokémon waits in the stash, and pointless while plenty is free.
      if (stashedMons(state).length > 0) return 16 + BAGS[offer.bag]!.cells.length;
      return freeCells(state) >= 6 ? 2 : 6 + BAGS[offer.bag]!.cells.length;
    }
  }
}

/** Best placement for an item: touching the Pokémon it is meant for (if any), then as many Pokémon as possible. */
function bestItemPlacement(state: RunState, piece: Piece): Placement | null {
  const target = piece.kind === "item" ? itemTarget(state, piece.item, piece.param) : null;
  // Next to the Pokémon it is meant for if there is room, otherwise wherever it helps most.
  return (target && bestItemSpot(state, piece, target.uid)) || bestItemSpot(state, piece, null);
}

function bestItemSpot(state: RunState, piece: Piece, target: string | null): Placement | null {
  let best: Placement | null = null;
  let bestScore = -1;
  for (const rot of [0, 1, 2, 3] as const) for (let y = 0; y < BOARD_H; y++) {
    for (let x = 0; x < BOARD_W; x++) {
      const place: Placement = { x, y, rot };
      if (checkPlacement(state.pieces, piece, place) !== null) continue;
      const trial = { ...state.pieces, [piece.uid]: { ...piece, place } as Piece };
      const adj = computeAdjacency(trial);
      const list = adj.holdersOf.get(piece.uid) ?? [];
      if (target && !list.includes(target)) continue;
      // A berry, candy or gold item is worth half a holder more on the bag that powers it.
      const powered = piece.kind === "item" && poweredByBag(piece.item, adj.bagUnder.get(piece.uid));
      const holders = list.length * (powered ? 1.5 : 1);
      if (holders > bestScore) {
        best = place;
        bestScore = holders;
      }
    }
  }
  return bestScore > 0 ? best : null;
}

/** Bag placement that shares the longest edge with the existing usable area. */
function bestBagPlacement(state: RunState, piece: Piece): Placement | null {
  const usable = computeLayout(Object.values(state.pieces)).usable;
  let best: Placement | null = null;
  let bestScore = 0;
  for (const rot of [0, 1, 2, 3] as const) {
    for (let y = 0; y < BOARD_H; y++) {
      for (let x = 0; x < BOARD_W; x++) {
        const place: Placement = { x, y, rot };
        if (checkPlacement(state.pieces, piece, place) !== null) continue;
        const cells = placeShape(pieceShape(piece), place);
        const touching = neighbours(cells).filter((c) => usable.has(cellKey(c))).length;
        if (touching > bestScore) {
          best = place;
          bestScore = touching;
        }
      }
    }
  }
  return best;
}

function placeNewest(state: RunState): RunState {
  const newest = Object.values(state.pieces).reduce((a, b) => (Number(a.uid.slice(1)) > Number(b.uid.slice(1)) ? a : b));
  if (newest.place) return state;
  let place: Placement | null = null;
  if (newest.kind === "pokemon") {
    let s = state;
    if (partyCount(s) >= partyCap(s)) {
      const weakest = weakestMember(s);
      if (!weakest) return state;
      s = tryAction(s, { t: "sell", uid: weakest.uid }) ?? s;
    }
    const spot = findFreePlacement(s.pieces, newest, { x: 4, y: 2, rot: 0 });
    return spot ? (tryAction(s, { t: "move", uid: newest.uid, place: spot }) ?? s) : s;
  }
  else if (newest.kind === "item") place = bestItemPlacement(state, newest);
  if (!place) return state;
  return tryAction(state, { t: "move", uid: newest.uid, place }) ?? state;
}

/** How well a nature suits a Pokémon: raising its better attacking stat (or Speed) good, lowering it bad. */
function natureFit(nature: Nature, mon: PokemonPiece): number {
  const { atk, spa } = getSpecies(mon.species).baseStats;
  const main = atk >= spa ? "atk" : "spa";
  const { up, down } = natureEffect(nature);
  const worth = (k: string | null) => (k === main ? 2 : k === "spe" ? 1 : 0);
  return worth(up) - worth(down);
}

const ivTotal = (mon: PokemonPiece) => Object.values(mon.ivs).reduce((a, b) => a + b, 0);

/**
 * Start-of-run items, used like a player would: once the party has a Pokémon worth it (a final
 * evolution or a strong one), the Mint goes to the strongest Pokémon it suits better than its nature,
 * and the Bottle Cap to the strongest one with below-average IVs.
 */
function useStartItems(state: RunState): RunState {
  let s = state;
  const worthy = placedMonsOf(s).filter((m) => getSpecies(m.species).evolutions.length === 0 || getSpecies(m.species).bst >= 480);
  for (const p of Object.values(s.pieces)) {
    if (p.kind !== "item" || worthy.length === 0) continue;
    if (p.item === "MINT" && p.param) {
      const target = worthy.find((m) => natureFit(p.param as Nature, m) > natureFit(m.nature, m));
      if (target) s = tryAction(s, { t: "use", uid: p.uid, target: target.uid }) ?? s;
    }
    if (p.item === "BOTTLE_CAP") {
      const target = worthy.find((m) => ivTotal(m) < 93);
      if (target) s = tryAction(s, { t: "use", uid: p.uid, target: target.uid }) ?? s;
    }
  }
  return s;
}

function useConsumables(state: RunState): RunState {
  let s = useStartItems(state);
  for (const p of Object.values(s.pieces)) {
    if (p.kind !== "item") continue;
    if (["POKE_BALL", "VOUCHER", "ROOT_FOSSIL", "CLAW_FOSSIL"].includes(p.item)) {
      const next = tryAction(s, { t: "use", uid: p.uid });
      if (next) s = placeNewest(next);
    }
    if (p.item === "TM" && p.param) {
      const target = Object.values(s.pieces).find(
        (m) => m.kind === "pokemon" && m.place && getSpecies(m.species).tmMoves.includes(p.param!) && !m.moves.includes(p.param!),
      );
      if (target) s = tryAction(s, { t: "use", uid: p.uid, target: target.uid }) ?? s;
    }
  }
  return s;
}

/** Plays one shop phase with simple greedy heuristics. */
export function botShop(start: RunState, rng: Rng): RunState {
  let state = start;
  if (state.phase === "subclass") {
    state = applyAction(state, { t: "chooseSubclass", subclass: rng.pick(CHAMPIONS[state.champion].subclasses) });
  }
  state = restoreStash(state);
  // A legendary it cannot afford yet: lock it and save this round's gold for it, as a player would.
  const legend = state.shop.findIndex((s) => s.offer?.kind === "pokemon" && s.offer.tier === 5 && offerValue(state, s.offer) > 0);
  if (legend >= 0 && slotPrice(state.shop[legend]!, state) > state.gold) {
    return state.shop[legend]!.locked ? state : (tryAction(state, { t: "lock", slot: legend }) ?? state);
  }
  for (let rerolls = 0; rerolls < 3; rerolls++) {
    for (let guard = 0; guard < 8; guard++) {
      const options = state.shop
        .map((slot, i) => ({ slot, i }))
        .filter(({ slot }) => slot.offer && slotPrice(slot, state) <= state.gold)
        .map(({ slot, i }) => ({ i, base: offerValue(state, slot.offer!), offer: slot.offer! }))
        .filter((o) => o.base > 2)
        .map((o) => ({ ...o, value: o.base + rng.next() * 3 }))
        .sort((a, b) => b.value - a.value);
      let bought = false;
      for (const o of options) {
        if (o.offer.kind === "bag") {
          const probe: Piece = { uid: "probe", kind: "bag", place: null, paid: 0, bag: o.offer.bag };
          const place = bestBagPlacement(state, probe);
          const next = place ? tryAction(state, { t: "buy", slot: o.i, place }) : null;
          if (next) {
            state = restoreStash(next);
            bought = true;
            break;
          }
          continue;
        }
        const next = tryAction(state, { t: "buy", slot: o.i });
        if (next) {
          state = placeNewest(next);
          bought = true;
          break;
        }
      }
      if (!bought) break;
    }
    state = useConsumables(state);
    if (state.gold < rerollCost(state) + 3) break;
    state = tryAction(state, { t: "reroll" }) ?? state;
  }
  // A Pokémon bought this round that found no free spot (a big legendary) gets the stash treatment before the battle.
  return stashedMons(state).length > 0 ? restoreStash(state) : state;
}

export function randomChampion(rng: Rng): ChampionKey {
  return rng.pick(CHAMPION_KEYS);
}

/**
 * Builds a ghost for `round` by playing a whole bot run up to that round (random champion unless given).
 * `poolStage` plays with the pool a player has at that unlock stage (balance checks for new players);
 * the game's bots always have the full pool.
 */
export function botTeam(seed: string, round: number, champion?: ChampionKey, poolStage?: number): TeamSnapshot {
  const rng = rngFor(seed, "bot");
  const pick = champion ?? randomChampion(rng);
  // Bots buy the start items too: every player who plays a while can afford them, and the bot is the baseline.
  let state = createRun({
    runId: `bot-${seed}`,
    seed: `bot-${seed}`,
    playerName: "",
    champion: pick,
    startItems: START_ITEMS,
    ...(poolStage !== undefined ? { lockedLines: lockedLinesAt(pick, poolStage) } : {}),
  });
  while (state.round < round && state.phase !== "ended") {
    state = prepareForBattle(botShop(state, rng));
    // Coin-flip results, but the run must survive to `round` (it would end at 0 lives or the final win).
    const mustWin = state.lives <= 1;
    const mustLose = state.wins >= WINS_TO_CLEAR - 1;
    const win = mustWin !== mustLose ? mustWin : rng.chance(0.5);
    state = applyRoundResult(state, {
      outcome: win ? "win" : "loss",
      fainted: [],
      battleGold: 0,
      opponent: { name: "", champion: state.champion, ghost: false },
    });
    if (state.phase === "ended") break;
  }
  if (state.phase !== "ended") state = prepareForBattle(botShop(state, rng));
  const snap = snapshotTeam(state);
  return { ...snap, round };
}

/** Rough strength of a snapshot (levels × base stats, plus items), used to tell luckier bot runs apart. */
export function roughPower(t: TeamSnapshot): number {
  let p = 0;
  for (const x of t.pieces) if (x.kind === "pokemon") p += getSpecies(x.species).bst * x.level;
  return p + 400 * t.pieces.filter((x) => x.kind === "item").length;
}

export interface BotLuck {
  key: string;
  /** Ordinary bot runs played; the weakest or strongest of them (by roughPower) is the opponent. */
  runs: number;
  strongest: boolean;
}

/**
 * Ranked bots, weakest to strongest. Luck is all that sets them apart: the weakest or strongest of a few
 * ordinary bot runs of one champion, so even the top one is a run whose shops went a little better,
 * never a boosted team. `plain` is the single run normal games meet.
 */
export const BOT_LUCK: readonly BotLuck[] = [
  { key: "worst3", runs: 3, strongest: false },
  { key: "worst2", runs: 2, strongest: false },
  { key: "plain", runs: 1, strongest: true },
  { key: "best2", runs: 2, strongest: true },
  { key: "best3", runs: 3, strongest: true },
];

/** Measured rating of each bot luck against plain bots (= the start rating); `pnpm bot-ratings` rewrites it. */
export const BOT_RATINGS: Readonly<Record<string, number>> = botRatings.ratings;

/** A bot opponent with the given luck; `plain` is exactly botTeam(seed, round). */
export function luckyBotTeam(seed: string, round: number, luck: BotLuck, champion?: ChampionKey): TeamSnapshot {
  if (luck.runs <= 1) return botTeam(seed, round, champion);
  const pick = champion ?? randomChampion(rngFor(seed, "bot-champion"));
  const runs = Array.from({ length: luck.runs }, (_, i) => botTeam(`${seed}~${i}`, round, pick));
  return runs.reduce((a, b) => ((luck.strongest ? roughPower(b) > roughPower(a) : roughPower(b) < roughPower(a)) ? b : a));
}

/** The ranked bot luck closest to `rating` in strength. */
export function botLuckForRating(rating: number): BotLuck {
  return BOT_LUCK.reduce((a, b) => (Math.abs(BOT_RATINGS[b.key]! - rating) < Math.abs(BOT_RATINGS[a.key]! - rating) ? b : a));
}

/** The ranked bot closest to `rating` in strength, and its rating (the Elo opponent it counts as). */
export function rankedBot(seed: string, round: number, rating: number): { team: TeamSnapshot; rating: number } {
  const luck = botLuckForRating(rating);
  return { team: luckyBotTeam(seed, round, luck), rating: BOT_RATINGS[luck.key]! };
}
