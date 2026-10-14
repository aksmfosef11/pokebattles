import { BAGS } from "../board.ts";
import { CHAMPION_RULES } from "../content/champions.ts";
import { CONTENT, getMove, getSpecies, itemEvolutions, ITEMS, makesItemWork, TYPES, type Tier, type TypeKey } from "../content/index.ts";
import { rngFor, type Rng } from "../rng.ts";
import { stackMul } from "../battle/calc.ts";
import { rollTraits } from "./pokemon.ts";
import { championPool, championSpeciesByTier, championSpeciesOfTier, isLanceKinLine, lineBase } from "./pool.ts";
import type { Notice, Offer, PokemonPiece, RunState, ShopSlot } from "./types.ts";

/**
 * Shop slots grow once, when tier 4 opens and the tiers start to thin each other out: 5 until round 8,
 * 6 from round 9. Slots are rolled by index, so the first five roll exactly what they did with five.
 */
export const SHOP_SIZE_STEPS: readonly (readonly [round: number, slots: number])[] = [
  [1, 5],
  [9, 6],
];
export const MAX_SHOP_SIZE = SHOP_SIZE_STEPS[SHOP_SIZE_STEPS.length - 1]![1];

export function shopSize(round: number): number {
  let size = SHOP_SIZE_STEPS[0]![1];
  for (const [from, n] of SHOP_SIZE_STEPS) if (round >= from) size = n;
  return size;
}

export const MAX_ROUNDS = 18;
export const INCOME = [10, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13, 14, 14, 15, 15, 16, 16];
/** Tier 5 (the box legendaries) opens at round 10, so runs that go well still meet one before they clear (10 wins). */
export const TIER_UNLOCK: Record<Tier, number> = { 1: 1, 2: 3, 3: 6, 4: 9, 5: 10 };
export const POKEMON_PRICE: Record<Tier, number> = { 1: 3, 2: 5, 3: 7, 4: 10, 5: 14 };
export const TIER_LEVEL: Record<Tier, number> = { 1: 8, 2: 16, 3: 26, 4: 36, 5: 45 };
/**
 * Shop Pokémon gain a level per round after their tier opens; legendaries gain this many instead, so one bought
 * at round 12–14 is not left far behind the party (live boards: best Pokémon Lv49 at round 10, Lv60 at 12).
 * Counted from round 10 for everyone, so Cynthia's early legendaries join lower (Lv43 at round 9).
 */
export const LEGEND_LEVEL_PER_ROUND = 2;

/** Level of a shop (or Poké Ball) Pokémon of a tier at a round. */
export function offerLevel(tier: Tier, round: number): number {
  if (tier === 5) return TIER_LEVEL[5] + LEGEND_LEVEL_PER_ROUND * (round - TIER_UNLOCK[5]);
  return TIER_LEVEL[tier] + Math.max(0, round - TIER_UNLOCK[tier]);
}
export const SALE_CHANCE = 0.1;
export const SUBCLASS_ROUND = 8;
export const WINS_TO_CLEAR = 10;
export const STARTING_LIVES = 5;
export const STASH_LIMIT = 12;
/**
 * Pokémon that can fight at once (on the board) grows with the run as the bags do:
 * 6 at the start, 7 from round 5, 8 from round 8, 9 from round 11. The stash holds extras.
 */
export const PARTY_CAP_STEPS: readonly (readonly [round: number, cap: number])[] = [
  [1, 6],
  [5, 7],
  [8, 8],
  [11, 9],
];

export function basePartyCap(round: number): number {
  let cap = PARTY_CAP_STEPS[0]![1];
  for (const [from, n] of PARTY_CAP_STEPS) if (round >= from) cap = n;
  return cap;
}

export function partyCap(state: Pick<RunState, "champion" | "round">): number {
  return basePartyCap(state.round) + (state.champion === "alder" ? CHAMPION_RULES.alder.partyCapBonus : 0);
}

export function partyCount(state: Pick<RunState, "pieces">): number {
  return Object.values(state.pieces).filter((p) => p.kind === "pokemon" && p.place !== null).length;
}

