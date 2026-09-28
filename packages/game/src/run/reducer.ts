import { BAGS, BOARD_H, BOARD_W, rotateShape, shapeSize, START_BAG_PLACE, type Placement, type Rot } from "../board.ts";
import { CHAMPIONS, type ChampionKey } from "../content/champions.ts";
import { getSpecies, ITEMS, type Tier } from "../content/index.ts";
import { cleanNickname } from "../meta/cosmetics.ts";
import { rngFor, type Rng } from "../rng.ts";
import { natureEffect, NATURES, type Nature } from "../stats.ts";
import { bagGroup, bagHasContents, checkPlacement, findFreePlacement, planBagMove, planDrop } from "./layout.ts";
import { moveSlotsFor, newPokemon, pieceShape, refreshMoves, rollIvs, rollTraits, trainTraits, type StarterSetup } from "./pokemon.ts";
import { RUN_STATE_VERSION } from "./migrate.ts";
import { championSpeciesByTier, championSpeciesOfTier } from "./pool.ts";
import { resolveRecipes } from "./recipes.ts";
import {
  bigPartyCount,
  INCOME,
  isSmallMon,
  basePartyCap,
  partyCap,
  partyCount,
  rerollCost,
  rollShop,
  SHOP_SIZE,
  slotPrice,
  STARTING_LIVES,
  STASH_LIMIT,
  TIER_LEVEL,
  TIER_UNLOCK,
} from "./shop.ts";
import { GameError, type Action, type BagPiece, type ItemPiece, type Piece, type PokemonPiece, type RunState, type TeamCosmetics } from "./types.ts";

/**
 * Items a player can buy with points as a run starts (one of each): a Mint of a random nature and a
 * Bottle Cap that rerolls one Pokémon's IVs. They wait in the stash until used on a Pokémon.
 */
export const START_ITEMS = ["MINT", "BOTTLE_CAP"] as const;
export type StartItem = (typeof START_ITEMS)[number];

/** Natures a Mint can carry: the ones that raise a stat (a neutral Mint would do nothing). */
const MINT_NATURES: Nature[] = NATURES.filter((n) => natureEffect(n).up !== null);

export interface NewRunParams {
  runId: string;
  seed: string;
  playerName: string;
  champion: ChampionKey;
  lockedLines?: readonly string[];
  ranked?: boolean;
  /** How the player trained this champion's starter (meta/progress.ts starterSetup). */
  starter?: StarterSetup;
  /** Start-of-run items bought with points. */
  startItems?: readonly StartItem[];
  /** The player's looks (meta/progress.ts runCosmetics). */
  cosmetics?: TeamCosmetics;
}

function uid(state: RunState): string {
  return `u${state.nextUid++}`;
}

function stashCount(state: RunState): number {
  return Object.values(state.pieces).filter((p) => p.place === null).length;
}

export function createRun(params: NewRunParams): RunState {
  const champ = CHAMPIONS[params.champion];
  if (!champ) throw new GameError("invalid_champion");
  const state: RunState = {
    v: RUN_STATE_VERSION,
    runId: params.runId,
    seed: params.seed,
    playerName: params.playerName,
    champion: params.champion,
    subclass: null,
    round: 1,
    phase: "shop",
    gold: INCOME[0]!,
    lives: STARTING_LIVES,
    wins: 0,
    losses: 0,
    streak: 0,
    rerolls: 0,
    shop: [],
    pieces: {},
    nextUid: 1,
    ace: null,
    lastOutcome: null,
    log: [],
    notices: [],
    ...(params.lockedLines?.length ? { lockedLines: [...params.lockedLines] } : {}),
    ...(params.ranked ? { ranked: true } : {}),
    ...(params.cosmetics?.shinyLines?.length || params.cosmetics?.arena ? { cosmetics: structuredClone(params.cosmetics) } : {}),
  };
  const bag: BagPiece = { uid: uid(state), kind: "bag", place: { ...START_BAG_PLACE }, paid: 0, bag: "BAG_START" };
  state.pieces[bag.uid] = bag;
  const rng = rngFor(params.seed, "starter");
  const starter = newPokemon(
    uid(state),
    champ.starter.species,
    TIER_LEVEL[1],
    trainTraits(champ.starter.species, rollTraits(champ.starter.species, rng), params.starter),
    0,
    moveSlotsFor(null),
  );
  const nickname = cleanNickname(params.starter?.nickname);
  if (nickname) starter.nickname = nickname;
  state.pieces[starter.uid] = starter;
  starter.place = findFreePlacement(state.pieces, starter, { x: START_BAG_PLACE.x + 1, y: START_BAG_PLACE.y, rot: 0 });
  const item: ItemPiece = {
    uid: uid(state),
    kind: "item",
    place: null,
    paid: 0,
    item: champ.starter.item,
    age: 0,
    ...(champ.starter.itemParam ? { param: champ.starter.itemParam } : {}),
  };
  state.pieces[item.uid] = item;
  item.place = findFreePlacement(state.pieces, item, { x: START_BAG_PLACE.x + 1, y: START_BAG_PLACE.y + 1, rot: 0 });
  const itemRng = rngFor(params.seed, "start-items");
  for (const key of START_ITEMS) {
    if (!params.startItems?.includes(key)) continue;
    const bought: ItemPiece = { uid: uid(state), kind: "item", place: null, paid: 0, item: key, age: 0 };
    if (key === "MINT") bought.param = itemRng.pick(MINT_NATURES);
    state.pieces[bought.uid] = bought;
  }
  if (params.champion === "red") state.ace = starter.uid;
  state.shop = rollShop(state, 0);
  return state;
}

