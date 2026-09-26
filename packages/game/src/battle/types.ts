import type { Cell } from "../board.ts";
import type { ChampionKey, SubclassKey } from "../content/champions.ts";
import type {
  MoveDef,
  SpeciesDef,
  StageStat,
  StatusKey,
  Terrain,
  TypeKey,
  Weather,
} from "../content/schema.ts";
import type { PokemonPiece, TeamSnapshot } from "../run/types.ts";

export const TICKS_PER_SECOND = 10;
export const PULSE_TICKS = 20;
export const SUDDEN_DEATH_TICK = 600;
export const MAX_TICKS = 1500;
export const GAUGE_FULL = 1000;

export type Side = 0 | 1;

export interface BattleInput {
  seed: string;
  teams: [TeamSnapshot, TeamSnapshot];
}

export type DamageCause =
  | "move"
  | "confusion"
  | "recoil"
  | "brn"
  | "psn"
  | "weather"
  | "helmet"
  | "contact"
  | "lifeOrb"
  | "leechSeed"
  | "bind"
  | "gmax"
  | "fatigue"
  | "struggle"
  | "selfFaint"
  | "ability"
  | "item";

export type HealCause = "move" | "drain" | "item" | "leftovers" | "shellBell" | "ability" | "berry" | "leechSeed" | "terrain" | "bag" | "mega";

export type FormChange = "mega" | "dynamax" | "gmax" | "undynamax" | "tera" | "transform" | "stance" | "disguise";

export type BattleEvent =
  | { t: number; k: "move"; src: number; move: string; targets: number[]; variant?: "z" | "max" | "gmax" }
  | { t: number; k: "damage"; target: number; amount: number; hp: number; cause: DamageCause; crit?: boolean; eff?: number; src?: number }
  | { t: number; k: "heal"; target: number; amount: number; hp: number; cause: HealCause }
  | { t: number; k: "miss"; src: number; target: number }
  | { t: number; k: "immune"; src: number; target: number }
  | { t: number; k: "protect"; target: number }
  | { t: number; k: "status"; target: number; status: StatusKey; stacks?: number }
  | { t: number; k: "cure"; target: number }
  | { t: number; k: "confuse"; target: number }
  | { t: number; k: "stage"; target: number; stat: StageStat; delta: number }
  | { t: number; k: "flinch"; target: number }
  | { t: number; k: "faint"; target: number }
  | { t: number; k: "cant"; target: number; reason: "par" | "slp" | "frz" | "recharge" }
  | { t: number; k: "charge"; src: number; move: string }
  | { t: number; k: "weather"; weather: Weather | null }
  | { t: number; k: "terrain"; terrain: Terrain | null }
  | { t: number; k: "ability"; src: number; ability: string }
  | { t: number; k: "item"; src: number; item: string }
  | {
      t: number;
      k: "form";
      target: number;
      form: FormChange;
      species: string;
      formKey: string;
      types: TypeKey[];
      maxHp: number;
      hp: number;
      tera?: TypeKey | "stellar";
    }
  | { t: number; k: "sudden" }
  | { t: number; k: "end"; winner: Side | null };

export interface BattlerView {
  id: number;
  side: Side;
  uid: string;
  species: string;
  formKey: string;
  shiny: boolean;
  level: number;
  types: TypeKey[];
  ability: string;
  maxHp: number;
  hp: number;
  cells: Cell[];
  moves: string[];
  items: string[];
}

export interface Frame {
  hp: number[];
  gauge: number[];
}

export interface BattleResult {
  winner: Side | null;
  ticks: number;
  events: BattleEvent[];
  initial: BattlerView[];
  /** Per-tick hp/gauge snapshots when `recordFrames` is on (client playback). */
  frames: Frame[];
  fainted: [string[], string[]];
  rewards: [{ gold: number }, { gold: number }];
}

export interface Stages {
  atk: number;
  def: number;
  spa: number;
  spd: number;
  spe: number;
  acc: number;
  eva: number;
}