export function isSmallMon(p: PokemonPiece): boolean {
  const f = getSpecies(p.species).footprint;
  return f.w * f.h === 1;
}

/** Pokémon on the board bigger than 1×1: Alder's extra slot is for 1×1 Pokémon only, so these stay within the base cap. */
export function bigPartyCount(state: Pick<RunState, "pieces">): number {
  return Object.values(state.pieces).filter((p): p is PokemonPiece => p.kind === "pokemon" && p.place !== null && !isSmallMon(p)).length;
}

const TIERS: Tier[] = [1, 2, 3, 4, 5];

/** Tier 1–4 weights per round band; tier 5 comes from LEGEND_WEIGHTS. */
const ODDS: [number, number[]][] = [
  [2, [100, 0, 0, 0]],
  [5, [70, 30, 0, 0]],
  [8, [45, 40, 15, 0]],
  [11, [30, 35, 25, 10]],
  [14, [20, 30, 30, 15]],
  [99, [15, 25, 30, 20]],
];

/** Tier 5 weight by rounds since legendaries opened for the champion; the last value holds from then on. */
export const LEGEND_WEIGHTS: readonly number[] = [4, 4, 7];

/** Round a champion's shop starts offering legendaries (tier 5): Cynthia's comes earlier. */
export function legendUnlockRound(champion: RunState["champion"]): number {
  return champion === "cynthia" ? CHAMPION_RULES.cynthia.legendaryUnlockRound : TIER_UNLOCK[5];
}

export function tierOdds(state: Pick<RunState, "champion" | "round">): number[] {
  const odds = [...ODDS.find(([maxRound]) => state.round <= maxRound)![1]];
  const since = state.round - legendUnlockRound(state.champion);
  let legend = since < 0 ? 0 : LEGEND_WEIGHTS[Math.min(since, LEGEND_WEIGHTS.length - 1)]!;
  if (state.champion === "cynthia") legend *= CHAMPION_RULES.cynthia.legendaryWeightMultiplier;
  return [...odds, legend];
}

function rollTier(state: RunState, rng: Rng): Tier {
  const odds = tierOdds(state);
  return rng.weighted(TIERS.map((t, i) => [t, odds[i]!] as const));
}

export function rerollCost(state: RunState): number {
  return 1 + Math.floor(state.rerolls / 4);
}

function ownedSpecies(state: RunState): string[] {
  return Object.values(state.pieces).flatMap((p) => (p.kind === "pokemon" ? [p.species] : []));
}

let tmMovePool: string[] | null = null;
function allTmMoves(): string[] {
  if (!tmMovePool) {
    const set = new Set<string>();
    for (const s of Object.values(CONTENT.species)) for (const m of s.tmMoves) set.add(m);
    tmMovePool = [...set].sort();
  }
  return tmMovePool;
}

/** Kukui's TMs only teach strong attacks: power 80+, or 60+ when the move hits several targets. */
const KUKUI_TM_POWER = 80;
const KUKUI_TM_SPREAD_POWER = 60;
function isStrongTmMove(key: string): boolean {
  const m = getMove(key);
  if (m.category === "status") return false;
  return m.power >= KUKUI_TM_POWER || ((m.target === "enemySpread" || m.target === "allAround") && m.power >= KUKUI_TM_SPREAD_POWER);
}

/** Species the player could still use: their champion's pool, what they own and what that evolves into. */
function relevantSpecies(state: RunState): Set<string> {
  const out = new Set<string>();
  const queue = [...championPool(state), ...ownedSpecies(state)];
  while (queue.length > 0) {
    const key = queue.pop()!;
    const s = CONTENT.species[key];
    if (!s || out.has(key)) continue;
    out.add(key);
    for (const e of s.evolutions) queue.push(e.to);
  }
  return out;
}

function speciesAbilities(key: string): string[] {
  const s = getSpecies(key);
  return s.hiddenAbility ? [...s.abilities, s.hiddenAbility] : s.abilities;
}

