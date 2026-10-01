import { BAGS, rectShape, type Cell } from "../board.ts";
import { CONTENT, getMove, getSpecies, IMPLEMENTED_ABILITIES, itemSize } from "../content/index.ts";
import { STAT_KEYS, type MoveDef, type SpeciesDef, type Stats } from "../content/schema.ts";
import type { Rng } from "../rng.ts";
import { NATURES, type Nature } from "../stats.ts";
import type { Piece, PokemonPiece } from "./types.ts";

export const SHINY_RATE = 1 / 64;
export const HIDDEN_ABILITY_RATE = 1 / 16;
export const MAX_LEVEL = 100;
export const MAX_IV = 31;

export interface Traits {
  ivs: Stats;
  nature: Nature;
  ability: string;
  hiddenAbility: boolean;
  shiny: boolean;
}

export function rollIvs(rng: Rng): Stats {
  return {
    hp: rng.int(0, MAX_IV),
    atk: rng.int(0, MAX_IV),
    def: rng.int(0, MAX_IV),
    spa: rng.int(0, MAX_IV),
    spd: rng.int(0, MAX_IV),
    spe: rng.int(0, MAX_IV),
  };
}

/** Regular abilities a species rolls from: the ones that work in battle, if it has any. */
function regularAbilities(s: SpeciesDef): string[] {
  const implemented = s.abilities.filter((a) => IMPLEMENTED_ABILITIES.has(a));
  return implemented.length > 0 ? implemented : s.abilities;
}

export function rollTraits(speciesKey: string, rng: Rng, shinyMultiplier = 1): Traits {
  const s = getSpecies(speciesKey);
  const ivs = rollIvs(rng);
  const nature = rng.pick(NATURES);
  const hiddenRoll = rng.chance(HIDDEN_ABILITY_RATE);
  const shiny = rng.chance(SHINY_RATE * shinyMultiplier);
  if (hiddenRoll && s.hiddenAbility) {
    return { ivs, nature, ability: s.hiddenAbility, hiddenAbility: true, shiny };
  }
  return { ivs, nature, ability: rng.pick(regularAbilities(s)), hiddenAbility: false, shiny };
}

/** Every ability a species can roll: its regular ones, then its hidden one. */
export function abilityOptions(speciesKey: string): { ability: string; hidden: boolean }[] {
  const s = getSpecies(speciesKey);
  const regular = [...new Set(regularAbilities(s))];
  const out = regular.map((ability) => ({ ability, hidden: false }));
  if (s.hiddenAbility && !regular.includes(s.hiddenAbility)) out.push({ ability: s.hiddenAbility, hidden: true });
  return out;
}

/** A champion's starter as the player trained it with points (meta/progress.ts), laid over the rolled traits. */
export interface StarterSetup {
  nature?: Nature;
  ability?: { ability: string; hidden: boolean };
  /** Added to each rolled IV (never past MAX_IV). */
  ivBonus?: Partial<Stats>;
  /** Shown instead of the species name, to the opponent too. */
  nickname?: string;
}

export function trainTraits(speciesKey: string, traits: Traits, setup: StarterSetup | undefined): Traits {
  if (!setup) return traits;
  const out: Traits = { ...traits, ivs: { ...traits.ivs } };
  if (setup.nature && NATURES.includes(setup.nature)) out.nature = setup.nature;
  const kept = setup.ability;
  // A kept ability only counts while the starter can still have it (the roster may change between patches).
  if (kept && abilityOptions(speciesKey).some((o) => o.ability === kept.ability && o.hidden === kept.hidden)) {
    out.ability = kept.ability;
    out.hiddenAbility = kept.hidden;
  }
  for (const k of STAT_KEYS) out.ivs[k] = Math.min(MAX_IV, out.ivs[k] + Math.max(0, Math.floor(setup.ivBonus?.[k] ?? 0)));
  return out;
}

/** Physical attackers prefer physical moves, special attackers special ones. */
function categoryFit(move: MoveDef, species: SpeciesDef): number {
  const { atk, spa } = species.baseStats;
  const stat = move.category === "physical" ? atk : spa;
  return 0.55 + 0.45 * (stat / Math.max(atk, spa, 1));
}

function isSelfKo(move: MoveDef): boolean {
  return move.effects.some((e) => e.kind === "selfFaint");
}

