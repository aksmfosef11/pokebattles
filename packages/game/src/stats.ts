import type { StatKey, Stats } from "./content/schema.ts";

/** PokéRogue Nature enum order; locale keys under `natures`. */
export const NATURES = [
  "HARDY",
  "LONELY",
  "BRAVE",
  "ADAMANT",
  "NAUGHTY",
  "BOLD",
  "DOCILE",
  "RELAXED",
  "IMPISH",
  "LAX",
  "TIMID",
  "HASTY",
  "SERIOUS",
  "JOLLY",
  "NAIVE",
  "MODEST",
  "MILD",
  "QUIET",
  "BASHFUL",
  "RASH",
  "CALM",
  "GENTLE",
  "SASSY",
  "CAREFUL",
  "QUIRKY",
] as const;
export type Nature = (typeof NATURES)[number];

const NATURE_STAT_ORDER: StatKey[] = ["atk", "def", "spe", "spa", "spd"];

export function natureEffect(nature: Nature): { up: StatKey | null; down: StatKey | null } {
  const i = NATURES.indexOf(nature);
  const up = NATURE_STAT_ORDER[Math.floor(i / 5)]!;
  const down = NATURE_STAT_ORDER[i % 5]!;
  return up === down ? { up: null, down: null } : { up, down };
}

/**
 * Battle HP is multiplied relative to the mainline formula so auto-battles last long enough to read.
 * Later rounds field many more Pokémon, so the multiplier grows with the round.
 */
export const BATTLE_HP_MULTIPLIER = 2;
export const BATTLE_HP_PER_ROUND = 0.3;

export function battleHpMultiplier(round: number): number {
  return BATTLE_HP_MULTIPLIER + BATTLE_HP_PER_ROUND * Math.max(0, round - 1);
}

export function calcStats(base: Stats, ivs: Stats, level: number, nature: Nature): Stats {
  const { up, down } = natureEffect(nature);
  const other = (k: StatKey) => {
    const raw = Math.floor(((2 * base[k] + ivs[k]) * level) / 100) + 5;
    const mod = k === up ? 1.1 : k === down ? 0.9 : 1;
    return Math.floor(raw * mod);
  };
  // Shedinja-style 1 HP species keep 1 HP.
  const hp = base.hp === 1 ? 1 : Math.floor(((2 * base.hp + ivs.hp) * level) / 100) + level + 10;
  return { hp, atk: other("atk"), def: other("def"), spa: other("spa"), spd: other("spd"), spe: other("spe") };
}

export function ivTotal(ivs: Stats): number {
  return ivs.hp + ivs.atk + ivs.def + ivs.spa + ivs.spd + ivs.spe;
}