/** Shop weight multiplier per owned Pokémon of the same evolution line. */
export const OWNED_LINE_WEIGHT = 0.5;

function rollPokemon(state: RunState, rng: Rng, rolled: Tier = rollTier(state, rng)): Offer {
  const { tier, species: tierSpecies } = championSpeciesOfTier(state, rolled);
  const pool = new Map<string, number>();
  for (const key of tierSpecies) pool.set(key, 1);
  if (state.subclass === "steven_regi" && tier >= 2) {
    for (const key of ["REGIROCK", "REGICE", "REGISTEEL"]) if (CONTENT.species[key]) pool.set(key, 1.5);
  }
  if (state.subclass === "alder_volcarona" && tier === 3 && CONTENT.species.LARVESTA) pool.set("LARVESTA", 2);
  if (pool.size === 0) return rollItem(state, rng);
  // Lines you already own show up less (×0.5 per copy): fewer repeats, no stack of the same pseudo-legendary.
  const owned = new Map<string, number>();
  for (const key of ownedSpecies(state)) owned.set(lineBase(key), (owned.get(lineBase(key)) ?? 0) + 1);
  let fullWeight = 0;
  const entries = [...pool.entries()].map(([key, w]) => {
    const s = getSpecies(key);
    let weight = w;
    if (state.champion === "lance" && isLanceKinLine(key)) weight *= CHAMPION_RULES.lance.dragonShopWeight;
    fullWeight += weight;
    return [key, weight * stackMul(OWNED_LINE_WEIGHT, owned.get(lineBase(key)) ?? 0)] as const;
  });
  // The weight owned lines lost goes a tier down instead of to the tier's other species, so an owned
  // line is halved even in a tier with a single species (Cynthia's only tier 4 is Garchomp).
  const keptWeight = entries.reduce((sum, [, w]) => sum + w, 0);
  if (!rng.chance(keptWeight / fullWeight)) return tier > 1 ? rollPokemon(state, rng, (tier - 1) as Tier) : rollItem(state, rng);
  const species = rng.weighted(entries);
  return { kind: "pokemon", tier, species, level: offerLevel(tier, state.round), ...rollTraits(species, rng) };
}

function rollItem(state: RunState, rng: Rng): Offer {
  const rolled = rollTier(state, rng);
  const owned = ownedSpecies(state);
  const ownedTypes = new Set<TypeKey>(owned.flatMap((s) => getSpecies(s).types));
  const relevant = relevantSpecies(state);
  for (let tier = rolled; tier >= 1; tier--) {
    const entries: [string, number][] = [];
    for (const def of Object.values(ITEMS)) {
      if (def.noShop || def.tier !== tier) continue;
      if (def.fromRound !== undefined && state.round < def.fromRound) continue;
      if (def.champions && !def.champions.includes(state.champion)) continue;
      // Evolution items only when this run can hold something they evolve; Steven's passive still uses stones as stones.
      if (def.family === "evolution" && !(state.champion === "steven" && def.stone) && !itemEvolutions(def.key).some((e) => relevant.has(e.from))) continue;
      let weight = (def.champions ? 2.5 : 1) * (def.weight ?? 1);
      // Species items only show up for Pokémon this champion can actually get.
      if (def.forSpecies) weight *= owned.includes(def.forSpecies) ? 6 : relevant.has(def.forSpecies) ? 0.1 : 0;
      // Steven's passive uses weather rocks as stones, so he gets them without a weather setter.
      if ((def.forAbilities || def.forMoves) && !(state.champion === "steven" && def.stone)) {
        // An owned Pokémon counts by the ability it really has (a hidden ability is rolled at 1/16) and the moves it knows.
        const fits = (key: string) => speciesAbilities(key).some((a) => def.forAbilities?.includes(a));
        const ownedFit = Object.values(state.pieces).some((p) => p.kind === "pokemon" && makesItemWork(def, p));
        weight *= ownedFit ? 6 : [...relevant].some(fits) ? 0.1 : 0;
      }
      if (def.key === "TM" && state.champion === "kukui") weight *= CHAMPION_RULES.kukui.tmShopWeight;
      if (def.mega) weight *= owned.includes(def.mega.species) ? 4 : relevant.has(def.mega.species) ? 0.5 : 0;
      if (weight <= 0) continue;
      entries.push([def.key, weight]);
    }
    if (entries.length === 0) continue;
    entries.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const item = rng.weighted(entries);
    const def = ITEMS[item]!;
    let param: string | undefined;
    if (def.param === "type") {
      const preferred = [...ownedTypes].sort();
      param = preferred.length > 0 && rng.chance(0.6) ? rng.pick(preferred) : rng.pick(TYPES);
    } else if (def.param === "move") {
      const compatible = [...new Set(owned.flatMap((s) => getSpecies(s).tmMoves))].sort();
      if (state.champion === "kukui") {
        // Always a strong attack one of his Pokémon can learn (any strong TM when none of them can).
        const strong = compatible.filter(isStrongTmMove);
        param = rng.pick(strong.length > 0 ? strong : allTmMoves().filter(isStrongTmMove));
      } else param = compatible.length > 0 && rng.chance(0.7) ? rng.pick(compatible) : rng.pick(allTmMoves());
    }
    return { kind: "item", tier: tier as Tier, item, ...(param ? { param } : {}) };
  }
  return rollBag(state, rng);
}