/** Rough value of a move for automatic moveset selection (attacks and status moves on one scale). */
export function moveScore(move: MoveDef, species: SpeciesDef): number {
  const acc = move.accuracy === null ? 1.05 : move.accuracy / 100;
  if (move.category !== "status") {
    let power = move.power;
    for (const e of move.effects) {
      if (e.kind === "multiHit") power *= (e.min + e.max) / 2;
      if (e.kind === "storedPower" || e.kind === "hex" || e.kind === "venoshock" || e.kind === "facade") power *= 1.3;
      if (e.kind === "weightPower" || e.kind === "reversal") power = Math.max(power, 60);
      if (e.kind === "eruption") power = Math.max(power, 90);
      if (e.kind === "fixedDamage" || e.kind === "levelDamage" || e.kind === "halveHp") power = Math.max(power, 70);
      if (e.kind === "ohko") power = 90;
      if (e.kind === "recharge") power *= 0.7;
      if (e.kind === "selfFaint") power *= 0.3;
      if (e.kind === "charge" && !e.skipIn) power *= 0.6;
      if (e.kind === "recoil") power *= e.basis === "maxHp" ? 1 - e.ratio : 1 - e.ratio * 0.25;
      if (e.kind === "fakeOut") power = 60;
    }
    const ownType = species.types.includes(move.type);
    const stab = ownType ? 1.5 : 1;
    const spread = move.target === "enemySpread" || move.target === "allAround" || move.target === "allEnemies";
    let drawback = 1;
    for (const e of move.effects) {
      // Attacks that lower the user's own stats (Overheat, Close Combat) are worth a bit less.
      if (e.kind === "stages" && e.target === "self" && e.delta < 0) drawback *= 1 - 0.1 * e.stats.length * -e.delta;
    }
    // Normal coverage hits nothing super-effectively; partial moves miss part of their effect.
    const coverage = move.type === "normal" && !ownType ? 0.7 : 1;
    return power * stab * acc * (spread ? 1.1 : 1) * categoryFit(move, species) * drawback * coverage * (move.partial ? 0.75 : 1);
  }
  const { atk, spa } = species.baseStats;
  const boostWorth = (stat: string) => (stat === "atk" ? atk / Math.max(atk, spa, 1) : stat === "spa" ? spa / Math.max(atk, spa, 1) : stat === "acc" ? 0.3 : 0.8);
  let value = 0;
  for (const e of move.effects) {
    switch (e.kind) {
      case "stages":
        // Debuffing the enemy is weak in a team fight; boosting the stat you attack with snowballs.
        if (e.target === "target") value += 10 * e.stats.length * Math.abs(e.delta);
        else for (const stat of e.stats) value += 35 * e.delta * boostWorth(stat);
        break;
      case "status":
        value += e.status === "slp" ? 75 : e.status === "tox" ? 55 : 50;
        break;
      case "confuse":
        value += 30;
        break;
      case "heal":
        value += 55;
        break;
      case "rest":
        // Full heal, but asleep for a while in a fight that keeps going.
        value += 25;
        break;
      case "weather":
      case "terrain":
        value += 40;
        break;
      case "screen":
      case "tailwind":
        value += 45;
        break;
      case "leechSeed":
        value += 45;
        break;
      case "protect":
        value += 25;
        break;
      case "metronome":
        value += 50;
        break;
      case "transform":
        value += 60;
        break;
      case "bellyDrum":
        value += 60;
        break;
      case "focusEnergy":
        value += 25;
        break;
      default:
        value += 5;
    }
  }
  return Math.min(90, value) * acc;
}

/** Moves a species knows at a level: level-up moves, level-gated TM/egg moves and TM-taught moves. */
export function knownMoves(speciesKey: string, level: number, taught: readonly string[]): string[] {
  const s = getSpecies(speciesKey);
  const known = new Set<string>(taught);
  for (const [lvl, move] of s.learnset) if (lvl <= level) known.add(move);
  for (const [lvl, move] of s.extraMoves ?? []) if (lvl <= level) known.add(move);
  return [...known].filter((k) => CONTENT.moves[k] && k !== "STRUGGLE");
}

/**
 * Picks the moveset for a Pokémon at a level. TM-taught moves stay; then the best attack of each
 * of its own types (STAB); then the best remaining moves, spreading attack types and allowing at
 * most one status move. Self-KO moves are only a last resort.
 */
