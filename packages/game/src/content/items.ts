import type { ChampionKey } from "./champions.ts";
import type { TypeKey } from "./schema.ts";

export type ItemFamily =
  | "held"
  | "berry"
  | "typeBoost"
  | "weatherRock"
  | "evolution"
  | "growth"
  | "economy"
  | "orb"
  | "ball"
  | "fossil"
  | "mega"
  | "zCrystal"
  | "tera"
  | "dynamax"
  | "tm"
  | "plate";

/**
 * Which cells an item affects, relative to its own cells (Backpack Battles-style stars).
 * Directional reaches turn with the item: rotation 0 points at the enemy (up).
 *   adjacent – orthogonal neighbours     around – all 8 neighbours     diagonal – the corners
 *   front    – the cell ahead of each item cell     line – 3 cells ahead
 *   row      – the whole row (the whole column when rotated a quarter turn)
 */
export type Reach = "adjacent" | "around" | "diagonal" | "front" | "line" | "row";

export type Tier = 1 | 2 | 3 | 4 | 5;

export interface ItemDef {
  /** PokéRogue-style key; also the locale key under `items`. */
  key: string;
  family: ItemFamily;
  tier: Tier;
  price: number;
  /** Only this champion's shop offers it. */
  champions?: ChampionKey[];
  /** Type for type boosters and Z-crystals. */
  type?: TypeKey;
  /** Instances carry a parameter: a type (tera shards) or a move key (TMs). */
  param?: "type" | "move";
  /** Consumed when its effect resolves. */
  consumable?: boolean;
  /** Counts as a stone for Steven's passive. */
  stone?: boolean;
  /** Never rolled in the shop (starter-only items). */
  noShop?: boolean;
  /** For mega stones: species and form they unlock. */
  mega?: { species: string; formKey: string };
  /** Triggers at most once per battle per copy (berries, herbs, policies, sashes, balloons, seeds). */
  oneShot?: boolean;
  /** Shop weight multiplier (niche items appear less often). */
  weight?: number;
  /** Only worth offering when the player owns this species. */
  forSpecies?: string;
  /** Only worth offering when the player owns a Pokémon with one of these abilities. */
  forAbilities?: string[];
  /** Footprint in cells (default 1×1). */
  size?: { w: number; h: number };
  /** Affected cells (default adjacent). */
  reach?: Reach;
}

const TYPE_BOOSTERS: [string, TypeKey][] = [
  ["SILK_SCARF", "normal"],
  ["BLACK_BELT", "fighting"],
  ["SHARP_BEAK", "flying"],
  ["POISON_BARB", "poison"],
  ["SOFT_SAND", "ground"],
  ["HARD_STONE", "rock"],
  ["SILVER_POWDER", "bug"],
  ["SPELL_TAG", "ghost"],
  ["METAL_COAT", "steel"],
  ["CHARCOAL", "fire"],
  ["MYSTIC_WATER", "water"],
  ["MIRACLE_SEED", "grass"],
  ["MAGNET", "electric"],
  ["TWISTED_SPOON", "psychic"],
  ["NEVER_MELT_ICE", "ice"],
  ["DRAGON_FANG", "dragon"],
  ["BLACK_GLASSES", "dark"],
  ["FAIRY_FEATHER", "fairy"],
];

/** Berries that halve one super-effective hit of their type (Chilan: any Normal hit). */
export const RESIST_BERRIES: [string, TypeKey][] = [
  ["OCCA_BERRY", "fire"],
  ["PASSHO_BERRY", "water"],
  ["WACAN_BERRY", "electric"],
  ["RINDO_BERRY", "grass"],
  ["YACHE_BERRY", "ice"],
  ["CHOPLE_BERRY", "fighting"],
  ["KEBIA_BERRY", "poison"],
  ["SHUCA_BERRY", "ground"],
  ["COBA_BERRY", "flying"],
  ["PAYAPA_BERRY", "psychic"],
  ["TANGA_BERRY", "bug"],
  ["CHARTI_BERRY", "rock"],
  ["KASIB_BERRY", "ghost"],
  ["HABAN_BERRY", "dragon"],
  ["COLBUR_BERRY", "dark"],
  ["BABIRI_BERRY", "steel"],
  ["CHILAN_BERRY", "normal"],
];

