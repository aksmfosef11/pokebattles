/**
 * Content contract between the generated data (tools/content/build-content.ts) and the engine.
 * Keys are PokéRogue enum member names (species, moves, abilities, items); the client
 * resolves display names through locale files, never through these keys.
 */

export const TYPES = [
  "normal",
  "fighting",
  "flying",
  "poison",
  "ground",
  "rock",
  "bug",
  "ghost",
  "steel",
  "fire",
  "water",
  "grass",
  "electric",
  "psychic",
  "ice",
  "dragon",
  "dark",
  "fairy",
] as const;
export type TypeKey = (typeof TYPES)[number];

export interface Stats {
  hp: number;
  atk: number;
  def: number;
  spa: number;
  spd: number;
  spe: number;
}
export type StatKey = keyof Stats;
export const STAT_KEYS: readonly StatKey[] = ["hp", "atk", "def", "spa", "spd", "spe"];

export type StageStat = "atk" | "def" | "spa" | "spd" | "spe" | "acc" | "eva";
export const STAGE_STATS: readonly StageStat[] = ["atk", "def", "spa", "spd", "spe", "acc", "eva"];

export type Weather = "sun" | "rain" | "sand" | "snow";
export type Terrain = "electric" | "grassy" | "psychic" | "misty";
export type StatusKey = "brn" | "psn" | "tox" | "par" | "slp" | "frz";
export type MoveCategory = "physical" | "special" | "status";

/**
 * enemy        – frontmost enemy in the attacker's lane
 * randomEnemy  – any living enemy (Outrage, Thrash)
 * enemySpread  – target + enemies adjacent to it (ALL_NEAR_ENEMIES)
 * allAround    – enemySpread + the user's adjacent allies (ALL_NEAR_OTHERS: Earthquake, Surf)
 * allEnemies   – every enemy
 * self, ally, allySide, field – non-damaging scopes
 */
export type MoveTarget =
  | "enemy"
  | "randomEnemy"
  | "enemySpread"
  | "allAround"
  | "allEnemies"
  | "self"
  | "ally"
  | "allySide"
  | "field";

export type MoveEffect =
  | { kind: "status"; status: StatusKey; chance: number; self?: boolean }
  | { kind: "randomStatus"; options: StatusKey[]; chance: number }
  | { kind: "confuse"; chance: number; self?: boolean }
  | { kind: "flinch"; chance: number }
  | { kind: "stages"; stats: StageStat[]; delta: number; target: "self" | "target" | "allies"; chance: number }
  | { kind: "critStage"; stages: number }
  | { kind: "focusEnergy" }
  | { kind: "alwaysCrit" }
  | { kind: "multiHit"; min: number; max: number }
  | { kind: "recoil"; ratio: number; basis: "damage" | "maxHp" }
  | { kind: "drain"; ratio: number }
  | { kind: "heal"; ratio: number; weatherScaled?: boolean }
  | { kind: "weather"; weather: Weather }
  | { kind: "terrain"; terrain: Terrain }
  | { kind: "charge"; skipIn?: Weather; invulnerable?: boolean }
  | { kind: "recharge" }
  | { kind: "ohko" }
  | { kind: "fixedDamage"; amount: number }
  | { kind: "levelDamage" }
  | { kind: "halveHp" }
  | { kind: "protect" }
  | { kind: "selfFaint" }
  | { kind: "rest" }
  | { kind: "metronome" }
  | { kind: "transform" }
  | { kind: "leechSeed" }
  | { kind: "bind" }
  | { kind: "storedPower" }
  | { kind: "hex" }
  | { kind: "facade" }
  | { kind: "venoshock" }
  | { kind: "reversal" }
  | { kind: "eruption" }
  | { kind: "weightPower"; mode: "target" | "ratio" }
  | { kind: "payDay" }
  | { kind: "cureTeam" }
  | { kind: "thaw" }
  | { kind: "bellyDrum" }
  | { kind: "haze" }
  | { kind: "screen"; screen: "reflect" | "lightScreen" | "auroraVeil" }
  | { kind: "tailwind" }
  | { kind: "weatherBall" }
  | { kind: "weatherAccuracy"; weather: Weather }
  | { kind: "weatherPowerHalved"; except: Weather }
  | { kind: "fakeOut" }
  | { kind: "struggle" };

export interface MoveDef {
  key: string;
  type: TypeKey;
  category: MoveCategory;
  /** 0 for status moves and moves whose power is computed at use time. */
  power: number;
  /** null = never misses */
  accuracy: number | null;
  pp: number;
  priority: number;
  target: MoveTarget;
  contact: boolean;
  flags: string[];
  effects: MoveEffect[];
  /** true when some PokéRogue behaviour could not be mapped; the move still works for its mapped parts. */
  partial?: boolean;
}

export interface FormDef {
  /** PokéRogue sprite form key ("" = base, "mega", "mega-x", "gigantamax", ...) */
  formKey: string;
  types: TypeKey[];
  baseStats: Stats;
  /** Fixed ability while in this form (megas); null keeps the base ability. */
  ability: string | null;
}

export interface EvolutionDef {
  to: string;
  level?: number;
  /** Item key that must be adjacent (consumed for evolution stones and trade items). */
  item?: string;
  /** Friendship converted into battles participated. */
  battles?: number;
  /** Friendship evolutions that care about the last battle's outcome (Espeon / Umbreon). */
  onResult?: "win" | "loss";
  /** A Pokémon of this type must be adjacent (Sylveon). */
  adjacentType?: TypeKey;
  /** Extra species that appears in an adjacent free cell (Nincada → Shedinja). */
  spawn?: string;
}

export interface SpeciesDef {
  key: string;
  id: number;
  /** Generation the species (or regional form) was introduced in; champions' shops are built from it. */
  generation: number;
  types: TypeKey[];
  baseStats: Stats;
  bst: number;
  abilities: string[];
  hiddenAbility: string | null;
  heightM: number;
  weightKg: number;
  footprint: { w: number; h: number };
  tier: 1 | 2 | 3 | 4 | 5;
  /** Appears in the shop (false for forms reached only by evolution rules such as Shedinja). */
  shop: boolean;
  legendary: boolean;
  subLegendary: boolean;
  mythical: boolean;
  /** Implemented level-up moves, ascending by level. */
  learnset: [number, string][];
  /** Implemented moves this species can learn from TMs. */
  tmMoves: string[];
  /** TM and egg moves that become automatic candidates from a level (TM tier / egg move gate). */
  extraMoves: [number, string][];
  evolutions: EvolutionDef[];
  prevo: string | null;
  /** Sprite form used for the base species ("" for most; e.g. "shield" for Aegislash). */
  spriteForm: string;
  megaForms: (FormDef & { item: string })[];
  gmax: (FormDef & { move: string; moveType: TypeKey }) | null;
  /** Battle-only alternate forms (Aegislash blade). */
  altForms: FormDef[];
}

export interface Content {
  version: string;
  species: Record<string, SpeciesDef>;
  moves: Record<string, MoveDef>;
  typeChart: Record<TypeKey, Record<TypeKey, number>>;
  /** Localizable Z-move key per type and Max-move key per type (PokeAPI names). */
  zMoves: Record<TypeKey, string>;
  maxMoves: Record<TypeKey, string>;
  maxGuard: string;
}
