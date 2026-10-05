/**
 * Champion classes (docs/DESIGN.md §6). Display names come from the `trainers` locale section
 * keyed by `key`; passive/subclass text comes from the game locale (`champion.<key>.*`).
 * Rule numbers live here so balance changes stay in one place; the engine reads them.
 */

import type { TypeKey } from "./schema.ts";

export type ChampionKey = "red" | "lance" | "steven" | "cynthia" | "alder" | "diantha" | "kukui" | "leon" | "geeta";

export const CHAMPION_KEYS: readonly ChampionKey[] = [
  "red",
  "lance",
  "steven",
  "cynthia",
  "alder",
  "diantha",
  "kukui",
  "leon",
  "geeta",
];

export type SubclassKey =
  | "red_pikachu"
  | "red_kanto"
  | "lance_hyperbeam"
  | "lance_dragondance"
  | "steven_mega"
  | "steven_regi"
  | "cynthia_myth"
  | "cynthia_diversity"
  | "alder_legion"
  | "alder_volcarona"
  | "diantha_dual"
  | "diantha_beauty"
  | "kukui_zmaster"
  | "kukui_royal"
  /** No longer offered (2026-10-04); runs and ghosts that picked it keep working. */
  | "kukui_research"
  | "leon_gmax"
  | "leon_champtime"
  | "geeta_stellar"
  | "geeta_investor";

export interface ChampionDef {
  key: ChampionKey;
  generation: number;
  starter: { species: string; item: string; itemParam?: string };
  subclasses: [SubclassKey, SubclassKey];
  /**
   * The champion's team in the main series. Their shop offers Pokémon of their own generation
   * plus these species' evolution lines, even when those come from other generations.
   */
  squad: string[];
  /**
   * Types the champion's teams usually field, shown in the opponent preview (the real board may differ).
   * Measured 2026-09-29 on bot boards of rounds 6/10/14 (share of team strength by type), not a rule.
   */
  mainTypes: TypeKey[];
}