/** Plates: two matching type boosters combine into the type's plate. */
export const PLATES: [string, TypeKey][] = [
  ["BLANK_PLATE", "normal"],
  ["FIST_PLATE", "fighting"],
  ["SKY_PLATE", "flying"],
  ["TOXIC_PLATE", "poison"],
  ["EARTH_PLATE", "ground"],
  ["STONE_PLATE", "rock"],
  ["INSECT_PLATE", "bug"],
  ["SPOOKY_PLATE", "ghost"],
  ["IRON_PLATE", "steel"],
  ["FLAME_PLATE", "fire"],
  ["SPLASH_PLATE", "water"],
  ["MEADOW_PLATE", "grass"],
  ["ZAP_PLATE", "electric"],
  ["MIND_PLATE", "psychic"],
  ["ICICLE_PLATE", "ice"],
  ["DRACO_PLATE", "dragon"],
  ["DREAD_PLATE", "dark"],
  ["PIXIE_PLATE", "fairy"],
];

export const Z_CRYSTALS: [string, TypeKey][] = [
  ["NORMALIUM_Z", "normal"],
  ["FIGHTINIUM_Z", "fighting"],
  ["FLYINIUM_Z", "flying"],
  ["POISONIUM_Z", "poison"],
  ["GROUNDIUM_Z", "ground"],
  ["ROCKIUM_Z", "rock"],
  ["BUGINIUM_Z", "bug"],
  ["GHOSTIUM_Z", "ghost"],
  ["STEELIUM_Z", "steel"],
  ["FIRIUM_Z", "fire"],
  ["WATERIUM_Z", "water"],
  ["GRASSIUM_Z", "grass"],
  ["ELECTRIUM_Z", "electric"],
  ["PSYCHIUM_Z", "psychic"],
  ["ICIUM_Z", "ice"],
  ["DRAGONIUM_Z", "dragon"],
  ["DARKINIUM_Z", "dark"],
  ["FAIRIUM_Z", "fairy"],
];

const EVOLUTION_STONES: [string, Tier][] = [
  ["FIRE_STONE", 1],
  ["WATER_STONE", 1],
  ["THUNDER_STONE", 1],
  ["LEAF_STONE", 1],
  ["MOON_STONE", 1],
  ["ICE_STONE", 1],
  ["SUN_STONE", 2],
  ["SHINY_STONE", 2],
  ["DUSK_STONE", 2],
  ["DAWN_STONE", 2],
];