function requirePhase(state: RunState, phase: RunState["phase"]): void {
  if (state.phase !== phase) throw new GameError("wrong_phase");
}

function requirePiece(state: RunState, id: string): Piece {
  // Own keys only: "__proto__" or "constructor" would otherwise reach Object.prototype.
  if (!Object.hasOwn(state.pieces, id)) throw new GameError("not_found");
  return state.pieces[id]!;
}

/**
 * Actions drawing on the run's seed (rerolls, opening Poké Balls, Bottle Caps, the subclass shop). The server keeps
 * the seed from players, so they cannot see those results in advance: the client sends these to the
 * server, which commits them (see commitActions).
 */
function requireSeed(state: RunState): void {
  if (!state.seed) throw new GameError("needs_server");
}

const ACTION_TYPES = new Set(["buy", "sell", "move", "reroll", "lock", "setAce", "chooseSubclass", "use"]);

function badAction(): never {
  throw new GameError("bad_action");
}

/** A board spot: whole-cell coordinates on the board and one of four rotations. */
function readPlacement(input: unknown): Placement {
  if (!input || typeof input !== "object") badAction();
  const { x, y, rot } = input as Record<string, unknown>;
  if (!Number.isInteger(x) || !Number.isInteger(y) || !(rot === 0 || rot === 1 || rot === 2 || rot === 3)) badAction();
  const px = x as number;
  const py = y as number;
  if (px < 0 || py < 0 || px >= BOARD_W || py >= BOARD_H) throw new GameError("out_of_board");
  return { x: px, y: py, rot };
}

/**
 * Checks an action's shape before it touches the state and rebuilds it from known fields only.
 * The server replays whatever a client sends, so nothing here may trust types or ranges.
 */
export function readAction(input: unknown): Action {
  if (!input || typeof input !== "object") badAction();
  const a = input as Record<string, unknown>;
  if (typeof a.t !== "string" || !ACTION_TYPES.has(a.t)) badAction();
  const str = (v: unknown) => (typeof v === "string" ? v : badAction());
  const optStr = (v: unknown) => (v === undefined ? undefined : str(v));
  const slot = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) < SHOP_SIZE ? (v as number) : badAction());
  const place = (v: unknown) => (v === undefined || v === null ? null : readPlacement(v));
  switch (a.t) {
    case "buy":
      return { t: "buy", slot: slot(a.slot), place: place(a.place) };
    case "sell":
      return { t: "sell", uid: str(a.uid) };
    case "move":
      return { t: "move", uid: str(a.uid), place: place(a.place) };
    case "reroll":
      return { t: "reroll" };
    case "lock":
      return { t: "lock", slot: slot(a.slot) };
    case "setAce":
      return { t: "setAce", uid: str(a.uid) };
    case "chooseSubclass":
      return { t: "chooseSubclass", subclass: str(a.subclass) as Extract<Action, { t: "chooseSubclass" }>["subclass"] };
    default: {
      const target = optStr(a.target);
      const replace = optStr(a.replace);
      return {
        t: "use",
        uid: str(a.uid),
        ...(target !== undefined ? { target } : {}),
        ...(replace !== undefined ? { replace } : {}),
        ...(a.slot !== undefined ? { slot: slot(a.slot) } : {}),
      };
    }
  }
}

/**
 * Puts a Pokémon or item on the board (or in the stash when `where` is null). If one piece is in
 * the way it swaps into this piece's old spot or goes to the stash (see planDrop).
 */