export const CHAMPIONS: Record<ChampionKey, ChampionDef> = {
  red: {
    key: "red",
    generation: 1,
    starter: { species: "PIKACHU", item: "LIGHT_BALL" },
    subclasses: ["red_pikachu", "red_kanto"],
    // HGSS / Sun & Moon
    squad: ["PIKACHU", "ESPEON", "SNORLAX", "LAPRAS", "VENUSAUR", "CHARIZARD", "BLASTOISE"],
    mainTypes: ["electric", "normal", "water"],
  },
  lance: {
    key: "lance",
    generation: 2,
    starter: { species: "DRATINI", item: "DRAGON_FANG" },
    subclasses: ["lance_hyperbeam", "lance_dragondance"],
    // Gold / Silver / Crystal, HGSS (Kingdra from Masters)
    squad: ["GYARADOS", "DRAGONITE", "AERODACTYL", "CHARIZARD", "KINGDRA"],
    mainTypes: ["dragon", "flying"],
  },
  steven: {
    key: "steven",
    generation: 3,
    starter: { species: "BELDUM", item: "HARD_STONE" },
    subclasses: ["steven_mega", "steven_regi"],
    // Ruby / Sapphire / Emerald, ORAS
    squad: ["SKARMORY", "CLAYDOL", "AGGRON", "CRADILY", "ARMALDO", "METAGROSS"],
    mainTypes: ["steel", "psychic", "rock"],
  },
  cynthia: {
    key: "cynthia",
    generation: 4,
    starter: { species: "GIBLE", item: "SOFT_SAND" },
    subclasses: ["cynthia_myth", "cynthia_diversity"],
    // Diamond / Pearl / Platinum
    squad: ["SPIRITOMB", "ROSERADE", "GASTRODON", "LUCARIO", "MILOTIC", "GARCHOMP", "TOGEKISS"],
    mainTypes: ["ground", "dragon", "water"],
  },
  alder: {
    key: "alder",
    generation: 5,
    // A gen-5 bug like the rest of his shop (Nincada's early Ninjask + Shedinja outweighed every other champion).
    starter: { species: "SEWADDLE", item: "SILVER_POWDER" },
    subclasses: ["alder_legion", "alder_volcarona"],
    // Black / White
    squad: ["ACCELGOR", "BOUFFALANT", "DRUDDIGON", "VANILLUXE", "ESCAVALIER", "VOLCARONA"],
    mainTypes: ["bug", "grass"],
  },
  diantha: {
    key: "diantha",
    generation: 6,
    starter: { species: "RALTS", item: "MEGA_BRACELET" },
    subclasses: ["diantha_dual", "diantha_beauty"],
    // X / Y
    squad: ["HAWLUCHA", "TYRANTRUM", "AURORUS", "GOURGEIST", "GOODRA", "GARDEVOIR"],
    mainTypes: ["fairy", "psychic"],
  },
  kukui: {
    key: "kukui",
    generation: 7,
    starter: { species: "ROCKRUFF", item: "ROCKIUM_Z" },
    subclasses: ["kukui_zmaster", "kukui_royal"],
    // Sun / Moon (his last Pokémon is the starter that beats the player's)
    squad: ["LYCANROC", "ALOLA_NINETALES", "BRAVIARY", "MAGNEZONE", "SNORLAX", "DECIDUEYE", "INCINEROAR", "PRIMARINA"],
    mainTypes: ["rock"],
  },
  leon: {
    key: "leon",
    generation: 8,
    starter: { species: "CHARMANDER", item: "DYNAMAX_BAND" },
    subclasses: ["leon_gmax", "leon_champtime"],
    // Sword / Shield (his starter is the one strong against the player's)
    squad: ["AEGISLASH", "DRAGAPULT", "HAXORUS", "SEISMITOAD", "MR_RIME", "RHYPERIOR", "CHARIZARD", "RILLABOOM", "CINDERACE", "INTELEON"],
    mainTypes: ["fire", "flying"],
  },
  geeta: {
    key: "geeta",
    generation: 9,
    starter: { species: "GLIMMET", item: "TERA_SHARD", itemParam: "rock" },
    subclasses: ["geeta_stellar", "geeta_investor"],
    // Scarlet / Violet
    squad: ["ESPATHRA", "GOGOAT", "VELUZA", "AVALUGG", "KINGAMBIT", "GLIMMORA"],
    mainTypes: ["rock", "poison", "grass"],
  },
};

/** Lance's passives cover his whole team's style: Dragon and Flying types (Gyarados, Aerodactyl, Charizard…). */
export function isLanceKin(types: readonly string[]): boolean {
  return types.includes("dragon") || types.includes("flying");
}

/** Rounds whose balance is checked apart from rounds 8 and 14 (`pnpm balance:early`); early-game adjustments end after them. */
export const EARLY_ROUNDS = 5;

/**
 * An early-game bonus: `bonus − perRound × round`, never below 0. Champions are tuned on rounds 8 and 14, so an
 * early bonus for a weak start has to be 0 by round 6 (`pnpm balance:early`, docs/DESIGN.md §6). Rounded so
 * floating-point leftovers cannot keep a tiny bonus alive.
 */
export function earlyBonus(bonus: number, perRound: number, round: number): number {
  return Math.max(0, Math.round((bonus - perRound * round) * 1e6) / 1e6);
}

/**
 * Cynthia's stat bonuses (type diversity, no shared type, Gate of Myth) as a share of their full size at a round: 1 up to
 * `bonusFadeAfter`, then `bonusFadePerRound` less per round, never below `bonusFadeFloor`. They make up for her thin
 * mid-game (Garchomp is her only tier 4); once every champion meets a legendary (round 10) they are too much.
 */
export function cynthiaBonusScale(round: number): number {
  const r = CHAMPION_RULES.cynthia;
  return Math.max(r.bonusFadeFloor, Math.round((1 - r.bonusFadePerRound * Math.max(0, round - r.bonusFadeAfter)) * 1e6) / 1e6);
}