export interface BattleStats {
  atk: number;
  def: number;
  spa: number;
  spd: number;
  spe: number;
}

export interface ItemBundle {
  /** item key → number of adjacent copies */
  counts: Map<string, number>;
  /** Remaining one-shot uses (berries, sashes). */
  uses: Map<string, number>;
  /** Berry key → adjacent copies lying on a Berry Pouch (used after the other copies). */
  pouched: Map<string, number>;
  /** Types whose moves are boosted, with multiplier. */
  typeBoost: Map<TypeKey, number>;
  zTypes: Set<TypeKey>;
  teraType: TypeKey | "stellar" | null;
  megaForm: string | null;
  megaAtStart: boolean;
  dynamaxBand: boolean;
}

export interface Battler {
  id: number;
  side: Side;
  uid: string;
  piece: PokemonPiece;
  species: SpeciesDef;
  formKey: string;
  types: TypeKey[];
  originalTypes: TypeKey[];
  ability: string;
  level: number;
  /** Stats with static modifiers (items, champion) already applied. */
  stats: BattleStats;
  maxHp: number;
  hp: number;
  alive: boolean;
  stages: Stages;
  critStage: number;
  status: StatusKey | null;
  sleepTurns: number;
  poisonStacks: number;
  confusion: number;
  gauge: number;
  moves: { key: string; pp: number; enabled: boolean }[];
  choiceLock: string | null;
  charging: string | null;
  invulnerable: boolean;
  recharge: boolean;
  protectUntil: number;
  protectChain: number;
  leechSeedBy: number | null;
  bind: { src: number; pulses: number; divisor: number } | null;
  actions: number;
  cells: Cell[];
  items: ItemBundle;
  /** Static damage multiplier from champion rules (e.g. Red's Pikachu partner). */
  moveTypeMult: Map<TypeKey, number>;
  damageTakenMult: number;
  /** Static speed multiplier that survives Transform (Quick Powder, Macho Brace). */
  speedMult: number;
  /** Metronome item: the last move used and how many times in a row. */
  lastMove: string | null;
  streak: number;
  flashFire: boolean;
  megaDone: boolean;
  isMega: boolean;
  dynamax: { actionsLeft: number; hpMult: number; gmax: boolean; baseMaxHp: number } | null;
  /** Heal per pulse from medic bags, as a fraction of max HP. */
  bagHeal: number;
  tera: TypeKey | "stellar" | null;
  stellarUsed: Set<TypeKey>;
  zUsed: boolean;
  damageDealt: number;
  transformedFrom: string | null;
  /** Aegislash stance: "shield" or "blade" */
  stance: string | null;
  /** Move sealed by Cursed Body until the given tick. */
  disabledMove: { key: string; until: number } | null;
  /** Once-per-battle ability triggers that already fired (Run Away, Pickpocket, Disguise). */
  spent: Set<string>;
}

export interface SideState {
  side: Side;
  team: TeamSnapshot;
  champion: ChampionKey;
  subclass: SubclassKey | null;
  zLeft: number;
  megasLeft: number;
  terasLeft: number;
  dynamaxDone: boolean;
  screens: { reflect: number; lightScreen: number; auroraVeil: number };
  tailwind: number;
  firstFaintDone: boolean;
  fainted: number;
  /** G-Max residual damage: pulses left and the type spared. */
  gmaxResidual: { pulses: number; spare: TypeKey } | null;
  gold: number;
  /** Amulet Coins touching at least one Pokémon (paid out on a win). */
  amuletCoins: number;
}

export interface FieldState {
  weather: Weather | null;
  weatherPulses: number;
  terrain: Terrain | null;
  terrainPulses: number;
  /** Primal weather (Desolate Land, Primordial Sea, Delta Stream): lasts while its source is on the field. */
  primal: { kind: "sun" | "rain" | "wind"; src: number } | null;
}

export type ResolvedMove = MoveDef & { variant?: "z" | "max" | "gmax"; baseKey: string };