function place(state: RunState, piece: Piece, where: Placement | null | undefined): void {
  if (!where) {
    if (piece.place !== null && stashCount(state) >= STASH_LIMIT) throw new GameError("stash_full");
    piece.place = null;
    return;
  }
  const stashRoom = stashCount(state) - (piece.place === null && state.pieces[piece.uid] ? 1 : 0) < STASH_LIMIT;
  const plan = planDrop(state.pieces, piece, where, stashRoom);
  if (!plan.ok) throw new GameError(plan.error);
  const other = plan.displaced ? state.pieces[plan.displaced.uid]! : null;
  const joins = piece.kind === "pokemon" && piece.place === null ? 1 : 0;
  const leaves = other?.kind === "pokemon" && plan.displaced!.to === null ? 1 : 0;
  if (joins > 0 && partyCount(state) + joins - leaves > partyCap(state)) throw new GameError("party_full");
  // Alder's extra slots are for 1×1 Pokémon: bigger ones stay within the normal party size.
  const big = (p: Piece | null) => (p?.kind === "pokemon" && !isSmallMon(p) ? 1 : 0);
  if (joins > 0 && big(piece) && bigPartyCount(state) + 1 - (leaves ? big(other) : 0) > basePartyCap(state.round)) throw new GameError("party_full_big");
  if (other) other.place = plan.displaced!.to;
  piece.place = { x: where.x, y: where.y, rot: where.rot };
}

/**
 * Moves (and rotates) a bag together with every bag linked to it by a piece resting on both, and
 * everything lying on them (see `planBagMove`).
 */
function moveBag(state: RunState, bag: BagPiece, where: Placement): void {
  const { places, error } = planBagMove(state.pieces, bag, where);
  if (error) throw new GameError(error);
  for (const [uid, place] of places) state.pieces[uid]!.place = place;
}

export function isStarterBag(piece: Piece): boolean {
  return piece.kind === "bag" && !!BAGS[piece.bag]?.starter;
}

export function sellValue(state: RunState, piece: Piece): number {
  if (piece.paid <= 0) return 0;
  let value = state.champion === "steven" ? piece.paid : Math.max(1, Math.floor(piece.paid / 2));
  if (piece.kind === "item" && piece.item === "NUGGET") value = piece.paid + piece.age + (piece.caseGold ?? 0);
  if (piece.kind === "item" && piece.item === "BIG_NUGGET") value = piece.paid + 2 * piece.age + (piece.caseGold ?? 0);
  if (state.subclass === "geeta_investor") value += 1;
  return value;
}

function randomSpecies(state: RunState, rng: Rng, tierWeights: number[]): { species: string; tier: Tier } {
  const byTier = championSpeciesByTier(state);
  const tiers = ([1, 2, 3, 4, 5] as Tier[]).filter((t) => byTier[t].length > 0 && (tierWeights[t - 1] ?? 0) > 0);
  const tier = rng.weighted(tiers.map((t) => [t, tierWeights[t - 1]!] as const));
  return { species: rng.pick(byTier[tier]), tier };
}

function addPokemonToStash(state: RunState, species: string, level: number, rng: Rng): PokemonPiece {
  if (stashCount(state) >= STASH_LIMIT) throw new GameError("stash_full");
  const mon = newPokemon(uid(state), species, level, rollTraits(species, rng), 0, moveSlotsFor(state.subclass));
  state.pieces[mon.uid] = mon;
  return mon;
}

function roundLevel(state: RunState, tier: Tier): number {
  return TIER_LEVEL[tier] + Math.max(0, state.round - TIER_UNLOCK[tier]);
}

const ivSum = (mon: PokemonPiece) => Object.values(mon.ivs).reduce((a, b) => a + b, 0);

