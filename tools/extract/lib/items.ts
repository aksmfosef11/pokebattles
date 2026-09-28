/** Item keys the game needs (coordinator list). Keys are UPPER_SNAKE game keys. */
export const REQUIRED_ITEMS: { group: string; keys: string[] }[] = [
  {
    group: "held",
    keys: [
      "LEFTOVERS", "SHELL_BELL", "SITRUS_BERRY", "LUM_BERRY", "LIECHI_BERRY", "SALAC_BERRY", "PETAYA_BERRY",
      "CHOICE_BAND", "CHOICE_SPECS", "CHOICE_SCARF", "LIFE_ORB", "EXPERT_BELT", "SCOPE_LENS", "QUICK_CLAW",
      "KINGS_ROCK", "WIDE_LENS", "FOCUS_SASH", "ASSAULT_VEST", "EVIOLITE", "ROCKY_HELMET", "HEAT_ROCK", "DAMP_ROCK",
      "SMOOTH_ROCK", "ICY_ROCK", "LUCKY_EGG", "AMULET_COIN", "RARE_CANDY", "FLAME_ORB", "TOXIC_ORB", "MULTI_LENS",
      "GOLDEN_PUNCH", "SOOTHE_BELL", "LIGHT_BALL", "SOUL_DEW", "ADAMANT_ORB", "LUSTROUS_ORB", "GRISEOUS_ORB",
      "NUGGET", "ROOT_FOSSIL", "CLAW_FOSSIL", "DRAGON_SCALE", "MASTER_BALL", "POKE_BALL", "VOUCHER",
    ],
  },
  {
    group: "typeBooster",
    keys: [
      "SILK_SCARF", "BLACK_BELT", "SHARP_BEAK", "POISON_BARB", "SOFT_SAND", "HARD_STONE", "SILVER_POWDER",
      "SPELL_TAG", "METAL_COAT", "CHARCOAL", "MYSTIC_WATER", "MIRACLE_SEED", "MAGNET", "TWISTED_SPOON",
      "NEVER_MELT_ICE", "DRAGON_FANG", "BLACK_GLASSES", "FAIRY_FEATHER",
    ],
  },
  {
    group: "evolution",
    keys: [
      "FIRE_STONE", "WATER_STONE", "THUNDER_STONE", "LEAF_STONE", "MOON_STONE", "SUN_STONE", "SHINY_STONE",
      "DUSK_STONE", "DAWN_STONE", "ICE_STONE", "LINKING_CORD",
    ],
  },
  {
    group: "gimmick",
    keys: ["MEGA_BRACELET", "DYNAMAX_BAND", "MAX_MUSHROOMS", "DYNAMAX_CANDY", "TERA_ORB", "TERA_SHARD"],
  },
  {
    group: "held2",
    keys: [
      "BLACK_SLUDGE", "BIG_ROOT", "BRIGHT_POWDER", "MUSCLE_BAND", "WISE_GLASSES", "METRONOME", "ZOOM_LENS",
      "LOADED_DICE", "PUNCHING_GLOVE", "CLEAR_AMULET", "COVERT_CLOAK", "SAFETY_GOGGLES", "MENTAL_HERB",
      "WHITE_HERB", "POWER_HERB", "AIR_BALLOON", "GRIP_CLAW", "BINDING_BAND", "LIGHT_CLAY", "TERRAIN_EXTENDER",
      "ELECTRIC_SEED", "GRASSY_SEED", "MISTY_SEED", "PSYCHIC_SEED", "WEAKNESS_POLICY", "ABSORB_BULB",
      "CELL_BATTERY", "BLUNDER_POLICY", "THROAT_SPRAY", "FOCUS_BAND", "EXP_SHARE", "BERRY_POUCH",
      "METAL_POWDER", "QUICK_POWDER", "PROTECTIVE_PADS", "UTILITY_UMBRELLA", "ADRENALINE_ORB", "MACHO_BRACE",
      "BOOSTER_ENERGY",
    ],
  },
  {
    group: "berries2",
    keys: [
      "ORAN_BERRY", "GANLON_BERRY", "APICOT_BERRY", "LANSAT_BERRY", "STARF_BERRY", "ENIGMA_BERRY", "LEPPA_BERRY",
      "JABOCA_BERRY", "ROWAP_BERRY", "OCCA_BERRY", "PASSHO_BERRY", "WACAN_BERRY", "RINDO_BERRY", "YACHE_BERRY",
      "CHOPLE_BERRY", "KEBIA_BERRY", "SHUCA_BERRY", "COBA_BERRY", "PAYAPA_BERRY", "TANGA_BERRY", "CHARTI_BERRY",
      "KASIB_BERRY", "HABAN_BERRY", "COLBUR_BERRY", "BABIRI_BERRY", "CHILAN_BERRY", "ROSELI_BERRY",
    ],
  },
  {
    group: "recipes",
    keys: [
      "FLAME_PLATE", "SPLASH_PLATE", "ZAP_PLATE", "MEADOW_PLATE", "ICICLE_PLATE", "FIST_PLATE", "TOXIC_PLATE",
      "EARTH_PLATE", "SKY_PLATE", "MIND_PLATE", "INSECT_PLATE", "STONE_PLATE", "SPOOKY_PLATE", "DRACO_PLATE",
      "DREAD_PLATE", "IRON_PLATE", "PIXIE_PLATE", "BLANK_PLATE", "BIG_NUGGET", "GREAT_BALL", "ULTRA_BALL",
      "RARER_CANDY", "LUCK_INCENSE",
    ],
  },
  {
    // Bags named after real items (BERRY_POUCH is listed under held2 for old runs).
    group: "bag",
    keys: ["CANDY_JAR", "COIN_CASE"],
  },
  {
    // Start-of-run items bought with points (MINT comes from PokéRogue's item templates).
    group: "training",
    keys: ["BOTTLE_CAP"],
  },
  {
    group: "zCrystal",
    keys: [
      "NORMALIUM_Z", "FIRIUM_Z", "WATERIUM_Z", "ELECTRIUM_Z", "GRASSIUM_Z", "ICIUM_Z", "FIGHTINIUM_Z",
      "POISONIUM_Z", "GROUNDIUM_Z", "FLYINIUM_Z", "PSYCHIUM_Z", "BUGINIUM_Z", "ROCKIUM_Z", "GHOSTIUM_Z",
      "DRAGONIUM_Z", "DARKINIUM_Z", "STEELIUM_Z", "FAIRIUM_Z",
    ],
  },
];

