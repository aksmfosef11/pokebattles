/**
 * Champion classes (docs/DESIGN.md §6). Display names come from the `trainers` locale section
 * keyed by `key`; passive/subclass text comes from the game locale (`champion.<key>.*`).
 * Rule numbers live here so balance changes stay in one place; the engine reads them.
 */

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
}

export const CHAMPIONS: Record<ChampionKey, ChampionDef> = {
  red: {
    key: "red",
    generation: 1,
    starter: { species: "PIKACHU", item: "LIGHT_BALL" },
    subclasses: ["red_pikachu", "red_kanto"],
    // HGSS / Sun & Moon
    squad: ["PIKACHU", "ESPEON", "SNORLAX", "LAPRAS", "VENUSAUR", "CHARIZARD", "BLASTOISE"],
  },
  lance: {
    key: "lance",
    generation: 2,
    starter: { species: "DRATINI", item: "DRAGON_FANG" },
    subclasses: ["lance_hyperbeam", "lance_dragondance"],
    // Gold / Silver / Crystal, HGSS (Kingdra from Masters)
    squad: ["GYARADOS", "DRAGONITE", "AERODACTYL", "CHARIZARD", "KINGDRA"],
  },
  steven: {
    key: "steven",
    generation: 3,
    starter: { species: "BELDUM", item: "HARD_STONE" },
    subclasses: ["steven_mega", "steven_regi"],
    // Ruby / Sapphire / Emerald, ORAS
    squad: ["SKARMORY", "CLAYDOL", "AGGRON", "CRADILY", "ARMALDO", "METAGROSS"],
  },
  cynthia: {
    key: "cynthia",
    generation: 4,
    starter: { species: "GIBLE", item: "SOFT_SAND" },
    subclasses: ["cynthia_myth", "cynthia_diversity"],
    // Diamond / Pearl / Platinum
    squad: ["SPIRITOMB", "ROSERADE", "GASTRODON", "LUCARIO", "MILOTIC", "GARCHOMP", "TOGEKISS"],
  },
  alder: {
    key: "alder",
    generation: 5,
    // A gen-5 bug like the rest of his shop (Nincada's early Ninjask + Shedinja outweighed every other champion).
    starter: { species: "SEWADDLE", item: "SILVER_POWDER" },
    subclasses: ["alder_legion", "alder_volcarona"],
    // Black / White
    squad: ["ACCELGOR", "BOUFFALANT", "DRUDDIGON", "VANILLUXE", "ESCAVALIER", "VOLCARONA"],
  },
  diantha: {
    key: "diantha",
    generation: 6,
    starter: { species: "RALTS", item: "MEGA_BRACELET" },
    subclasses: ["diantha_dual", "diantha_beauty"],
    // X / Y
    squad: ["HAWLUCHA", "TYRANTRUM", "AURORUS", "GOURGEIST", "GOODRA", "GARDEVOIR"],
  },
  kukui: {
    key: "kukui",
    generation: 7,
    starter: { species: "ROCKRUFF", item: "ROCKIUM_Z" },
    subclasses: ["kukui_zmaster", "kukui_research"],
    // Sun / Moon (his last Pokémon is the starter that beats the player's)
    squad: ["LYCANROC", "ALOLA_NINETALES", "BRAVIARY", "MAGNEZONE", "SNORLAX", "DECIDUEYE", "INCINEROAR", "PRIMARINA"],
  },
  leon: {
    key: "leon",
    generation: 8,
    starter: { species: "CHARMANDER", item: "DYNAMAX_BAND" },
    subclasses: ["leon_gmax", "leon_champtime"],
    // Sword / Shield (his starter is the one strong against the player's)
    squad: ["AEGISLASH", "DRAGAPULT", "HAXORUS", "SEISMITOAD", "MR_RIME", "RHYPERIOR", "CHARIZARD", "RILLABOOM", "CINDERACE", "INTELEON"],
  },
  geeta: {
    key: "geeta",
    generation: 9,
    starter: { species: "GLIMMET", item: "TERA_SHARD", itemParam: "rock" },
    subclasses: ["geeta_stellar", "geeta_investor"],
    // Scarlet / Violet
    squad: ["ESPATHRA", "GOGOAT", "VELUZA", "AVALUGG", "KINGAMBIT", "GLIMMORA"],
  },
};

/** Lance's passives cover his whole team's style: Dragon and Flying types (Gyarados, Aerodactyl, Charizard…). */
export function isLanceKin(types: readonly string[]): boolean {
  return types.includes("dragon") || types.includes("flying");
}

/** Tunable numbers for champion passives and subclasses. */
export const CHAMPION_RULES = {
  red: {
    aceCritStages: 2,
    aceExtraLevels: 1,
    aceWinStatBonus: 0.04,
    /** The ace's win bonus stops growing here (5 wins), so one perfect run cannot run away with it. */
    aceWinStatCap: 0.15,
    rareCandyPriceMultiplier: 0.5,
    pikachuElectricMultiplier: 1.5,
  },
  lance: {
    dragonEvoLevelMultiplier: 0.7,
    dragonShopWeight: 2.2,
    hyperBeamPowerBonus: 0.5,
  },
  steven: {
    extraIncome: 1,
    stonePriceDiscount: 1,
    stoneDefenseBonus: 0.25,
    /** Every Pokémon on Steven's team: Defense and Sp. Def +(base + perRound × round), so it grows with the run. */
    teamDefenseBonus: 0.15,
    teamDefensePerRound: 0.0135,
    regiAdjacentBonus: 0.2,
  },
  cynthia: {
    typeDiversityBonus: 0.005,
    /** Distinct types counted for the diversity bonus. */
    typeDiversityCap: 6,
    diversityBonusUpgraded: 0.01,
    noDuplicateTypeBonus: 0.02,
    legendaryWeightMultiplier: 1,
    legendaryUnlockRound: 11,
    mythPriceDiscount: 2,
    mythTeamBonusPerLegend: 0.03,
  },
  alder: {
    smallPokemonAttackBonus: 0.035,
    legionAttackBonus: 0.045,
    bugEvoLevelMultiplier: 0.7,
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
    movePowerPerRoundSquared: 0.0024,
    /** An adjacent Z-crystal also powers up its type like a type booster. */
    zCrystalTypeBoost: 0.8,
    tmPriceMultiplier: 0.5,
    tmShopWeight: 3,
    researchMoveSlots: 5,
  },
  leon: {
    streakIncomeCap: 5,
    streakStatBonus: 0.012,
    champTimeStreakStatBonus: 0.015,
    /** The streak stat bonus counts at most this many wins in a row. */
    streakStatCap: 5,
    dynamaxTick: 80,
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