function rollBag(state: RunState, rng: Rng): Offer {
  const tier = rollTier(state, rng);
  const pool = Object.values(BAGS)
    .filter((b) => b.tier <= tier && !b.starter)
    .map((b) => [b.key, b.tier === tier ? 2 : 1] as const);
  const bag = rng.weighted(pool);
  return { kind: "bag", tier: BAGS[bag]!.tier, bag };
}

export function rollOffer(state: RunState, rng: Rng): Offer {
  // Items are the bulk of the shop; Pokémon get rarer once the party is full.
  const owned = Object.values(state.pieces).filter((p) => p.kind === "pokemon").length;
  const pokemonWeight = owned >= partyCap(state) ? 12 : 30;
  // The starting bag is small, so early shops lean on bags.
  const bagWeight = state.round <= 6 ? 22 : state.round <= 10 ? 14 : 8;
  const kind = rng.weighted([
    ["pokemon", pokemonWeight],
    ["item", 65],
    ["bag", bagWeight],
  ] as const);
  if (kind === "pokemon") return rollPokemon(state, rng);
  if (kind === "item") return rollItem(state, rng);
  return rollBag(state, rng);
}

export function basePrice(offer: Offer, state: RunState): number {
  switch (offer.kind) {
    case "pokemon": {
      let price = POKEMON_PRICE[offer.tier];
      const s = getSpecies(offer.species);
      if (state.subclass === "cynthia_myth" && (s.legendary || s.mythical || s.subLegendary)) {
        price -= CHAMPION_RULES.cynthia.mythPriceDiscount;
      }
      return Math.max(1, price);
    }
    case "item": {
      const def = ITEMS[offer.item]!;
      let price = def.price;
      if (def.key === "RARE_CANDY" && state.champion === "red") price = Math.floor(price * CHAMPION_RULES.red.rareCandyPriceMultiplier);
      if (def.key === "TM" && state.champion === "kukui") price = Math.floor(price * CHAMPION_RULES.kukui.tmPriceMultiplier);
      if (state.champion === "steven" && (def.family === "evolution" || def.family === "fossil")) {
        price -= CHAMPION_RULES.steven.stonePriceDiscount;
      }
      return Math.max(def.price === 0 ? 0 : 1, price);
    }
    case "bag": {
      const price = BAGS[offer.bag]!.price - (state.champion === "alder" ? CHAMPION_RULES.alder.bagPriceDiscount : 0);
      return Math.max(1, price);
    }
  }
}

export function slotPrice(slot: ShopSlot, state: RunState): number {
  if (!slot.offer) return 0;
  const price = basePrice(slot.offer, state);
  return slot.sale ? Math.max(price === 0 ? 0 : 1, Math.floor(price / 2)) : price;
}