const BASE_ITEMS: ItemDef[] = [
  { key: "LEFTOVERS", family: "held", tier: 2, price: 5 },
  { key: "SHELL_BELL", family: "held", tier: 2, price: 4 },
  { key: "SITRUS_BERRY", family: "berry", tier: 1, price: 2 },
  { key: "LUM_BERRY", family: "berry", tier: 1, price: 2 },
  { key: "LIECHI_BERRY", family: "berry", tier: 1, price: 2 },
  { key: "SALAC_BERRY", family: "berry", tier: 1, price: 2 },
  { key: "PETAYA_BERRY", family: "berry", tier: 1, price: 2 },
  { key: "ORAN_BERRY", family: "berry", tier: 1, price: 1 },
  { key: "GANLON_BERRY", family: "berry", tier: 1, price: 2 },
  { key: "APICOT_BERRY", family: "berry", tier: 1, price: 2 },
  { key: "LANSAT_BERRY", family: "berry", tier: 2, price: 3 },
  { key: "STARF_BERRY", family: "berry", tier: 2, price: 3 },
  { key: "ENIGMA_BERRY", family: "berry", tier: 2, price: 3 },
  { key: "LEPPA_BERRY", family: "berry", tier: 1, price: 2 },
  { key: "JABOCA_BERRY", family: "berry", tier: 1, price: 2 },
  { key: "ROWAP_BERRY", family: "berry", tier: 1, price: 2 },
  { key: "MUSCLE_BAND", family: "held", tier: 1, price: 3 },
  { key: "WISE_GLASSES", family: "held", tier: 1, price: 3 },
  { key: "BLACK_SLUDGE", family: "held", tier: 1, price: 3 },
  { key: "BIG_ROOT", family: "held", tier: 1, price: 3 },
  { key: "BRIGHT_POWDER", family: "held", tier: 2, price: 4 },
  { key: "METRONOME", family: "held", tier: 2, price: 4 },
  { key: "ZOOM_LENS", family: "held", tier: 1, price: 3 },
  { key: "LOADED_DICE", family: "held", tier: 2, price: 4 },
  { key: "PUNCHING_GLOVE", family: "held", tier: 1, price: 3 },
  { key: "CLEAR_AMULET", family: "held", tier: 2, price: 4 },
  { key: "COVERT_CLOAK", family: "held", tier: 2, price: 4 },
  { key: "SAFETY_GOGGLES", family: "held", tier: 1, price: 2 },
  { key: "PROTECTIVE_PADS", family: "held", tier: 1, price: 3 },
  { key: "UTILITY_UMBRELLA", family: "held", tier: 1, price: 3 },
  { key: "FOCUS_BAND", family: "held", tier: 2, price: 4 },
  { key: "GRIP_CLAW", family: "held", tier: 1, price: 3, weight: 0.6 },
  { key: "BINDING_BAND", family: "held", tier: 1, price: 3, weight: 0.6 },
  { key: "LIGHT_CLAY", family: "held", tier: 2, price: 3, weight: 0.6 },
  { key: "TERRAIN_EXTENDER", family: "held", tier: 2, price: 3, weight: 0.6 },
  { key: "MENTAL_HERB", family: "held", tier: 1, price: 2, oneShot: true },
  { key: "WHITE_HERB", family: "held", tier: 1, price: 2, oneShot: true },
  { key: "POWER_HERB", family: "held", tier: 1, price: 3, oneShot: true },
  { key: "AIR_BALLOON", family: "held", tier: 1, price: 2, oneShot: true },
  { key: "WEAKNESS_POLICY", family: "held", tier: 2, price: 4, oneShot: true },
  { key: "ABSORB_BULB", family: "held", tier: 1, price: 2, oneShot: true },
  { key: "CELL_BATTERY", family: "held", tier: 1, price: 2, oneShot: true },
  { key: "BLUNDER_POLICY", family: "held", tier: 1, price: 2, oneShot: true },
  { key: "THROAT_SPRAY", family: "held", tier: 1, price: 2, oneShot: true },
  { key: "ADRENALINE_ORB", family: "held", tier: 1, price: 2, oneShot: true },
  { key: "ELECTRIC_SEED", family: "held", tier: 1, price: 2, oneShot: true, weight: 0.5 },
  { key: "GRASSY_SEED", family: "held", tier: 1, price: 2, oneShot: true, weight: 0.5 },
  { key: "MISTY_SEED", family: "held", tier: 1, price: 2, oneShot: true, weight: 0.5 },
  { key: "PSYCHIC_SEED", family: "held", tier: 1, price: 2, oneShot: true, weight: 0.5 },
  { key: "METAL_POWDER", family: "held", tier: 1, price: 2, forSpecies: "DITTO" },
  { key: "QUICK_POWDER", family: "held", tier: 1, price: 2, forSpecies: "DITTO" },
  { key: "BOOSTER_ENERGY", family: "held", tier: 2, price: 3, oneShot: true, forAbilities: ["PROTOSYNTHESIS", "QUARK_DRIVE"] },
  { key: "EXP_SHARE", family: "growth", tier: 2, price: 4 },
  { key: "MACHO_BRACE", family: "growth", tier: 1, price: 3 },
  // Recipe outputs (only made by combining; see RECIPES).
  { key: "RARER_CANDY", family: "growth", tier: 2, price: 6, consumable: true, noShop: true },
  { key: "LUCK_INCENSE", family: "economy", tier: 2, price: 10, noShop: true },
  { key: "BIG_NUGGET", family: "economy", tier: 2, price: 6, champions: ["steven"], stone: true, noShop: true },
  { key: "GREAT_BALL", family: "ball", tier: 2, price: 2, champions: ["alder"], consumable: true, noShop: true },
  { key: "ULTRA_BALL", family: "ball", tier: 3, price: 4, champions: ["alder"], consumable: true, noShop: true },
  { key: "CHOICE_BAND", family: "held", tier: 3, price: 6 },
  { key: "CHOICE_SPECS", family: "held", tier: 3, price: 6 },
  { key: "CHOICE_SCARF", family: "held", tier: 3, price: 6 },
  { key: "LIFE_ORB", family: "held", tier: 3, price: 6 },
  { key: "EXPERT_BELT", family: "held", tier: 2, price: 5 },
  { key: "SCOPE_LENS", family: "held", tier: 2, price: 4 },
  { key: "QUICK_CLAW", family: "held", tier: 1, price: 3 },
  { key: "KINGS_ROCK", family: "held", tier: 2, price: 4 },
  { key: "WIDE_LENS", family: "held", tier: 1, price: 3 },
  { key: "FOCUS_SASH", family: "held", tier: 2, price: 4, oneShot: true },
  { key: "ASSAULT_VEST", family: "held", tier: 3, price: 6 },
  { key: "EVIOLITE", family: "held", tier: 2, price: 5 },
  { key: "ROCKY_HELMET", family: "held", tier: 2, price: 5 },
  { key: "FLAME_ORB", family: "held", tier: 2, price: 3 },
  { key: "TOXIC_ORB", family: "held", tier: 2, price: 3 },
  { key: "MULTI_LENS", family: "held", tier: 4, price: 8 },
  { key: "SOOTHE_BELL", family: "growth", tier: 1, price: 3 },
  { key: "LUCKY_EGG", family: "growth", tier: 2, price: 4 },
  { key: "RARE_CANDY", family: "growth", tier: 1, price: 3, consumable: true },
  { key: "AMULET_COIN", family: "economy", tier: 2, price: 5 },
  { key: "GOLDEN_PUNCH", family: "economy", tier: 2, price: 4 },
  { key: "HEAT_ROCK", family: "weatherRock", tier: 2, price: 3, stone: true },
  { key: "DAMP_ROCK", family: "weatherRock", tier: 2, price: 3, stone: true },
  { key: "SMOOTH_ROCK", family: "weatherRock", tier: 2, price: 3, stone: true },
  { key: "ICY_ROCK", family: "weatherRock", tier: 2, price: 3, stone: true },
  { key: "LINKING_CORD", family: "evolution", tier: 2, price: 4, consumable: true },
  { key: "TM", family: "tm", tier: 2, price: 4, param: "move", consumable: true },

  // 레드
  { key: "LIGHT_BALL", family: "held", tier: 1, price: 3, champions: ["red"] },
  { key: "MASTER_BALL", family: "ball", tier: 3, price: 6, champions: ["red"], consumable: true },
  // 목호
  { key: "DRAGON_SCALE", family: "held", tier: 2, price: 4, champions: ["lance"] },
  { key: "SOUL_DEW", family: "held", tier: 3, price: 6, champions: ["lance"] },
  // 성호
  { key: "NUGGET", family: "economy", tier: 1, price: 3, champions: ["steven"], stone: true },
  { key: "ROOT_FOSSIL", family: "fossil", tier: 2, price: 5, champions: ["steven"], consumable: true, stone: true },
  { key: "CLAW_FOSSIL", family: "fossil", tier: 2, price: 5, champions: ["steven"], consumable: true, stone: true },
  // 난천
  { key: "ADAMANT_ORB", family: "orb", tier: 4, price: 5, champions: ["cynthia"] },
  { key: "LUSTROUS_ORB", family: "orb", tier: 4, price: 5, champions: ["cynthia"] },
  { key: "GRISEOUS_ORB", family: "orb", tier: 4, price: 5, champions: ["cynthia"] },
  { key: "VOUCHER", family: "ball", tier: 3, price: 6, champions: ["cynthia"], consumable: true },
  // 노간주
  { key: "POKE_BALL", family: "ball", tier: 1, price: 1, champions: ["alder"], consumable: true },
  // 카르네
  { key: "MEGA_BRACELET", family: "mega", tier: 1, price: 0, champions: ["diantha"], noShop: true },
  // 단델
  { key: "DYNAMAX_BAND", family: "dynamax", tier: 1, price: 0, champions: ["leon"], noShop: true },
  { key: "MAX_MUSHROOMS", family: "dynamax", tier: 3, price: 5, champions: ["leon"] },
  { key: "DYNAMAX_CANDY", family: "dynamax", tier: 2, price: 4, champions: ["leon"] },
  // 오모다카
  { key: "TERA_SHARD", family: "tera", tier: 2, price: 4, champions: ["geeta"], param: "type" },
  { key: "TERA_ORB", family: "tera", tier: 4, price: 8, champions: ["geeta"] },
];