function useItem(state: RunState, item: ItemPiece, action: Extract<Action, { t: "use" }>): void {
  const rng = rngFor(state.seed, "use", item.uid);
  switch (item.item) {
    case "TM": {
      const target = requirePiece(state, action.target ?? "");
      if (target.kind !== "pokemon" || !item.param) throw new GameError("invalid_target");
      const species = getSpecies(target.species);
      if (!species.tmMoves.includes(item.param)) throw new GameError("tm_incompatible");
      if (target.moves.includes(item.param)) throw new GameError("tm_known");
      const slots = moveSlotsFor(state.subclass);
      target.taught = [...target.taught.filter((m) => m !== item.param), item.param].slice(-slots);
      refreshMoves(target, slots);
      break;
    }
    case "MINT": {
      const target = requirePiece(state, action.target ?? "");
      if (target.kind !== "pokemon" || !NATURES.includes(item.param as Nature)) throw new GameError("invalid_target");
      if (target.nature === item.param) throw new GameError("same_nature");
      target.nature = item.param as Nature;
      state.notices.push({ key: "notice.mint", params: { species: target.species, nature: target.nature } });
      break;
    }
    case "BOTTLE_CAP": {
      const target = requirePiece(state, action.target ?? "");
      if (target.kind !== "pokemon") throw new GameError("invalid_target");
      requireSeed(state);
      const before = ivSum(target);
      target.ivs = rollIvs(rng);
      state.notices.push({ key: "notice.bottleCap", params: { species: target.species, before, after: ivSum(target) } });
      break;
    }
    case "MASTER_BALL": {
      const slot = state.shop[action.slot ?? -1];
      if (!slot || !slot.offer || slot.offer.kind !== "pokemon") throw new GameError("invalid_slot");
      if (stashCount(state) >= STASH_LIMIT) throw new GameError("stash_full");
      const offer = slot.offer;
      const mon = newPokemon(uid(state), offer.species, offer.level, offer, 0, moveSlotsFor(state.subclass));
      state.pieces[mon.uid] = mon;
      slot.offer = null;
      slot.locked = false;
      break;
    }
    case "POKE_BALL":
    case "GREAT_BALL":
    case "ULTRA_BALL": {
      requireSeed(state);
      const rolled: Tier = item.item === "ULTRA_BALL" ? 3 : item.item === "GREAT_BALL" ? 2 : 1;
      const { tier, species: pool } = championSpeciesOfTier(state, rolled);
      addPokemonToStash(state, rng.pick(pool), roundLevel(state, tier), rng);
      break;
    }
    case "VOUCHER": {
      requireSeed(state);
      const { species, tier } = randomSpecies(state, rng, [30, 30, 20, 12, 8]);
      addPokemonToStash(state, species, roundLevel(state, tier), rng);
      break;
    }
    case "ROOT_FOSSIL":
    case "CLAW_FOSSIL": {
      requireSeed(state);
      const species = item.item === "ROOT_FOSSIL" ? "LILEEP" : "ANORITH";
      addPokemonToStash(state, species, roundLevel(state, 2), rng);
      break;
    }
    default:
      throw new GameError("not_usable");
  }
  delete state.pieces[item.uid];
}

function grantSubclass(state: RunState): void {
  const grant = (key: string, param?: string) => {
    const piece: ItemPiece = { uid: uid(state), kind: "item", place: null, paid: 0, item: key, age: 0, ...(param ? { param } : {}) };
    state.pieces[piece.uid] = piece;
  };
  if (state.subclass === "steven_mega") grant("METAGROSSITE");
  if (state.subclass === "geeta_stellar") grant("TERA_SHARD", "stellar");
  if (state.subclass === "kukui_research") {
    for (const p of Object.values(state.pieces)) if (p.kind === "pokemon") refreshMoves(p, moveSlotsFor(state.subclass));
  }
}