/** A legendary from the run's pool (tier 5, locked lines left out), or null when the pool has none yet. */
function legendOffer(state: RunState, rng: Rng): Offer | null {
  const legends = championSpeciesByTier(state)[5];
  if (legends.length === 0) return null;
  const species = rng.pick(legends);
  return { kind: "pokemon", tier: 5, species, level: offerLevel(5, state.round), ...rollTraits(species, rng) };
}

/** True when this shop is the one that always shows a legendary: the opening shop of round 10, for every champion. */
export function isLegendShop(state: Pick<RunState, "round">, rerollIndex: number): boolean {
  return rerollIndex === 0 && state.round === TIER_UNLOCK[5];
}

/** "A legendary appeared" for the shop that always shows one (after rollShop(state, 0)). */
export function legendNotice(state: RunState): Notice | null {
  if (!isLegendShop(state, 0)) return null;
  const offer = state.shop.find((s) => s.offer?.kind === "pokemon" && s.offer.tier === 5)?.offer;
  return offer?.kind === "pokemon" ? { key: "notice.legendAppeared", params: { species: offer.species } } : null;
}

/** Opening shops of the first rounds always include a bag. */
export const GUARANTEED_BAG_ROUNDS = 3;

/**
 * The round the party grows to its last size (9) opens with a big bag. Live boards were tightest there:
 * evolved and legendary Pokémon waited in the stash while bags got rarer in the shop.
 */
export const BIG_BAG_ROUND = PARTY_CAP_STEPS[PARTY_CAP_STEPS.length - 1]![0];
export const BIG_BAGS: readonly string[] = ["BAG_2X3", "BAG_3X3"];

/** "The party grew, here is a big bag" for the opening shop of BIG_BAG_ROUND (after rollShop(state, 0)). */
export function bigBagNotice(state: RunState): Notice | null {
  if (state.round !== BIG_BAG_ROUND || !state.shop.some((s) => s.offer?.kind === "bag" && BIG_BAGS.includes(s.offer.bag))) return null;
  return { key: "notice.bigBagAppeared", params: { n: basePartyCap(state.round) } };
}

/** Rolls every unlocked slot. `rerollIndex` 0 is the round's opening shop. */
export function rollShop(state: RunState, rerollIndex: number): ShopSlot[] {
  const out: ShopSlot[] = [];
  for (let i = 0; i < shopSize(state.round); i++) {
    const prev = state.shop[i];
    if (prev && prev.locked && prev.offer) {
      out.push(prev);
      continue;
    }
    const rng = rngFor(state.seed, "shop", state.round, rerollIndex, i);
    out.push({ offer: rollOffer(state, rng), locked: false, sale: rng.chance(SALE_CHANCE) });
  }
  if (rerollIndex === 0 && state.round <= GUARANTEED_BAG_ROUNDS && !out.some((s) => s.offer?.kind === "bag")) {
    const last = out.findLastIndex((s) => !s.locked);
    if (last >= 0) out[last] = { offer: rollBag(state, rngFor(state.seed, "shop-bag", state.round)), locked: false, sale: false };
  }
  if (rerollIndex === 0 && state.round === BIG_BAG_ROUND && !out.some((s) => s.offer?.kind === "bag" && BIG_BAGS.includes(s.offer.bag))) {
    const last = out.findLastIndex((s) => !s.locked);
    const bag = rngFor(state.seed, "shop-big-bag", state.round).pick(BIG_BAGS);
    if (last >= 0) out[last] = { offer: { kind: "bag", tier: BAGS[bag]!.tier, bag }, locked: false, sale: false };
  }
  // Legendaries open with one in the first slot that is not locked, unless the shop already shows one.
  if (isLegendShop(state, rerollIndex) && !out.some((s) => s.offer?.kind === "pokemon" && s.offer.tier === 5)) {
    const first = out.findIndex((s) => !s.locked);
    const offer = legendOffer(state, rngFor(state.seed, "shop-legend", state.round));
    if (first >= 0 && offer) out[first] = { offer, locked: false, sale: false };
  }
  return out;
}