function buildItems(): Record<string, ItemDef> {
  const all: ItemDef[] = [...BASE_ITEMS];
  for (const [key, type] of TYPE_BOOSTERS) {
    all.push({ key, family: "typeBoost", tier: 1, price: 3, type, stone: key === "HARD_STONE" });
  }
  for (const [key, tier] of EVOLUTION_STONES) {
    all.push({ key, family: "evolution", tier, price: 3, consumable: true, stone: true });
  }
  for (const [key, type] of PLATES) {
    all.push({ key, family: "plate", tier: 2, price: 6, type, noShop: true, size: { w: 2, h: 1 }, reach: "around" });
  }
  for (const [key, type] of RESIST_BERRIES) {
    all.push({ key, family: "berry", tier: 1, price: 2, type, weight: 0.5 });
  }
  for (const [key, type] of Z_CRYSTALS) {
    all.push({ key, family: "zCrystal", tier: 2, price: 5, type, champions: ["kukui"] });
  }
  for (const def of all) Object.assign(def, SHAPES[def.key] ?? {});
  const out: Record<string, ItemDef> = {};
  for (const def of all) {
    if (out[def.key]) throw new Error(`duplicate item ${def.key}`);
    out[def.key] = def;
  }
  return out;
}

/** Big items and non-default reaches. Everything else is a 1×1 item affecting its neighbours. */
const SHAPES: Record<string, Pick<ItemDef, "size" | "reach">> = {
  CHOICE_BAND: { size: { w: 2, h: 1 } },
  CHOICE_SPECS: { size: { w: 2, h: 1 } },
  CHOICE_SCARF: { size: { w: 2, h: 1 } },
  EXPERT_BELT: { size: { w: 3, h: 1 } },
  MUSCLE_BAND: { size: { w: 2, h: 1 } },
  MACHO_BRACE: { size: { w: 2, h: 1 } },
  PROTECTIVE_PADS: { size: { w: 2, h: 1 } },
  ASSAULT_VEST: { size: { w: 2, h: 2 } },
  COVERT_CLOAK: { size: { w: 2, h: 2 } },
  KINGS_ROCK: { size: { w: 2, h: 2 } },
  HEAT_ROCK: { size: { w: 2, h: 2 } },
  DAMP_ROCK: { size: { w: 2, h: 2 } },
  SMOOTH_ROCK: { size: { w: 2, h: 2 } },
  ICY_ROCK: { size: { w: 2, h: 2 } },
  FOCUS_SASH: { size: { w: 1, h: 2 } },
  METRONOME: { size: { w: 1, h: 2 } },
  AIR_BALLOON: { size: { w: 1, h: 2 } },
  UTILITY_UMBRELLA: { size: { w: 1, h: 3 } },
  BIG_ROOT: { size: { w: 1, h: 3 } },
  BIG_NUGGET: { size: { w: 2, h: 2 } },
  LIFE_ORB: { reach: "around" },
  EVIOLITE: { reach: "around" },
  LUCKY_EGG: { reach: "around" },
  SOOTHE_BELL: { reach: "around" },
  BLACK_SLUDGE: { reach: "around" },
  BRIGHT_POWDER: { reach: "around" },
  CLEAR_AMULET: { reach: "around" },
  SOUL_DEW: { reach: "around" },
  ADAMANT_ORB: { reach: "around" },
  LUSTROUS_ORB: { reach: "around" },
  GRISEOUS_ORB: { reach: "around" },
  MAX_MUSHROOMS: { reach: "around" },
  MEGA_BRACELET: { reach: "around" },
  QUICK_CLAW: { reach: "diagonal" },
  LOADED_DICE: { reach: "diagonal" },
  GRIP_CLAW: { reach: "diagonal" },
  ROCKY_HELMET: { reach: "front" },
  PUNCHING_GLOVE: { reach: "front" },
  WIDE_LENS: { size: { w: 2, h: 1 }, reach: "front" },
  MULTI_LENS: { size: { w: 2, h: 1 }, reach: "front" },
  SAFETY_GOGGLES: { size: { w: 2, h: 1 }, reach: "front" },
  SCOPE_LENS: { reach: "line" },
  ZOOM_LENS: { reach: "line" },
  EXP_SHARE: { size: { w: 2, h: 1 }, reach: "row" },
};