/** Applies one player action. Pure: returns a new state, throws GameError when illegal. */
export function applyAction(prev: RunState, input: Action): RunState {
  const action = readAction(input);
  const state: RunState = structuredClone(prev);
  state.notices = [];
  if (state.phase === "ended") throw new GameError("run_ended");
  switch (action.t) {
    case "chooseSubclass": {
      requirePhase(state, "subclass");
      if (!CHAMPIONS[state.champion].subclasses.includes(action.subclass)) throw new GameError("subclass_invalid");
      requireSeed(state);
      state.subclass = action.subclass;
      state.phase = "shop";
      grantSubclass(state);
      state.shop = rollShop(state, 0);
      return state;
    }
    case "buy": {
      requirePhase(state, "shop");
      const slot = state.shop[action.slot];
      if (!slot || !slot.offer) throw new GameError("invalid_slot");
      const price = slotPrice(slot, state);
      if (price > state.gold) throw new GameError("not_enough_gold");
      const offer = slot.offer;
      let piece: Piece;
      if (offer.kind === "pokemon") {
        piece = newPokemon(uid(state), offer.species, offer.level, offer, price, moveSlotsFor(state.subclass));
      } else if (offer.kind === "item") {
        piece = { uid: uid(state), kind: "item", place: null, paid: price, item: offer.item, age: 0, ...(offer.param ? { param: offer.param } : {}) };
      } else {
        piece = { uid: uid(state), kind: "bag", place: null, paid: price, bag: offer.bag };
      }
      if (!action.place && piece.kind === "bag") throw new GameError("bag_needs_place");
      if (!action.place && stashCount(state) >= STASH_LIMIT) throw new GameError("stash_full");
      if (action.place && piece.kind === "bag") {
        const err = checkPlacement(state.pieces, piece, action.place);
        if (err) throw new GameError(err);
        state.pieces[piece.uid] = piece;
        piece.place = { ...action.place };
      } else if (action.place) {
        place(state, piece, action.place);
        state.pieces[piece.uid] = piece;
      } else {
        state.pieces[piece.uid] = piece;
      }
      state.gold -= price;
      slot.offer = null;
      slot.locked = false;
      resolveRecipes(state, [piece.uid]);
      return state;
    }
    case "sell": {
      requirePhase(state, "shop");
      const piece = requirePiece(state, action.uid);
      if (isStarterBag(piece)) throw new GameError("cannot_sell");
      if (bagHasContents(state.pieces, piece)) throw new GameError("bag_not_empty");
      state.gold += sellValue(state, piece);
      delete state.pieces[piece.uid];
      if (state.ace === piece.uid) state.ace = null;
      return state;
    }
    case "move": {
      requirePhase(state, "shop");
      const piece = requirePiece(state, action.uid);
      if (piece.kind === "bag") {
        if (!action.place) throw new GameError("bag_needs_place");
        if (piece.place) moveBag(state, piece, action.place);
        else place(state, piece, action.place);
        resolveRecipes(state, []);
        return state;
      }
      place(state, piece, action.place);
      resolveRecipes(state, [piece.uid]);
      return state;
    }
    case "reroll": {
      requirePhase(state, "shop");
      requireSeed(state);
      const cost = rerollCost(state);
      if (cost > state.gold) throw new GameError("not_enough_gold");
      state.gold -= cost;
      state.rerolls += 1;
      state.shop = rollShop(state, state.rerolls);
      return state;
    }
    case "lock": {
      requirePhase(state, "shop");
      const slot = state.shop[action.slot];
      if (!slot || !slot.offer) throw new GameError("invalid_slot");
      slot.locked = !slot.locked;
      return state;
    }
    case "setAce": {
      requirePhase(state, "shop");
      if (state.champion !== "red") throw new GameError("not_red");
      const piece = requirePiece(state, action.uid);
      if (piece.kind !== "pokemon") throw new GameError("invalid_target");
      state.ace = piece.uid;
      return state;
    }
    case "use": {
      requirePhase(state, "shop");
      const piece = requirePiece(state, action.uid);
      if (piece.kind !== "item") throw new GameError("not_usable");
      useItem(state, piece, action);
      return state;
    }
    default:
      throw new GameError("unknown_action");
  }
}

/**
 * Where a placed piece goes when turned a quarter turn: around its own centre, or failing that the
 * nearest spot that fits without pushing anything else aside (a bag still carries what lies on it).
 * Null when nothing within reach fits.
 */
export function rotationSpot(state: RunState, uid: string): Placement | null {
  const piece = state.pieces[uid];
  if (!piece?.place) return null;
  // A bag turns with its whole group around the group's centre.
  const group = piece.kind === "bag" ? bagGroup(state.pieces, piece) : null;
  const shape = group?.shape ?? pieceShape(piece);
  const from = group?.place ?? piece.place;
  const rot = ((from.rot + 1) % 4) as Rot;
  const before = shapeSize(rotateShape(shape, from.rot));
  const after = shapeSize(rotateShape(shape, rot));
  const bx = Math.round(from.x + (before.w - after.w) / 2);
  const by = Math.round(from.y + (before.h - after.h) / 2);
  const carried = new Set([uid, ...(group ? [...group.bags, ...group.carried].map((p) => p.uid) : [])]);
  // Only placed pieces can be pushed aside; pieces waiting in the stash stay there.
  const bystanders = Object.values(state.pieces).filter((p) => p.place && !carried.has(p.uid));
  for (let ring = 0; ring <= 3; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const place: Placement = { x: bx + dx, y: by + dy, rot };
        let next: RunState;
        try {
          next = applyAction(state, { t: "move", uid, place });
        } catch {
          continue;
        }
        const pushed = bystanders.some((p) => {
          const after = next.pieces[p.uid]?.place;
          return !after || !p.place || after.x !== p.place.x || after.y !== p.place.y || after.rot !== p.place.rot;
        });
        if (!pushed) return place;
      }
    }
  }
  return null;
}

export function applyActions(state: RunState, actions: readonly Action[]): RunState {
  let s = state;
  for (const a of actions) s = applyAction(s, a);
  return s;
}

export { ITEMS };