/** PokeAPI item categories pulled in as supplemental (held-item-like) entries when PokéRogue lacks them. */
export const POKEAPI_SUPPLEMENTAL_CATEGORIES = [
  "in-a-pinch", "picky-healing", "type-protection", "held-items", "choice", "bad-held-items", "plates",
  "species-specific", "type-enhancement", "jewels", "mega-stones", "memories", "z-crystals", "evolution",
];

export interface ItemCatalogEntry {
  /** where the item's name can come from (in preference order) */
  pokerogueLocaleKey: string | null;
  pokeapiIdentifier: string | null;
  pokeapiCategory: string | null;
  group: string;
  /** Frame name expected in PokéRogue's images/items atlas (verified by the sprites script) */
  atlasFrame: string | null;
  required: boolean;
  rosterMegaStoneFor?: string[];
}

/** UPPER_SNAKE game key -> PokeAPI identifier, given the set of PokeAPI item identifiers. */
export function pokeapiIdentifierFor(key: string, identifiers: Set<string>): string | null {
  const kebab = key.toLowerCase().replace(/_/g, "-");
  for (const cand of [kebab, `${kebab}--held`]) if (identifiers.has(cand)) return cand;
  return null;
}

/** PokeAPI identifier -> UPPER_SNAKE game key */
export function keyFromPokeapiIdentifier(identifier: string): string {
  return identifier.replace(/--(held|bag)$/, "").replace(/-/g, "_").toUpperCase();
}