/** Tunable numbers for champion passives and subclasses. */
export const CHAMPION_RULES = {
  red: {
    aceCritStages: 2,
    /**
     * Extra levels for the ace after the battles of every `aceExtraLevelEvery`-th round (2: rounds 2, 4, 6, …).
     * Every round until 2026-09-28: stacked with half-price Rare Candy and level items it put the ace 7–13 levels
     * above its team by rounds 5–8 and made Red the strongest champion in live play (Pikachu did 60% of Red's
     * damage in rounds 1–9). Dropping it entirely cut Red's bot strength at rounds 8/14 from 52/47% to 33/34%.
     */
    aceExtraLevels: 1,
    aceExtraLevelEvery: 2,
    aceWinStatBonus: 0.04,
    /** The ace's win bonus stops growing here (5 wins), so one perfect run cannot run away with it. */
    aceWinStatCap: 0.2,
    rareCandyPriceMultiplier: 0.5,
    pikachuElectricMultiplier: 1.5,
    /**
     * Pikachu Partner: Pikachu learns this at Lv99 (out of reach in a 10-win run), so choosing the subclass swaps
     * the weakest move of the Pikachu line's first Pokémon (the starter) for it, and the ace uses it without recoil.
     */
    pikachuPartnerMove: "VOLT_TACKLE",
    /** Light Ball: Pikachu's Attack and Sp. Atk. */
    lightBallMultiplier: 2,
  },
  lance: {
    dragonEvoLevelMultiplier: 0.7,
    dragonShopWeight: 2.2,
    hyperBeamPowerBonus: 0.5,
    /**
     * Early game only: Pokémon of his lines that can still evolve (Magikarp, Dratini, Horsea…) get every stat,
     * HP too, ×(1 + bonus − perRound × round) while that is above 1 (gone from round 6, so the late-game
     * balance measured at rounds 8 and 14 does not move). His lines start weak and only grow later.
     */
    youngKinStatBonus: 0.3,
    youngKinPerRound: 0.05,
  },
  steven: {
    extraIncome: 1,
    stonePriceDiscount: 1,
    stoneDefenseBonus: 0.25,
    /** Every Pokémon on Steven's team: Defense and Sp. Def +(base + perRound × round), so it grows with the run. */
    teamDefenseBonus: 0.15,
    teamDefensePerRound: 0.0135,
    /**
     * Early game only: every stat of the whole team, HP too, ×(1 + bonus − perRound × round) while above 1
     * (gone from round 5, where his defense bonus has him strong already).
     */
    earlyStatBonus: 0.25,
    earlyStatPerRound: 0.05,
    regiAdjacentBonus: 0.2,
  },
  cynthia: {
    typeDiversityBonus: 0.005,
    /** Distinct types counted for the diversity bonus. */
    typeDiversityCap: 6,
    diversityBonusUpgraded: 0.01,
    noDuplicateTypeBonus: 0.02,
    legendaryWeightMultiplier: 1,
    /**
     * Legendaries can roll in her shop from this round instead of round 10 (the guaranteed one still comes at round 10:
     * a guaranteed legendary at round 8 took her typical run from 47% to 84% there).
     */
    legendaryUnlockRound: 9,
    mythPriceDiscount: 2,
    mythTeamBonusPerLegend: 0.03,
    /** Her stat bonuses fade from round 10 (see cynthiaBonusScale): ×0.8 at round 10, ×0.6 at 11, ×0.4 at 12, ×0.25 from 13. */
    bonusFadeAfter: 9,
    bonusFadePerRound: 0.2,
    bonusFadeFloor: 0.25,
  },
  alder: {
    smallPokemonAttackBonus: 0.035,
    legionAttackBonus: 0.045,
    bugEvoLevelMultiplier: 0.7,
    /**
     * Early game only: bug Pokémon that can still evolve get every stat, HP too, ×(1 + bonus − perRound × round) while that is
     * above 1 (gone from round 6). Live (engaged runs, 2026-10-04) Alder won 42% of rounds 1–3 and 48% of 4–6 against 55% / 52%
     * for everyone; replaying the recorded battles with +25% / −4.5 points per round turned that into 58% / 51%.
     */
    youngBugStatBonus: 0.25,
    youngBugPerRound: 0.045,
    bagPriceDiscount: 1,
    /** Extra party slots, for 1×1 Pokémon only (0: an extra body outweighed every other passive). */
    partyCapBonus: 0,
  },
  diantha: {
    megasPerBattle: 2,
    dualMegasPerBattle: 3,
    megaHealRatio: 0.5,
    /** Pokémon next to the Key Stone: every stat but HP, mega stone or not. */
    keyStoneStatBonus: 0.25,
    megaThreshold: 0.6,
    beautyFairyMultiplier: 1.2,
    beautyMegaDamageTaken: 0.8,
  },
  kukui: {
    zMovesPerBattle: 4,
    /** Kukui's research: every move of his team deals ×(1 + this × round²) — it speeds up as the run goes on. */
    movePowerPerRoundSquared: 0.0022,
    /**
     * Early game, before the research builds up: move power ×(1 + bonus − perRound × round) while above 1 (gone from round 10).
     * Live (engaged runs, 2026-10-04) Kukui won 45% of rounds 4–6 and 41% of 7–9 against 52% / 55% for everyone: the old bonus (gone from
     * round 6) and the research (+4% at round 5) both left that stretch empty. Replaying the recorded battles with
     * 0.50 / 0.05, research 0.0022 and 6 Z-Moves took his win rate from 44.9% to 51.2%.
     */
    earlyMovePowerBonus: 0.5,
    earlyMovePowerPerRound: 0.05,
    /** An adjacent Z-crystal also powers up its type like a type booster. */
    zCrystalTypeBoost: 1,
    /** Z Master: the same, but stronger (×2.5 instead of ×2.0). Z Master boards won 36.5% against 58% for the other pick (2026-10-04). */
    zMasterCrystalBoost: 1.5,
    /**
     * Royal Mask ("he studies moves by being hit"): the first time a Pokémon is hit by a type it researches that type,
     * and every later move of that type does this much less damage to it.
     */
    royalResearchReduction: 0.25,
    tmPriceMultiplier: 0.5,
    tmShopWeight: 3,
    researchMoveSlots: 5,
  },
  leon: {
    streakIncomeCap: 5,
    /**
     * Extra income after a loss ("rematch"). A loss also ends the streak's gold and stats, so runs that started badly could
     * not recover: Leon's p10 bot run at round 8 won 4–6% against the field (others 10–20%), its median 35% (2026-10-01).
     * Measured on both seeds, round 8 median / p10: +2G 40% / 9%, +3G 41.5% / 9.5%; rounds 11 and 14 stay at 53% / 52%.
     */
    lossIncome: 3,
    streakStatBonus: 0.012,
    champTimeStreakStatBonus: 0.015,
    /** The streak stat bonus counts at most this many wins in a row. */
    streakStatCap: 5,
    /** The Dynamax comes at this tick (10 per second): 6 s since 2026-10-04, 8 s before (a lost Dynamax Pokémon decided the fight). */
    dynamaxTick: 60,
    /** Every stat of the whole team, whatever the streak (a loss resets the streak, and with it every other bonus Leon has). */
    flatStatBonus: 0.02,
    dynamaxActions: 3,
    gmaxActions: 5,
    dynamaxHpMultiplier: 2,
    dynamaxCandyHpMultiplier: 2.5,
    gmaxPowerBonus: 0.3,
  },
  geeta: {
    interestPer: 5,
    interestCap: 4,
    investorInterestCap: 8,
    investorSellBonus: 1,
    terasPerBattle: 3,
    /** Terastallized Pokémon: every stat but HP ×(bonus + perRound × round) — ×1.42 at round 8, ×1.51 at round 14. */
    teraStatBonus: 1.3,
    teraStatPerRound: 0.015,
    teraMinPower: 60,
    stellarMultiplier: 1.2,
  },
} as const;
