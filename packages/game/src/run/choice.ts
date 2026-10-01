import { CHAMPIONS, CONTENT, getSpecies, typeEffectiveness, type ChampionKey, type TypeKey } from "../content/index.ts";
import { calcStats } from "../stats.ts";
import { computeAdjacency, type Adjacency } from "./layout.ts";
import { moveScore } from "./pokemon.ts";
import type { ItemPiece, Piece, PokemonPiece, TeamSnapshot } from "./types.ts";

/**
 * Choice items power one Pokémon they touch, which then uses only one attack. Both are the player's pick
 * (the "choice" action); until then it is the strongest touching Pokémon and its strongest STAB attack.
 * Moves are chosen by the battle AI here, so a lock on whatever was used first (the main-series rule) kept
 * about 1 in 5 holders on a status move; a lock the player chooses is a decision instead of a trap.
 * The value is the attack category the item boosts and the only kind of move it locks (null: Choice Scarf, any attack),
 * so a Choice Specs next to physical attackers stays idle instead of locking one of them for nothing.
 */
export const CHOICE_ITEMS: Record<string, "physical" | "special" | null> = {
  CHOICE_BAND: "physical",
  CHOICE_SPECS: "special",
  CHOICE_SCARF: null,
};

/**
 * The powered Pokémon's stat multiplier (Band: Attack, Specs: Sp. Atk, Scarf: Speed). Higher than the main series'
 * ×1.5: without switching, one attack all battle costs more. On bot boards with the default pick (2026-10-01), against
 * the same board without the item: ×1.5 37–49% (worse than nothing), ×1.8 43–58%, ×2 41–60% (Leftovers 58–68%).
 */
export const CHOICE_BOOST = 2;

/** Attacks of the item's category a Pokémon can be locked into, best first: STAB, then the moveset score. */
export function choiceMoves(mon: PokemonPiece, item: string): string[] {
  const species = getSpecies(mon.species);
  const want = CHOICE_ITEMS[item];
  const rank = (key: string): number[] => {
    const m = CONTENT.moves[key]!;
    return [species.types.includes(m.type) ? 1 : 0, moveScore(m, species)];
  };
  return mon.moves
    .filter((k) => {
      const m = CONTENT.moves[k];
      return m && m.category !== "status" && (want === null || m.category === want);
    })
    .map((key, i) => ({ key, i, r: rank(key) }))
    .sort((a, b) => b.r[0]! - a.r[0]! || b.r[1]! - a.r[1]! || a.i - b.i)
    .map((x) => x.key);
}

/** How much a Pokémon gets out of a Choice item: its best lockable attack times the stat that attack uses. */
function choiceValue(mon: PokemonPiece, item: string): number {
  const move = choiceMoves(mon, item)[0];
  if (!move) return 0;
  const species = getSpecies(mon.species);
  const m = CONTENT.moves[move]!;
  const stats = calcStats(species.baseStats, mon.ivs, mon.level, mon.nature);
  return moveScore(m, species) * (m.category === "physical" ? stats.atk : stats.spa);
}

export interface ChoicePicks {
  /** Choice item uid → the Pokémon it powers. */
  holder: Map<string, string>;
  /** Pokémon uid → the only move it uses. */
  lock: Map<string, string>;
}

/**
 * Who each placed Choice item powers and what that Pokémon is locked into. A pick stays while the item still
 * touches the Pokémon and the Pokémon still knows the move; otherwise the default takes over. Two Choice items on
 * one Pokémon share its lock (the first item by uid decides the default).
 */
export function choicePicks(pieces: Record<string, Piece>, adj: Adjacency = computeAdjacency(pieces)): ChoicePicks {
  const holder = new Map<string, string>();
  const lock = new Map<string, string>();
  const items = Object.values(pieces)
    .filter((p): p is ItemPiece => p.kind === "item" && p.place !== null && p.item in CHOICE_ITEMS)
    .sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));
  for (const it of items) {
    // Klutz ignores held items, and a Pokémon without attacks has nothing to lock into.
    const touching = (adj.holdersOf.get(it.uid) ?? [])
      .map((u) => pieces[u] as PokemonPiece)
      .filter((m) => m.ability !== "KLUTZ" && choiceMoves(m, it.item).length > 0);
    let mon = touching.find((m) => m.uid === it.choiceFor);
    if (!mon) {
      let best = -1;
      for (const m of touching) {
        const v = choiceValue(m, it.item);
        if (v > best) [mon, best] = [m, v];
      }
    }
    if (!mon) continue;
    holder.set(it.uid, mon.uid);
    if (lock.has(mon.uid)) continue;
    const moves = choiceMoves(mon, it.item);
    lock.set(mon.uid, mon.choiceMove && moves.includes(mon.choiceMove) ? mon.choiceMove : moves[0]!);
  }
  return { holder, lock };
}

/** How well an attack would do with a Choice item against a previewed champion's main types. */
function previewValue(mon: PokemonPiece, move: string, item: string, against: readonly TypeKey[]): number {
  const species = getSpecies(mon.species);
  const m = CONTENT.moves[move]!;
  const stats = calcStats(species.baseStats, mon.ivs, mon.level, mon.nature);
  const eff = against.length === 0 ? 1 : against.reduce((sum, t) => sum + typeEffectiveness(m.type, [t]), 0) / against.length;
  return moveScore(m, species) * (m.category === "physical" ? stats.atk : stats.spa) * eff;
}

/**
 * The picks of a player who reads the opponent preview (the next champion and its main types, ChampionDef.mainTypes):
 * each Choice item goes to the touching Pokémon and attack that hit those types hardest. The balance harness uses it
 * (`--choice-preview`) to measure the Choice items as a player would set them, not only with the default pick.
 */
export function previewChoicePicks(team: TeamSnapshot, opponent: ChampionKey): TeamSnapshot {
  const against = CHAMPIONS[opponent].mainTypes;
  const pieces: Record<string, Piece> = Object.fromEntries(team.pieces.filter((p) => p.place).map((p) => [p.uid, structuredClone(p)]));
  const adj = computeAdjacency(pieces);
  const items = Object.values(pieces)
    .filter((p): p is ItemPiece => p.kind === "item" && p.item in CHOICE_ITEMS)
    .sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));
  // A Pokémon has one lock: a second Choice item on it keeps the move the first one picked.
  const picked = new Map<string, string>();
  for (const it of items) {
    let best: { mon: PokemonPiece; move: string; value: number } | null = null;
    for (const uid of adj.holdersOf.get(it.uid) ?? []) {
      const mon = pieces[uid] as PokemonPiece;
      if (mon.ability === "KLUTZ") continue;
      const moves = picked.has(uid) ? [picked.get(uid)!] : choiceMoves(mon, it.item);
      for (const move of moves) {
        const value = previewValue(mon, move, it.item, against);
        if (!best || value > best.value) best = { mon, move, value };
      }
    }
    if (!best) continue;
    it.choiceFor = best.mon.uid;
    best.mon.choiceMove = best.move;
    picked.set(best.mon.uid, best.move);
  }
  return { ...team, pieces: team.pieces.map((p) => pieces[p.uid] ?? p) };
}