export function chooseMoves(speciesKey: string, level: number, taught: readonly string[], slots = 4): string[] {
  const s = getSpecies(speciesKey);
  const candidates = knownMoves(speciesKey, level, taught).map((k) => getMove(k));
  const safeAttacks = candidates.filter((m) => m.category !== "status" && !isSelfKo(m));
  const attacks = safeAttacks.length > 0 ? safeAttacks : candidates.filter((m) => m.category !== "status");
  const statuses = candidates.filter((m) => m.category === "status");
  const score = new Map(candidates.map((m) => [m.key, moveScore(m, s)]));

  const picked: MoveDef[] = [];
  const typeCount = new Map<string, number>();
  const add = (m: MoveDef) => {
    picked.push(m);
    if (m.category !== "status") typeCount.set(m.type, (typeCount.get(m.type) ?? 0) + 1);
  };
  const best = (pool: MoveDef[], typePenalty: boolean): MoveDef | null => {
    let top: MoveDef | null = null;
    let topScore = -Infinity;
    for (const m of pool) {
      if (picked.includes(m)) continue;
      let v = score.get(m.key)!;
      if (typePenalty && m.category !== "status") for (let i = 0; i < (typeCount.get(m.type) ?? 0); i++) v *= 0.5;
      if (v > topScore) {
        top = m;
        topScore = v;
      }
    }
    return top;
  };

  // TM-taught moves are always kept (newest last, so the oldest drop first when over the limit).
  for (const key of taught.slice(-slots)) {
    const m = CONTENT.moves[key];
    if (m && !picked.includes(m)) add(m);
  }
  // One STAB attack per own type, strongest first.
  const stabPicks = s.types
    .map((t) => best(attacks.filter((m) => m.type === t), false))
    .filter((m): m is MoveDef => m !== null)
    .sort((a, b) => score.get(b.key)! - score.get(a.key)!);
  for (const m of stabPicks) if (picked.length < slots && !picked.includes(m)) add(m);
  // Fill the rest: at least two attacks when there are, at most one status move unless nothing else is left.
  while (picked.length < slots) {
    const attackCount = picked.filter((m) => m.category !== "status").length;
    const statusCount = picked.length - attackCount;
    const pool = attackCount < 2 || statusCount >= 1 ? attacks : [...attacks, ...statuses];
    const next = best(pool, true) ?? best(statuses, false);
    if (!next) break;
    add(next);
  }
  if (picked.length === 0) return ["STRUGGLE"].filter((k) => CONTENT.moves[k]);
  return picked.map((m) => m.key);
}

export function moveSlotsFor(subclass: string | null): number {
  return subclass === "kukui_research" ? 5 : 4;
}

export function newPokemon(
  uid: string,
  speciesKey: string,
  level: number,
  traits: Traits,
  paid: number,
  moveSlots: number,
): PokemonPiece {
  return {
    uid,
    kind: "pokemon",
    place: null,
    paid,
    species: speciesKey,
    level,
    ivs: { ...traits.ivs },
    nature: traits.nature,
    ability: traits.ability,
    hiddenAbility: traits.hiddenAbility,
    shiny: traits.shiny,
    moves: chooseMoves(speciesKey, level, [], moveSlots),
    disabled: [],
    taught: [],
    battles: 0,
    aceBonus: 0,
    pendingEvolution: null,
  };
}

/** Re-picks moves after a level-up, evolution or TM; keeps what the player disabled. */
export function refreshMoves(p: PokemonPiece, moveSlots: number): void {
  p.moves = chooseMoves(p.species, p.level, p.taught, moveSlots);
  p.disabled = p.disabled.filter((m) => p.moves.includes(m));
}

/** Keeps the same ability slot across evolution (first, second or hidden). */
export function evolveAbility(from: SpeciesDef, to: SpeciesDef, ability: string, hidden: boolean): string {
  if (hidden && to.hiddenAbility) return to.hiddenAbility;
  const idx = Math.max(0, from.abilities.indexOf(ability));
  return to.abilities[idx] ?? to.abilities[0] ?? ability;
}

export function pieceShape(piece: Piece): Cell[] {
  switch (piece.kind) {
    case "pokemon": {
      const s = getSpecies(piece.species);
      return rectShape(s.footprint.w, s.footprint.h);
    }
    case "item": {
      const { w, h } = itemSize(piece.item);
      return rectShape(w, h);
    }
    case "bag":
      return BAGS[piece.bag]!.cells;
  }
}