export const ITEMS: Record<string, ItemDef> = buildItems();

export interface Recipe {
  inputs: [string, string];
  output: string;
}

/** Two touching inputs merge into the output as soon as they are placed next to each other. */
export const RECIPES: Recipe[] = [
  ...PLATES.map(([plate, type]): Recipe => {
    const booster = TYPE_BOOSTERS.find(([, t]) => t === type)![0];
    return { inputs: [booster, booster], output: plate };
  }),
  { inputs: ["ORAN_BERRY", "ORAN_BERRY"], output: "SITRUS_BERRY" },
  { inputs: ["MUSCLE_BAND", "MUSCLE_BAND"], output: "CHOICE_BAND" },
  { inputs: ["WISE_GLASSES", "WISE_GLASSES"], output: "CHOICE_SPECS" },
  { inputs: ["MUSCLE_BAND", "WISE_GLASSES"], output: "EXPERT_BELT" },
  { inputs: ["FOCUS_BAND", "FOCUS_BAND"], output: "FOCUS_SASH" },
  { inputs: ["RARE_CANDY", "RARE_CANDY"], output: "RARER_CANDY" },
  { inputs: ["AMULET_COIN", "AMULET_COIN"], output: "LUCK_INCENSE" },
  { inputs: ["NUGGET", "NUGGET"], output: "BIG_NUGGET" },
  { inputs: ["POKE_BALL", "POKE_BALL"], output: "GREAT_BALL" },
  { inputs: ["GREAT_BALL", "GREAT_BALL"], output: "ULTRA_BALL" },
];

export function findRecipe(a: string, b: string): Recipe | null {
  return RECIPES.find((r) => (r.inputs[0] === a && r.inputs[1] === b) || (r.inputs[0] === b && r.inputs[1] === a)) ?? null;
}

export function itemSize(key: string): { w: number; h: number } {
  return ITEMS[key]?.size ?? { w: 1, h: 1 };
}

export function itemReach(key: string): Reach {
  return ITEMS[key]?.reach ?? "adjacent";
}

/** Mega stones are generated from species data; call once content is loaded. */
export function registerMegaStones(stones: { item: string; species: string; formKey: string }[]): void {
  for (const s of stones) {
    if (ITEMS[s.item]) continue;
    ITEMS[s.item] = {
      key: s.item,
      family: "mega",
      tier: 3,
      price: 6,
      champions: s.species === "METAGROSS" ? ["diantha", "steven"] : ["diantha"],
      stone: true,
      mega: { species: s.species, formKey: s.formKey },
    };
  }
}

export function typeBoosterFor(type: TypeKey): string {
  return TYPE_BOOSTERS.find(([, t]) => t === type)![0];
}
