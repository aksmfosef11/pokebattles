/**
 * Turns the extracted PokéRogue data (data/pokerogue) into game content:
 *   packages/game/src/generated/content.json  – roster species, implemented moves, type chart
 *   apps/client/public/locales/{lang}.json      – trimmed display names + game strings per language
 *
 * Game-design decisions that depend on real data live here: footprints from height/weight,
 * shop tiers from BST and evolution stage, PokéRogue move attrs → engine effects, and how
 * evolution conditions are converted into board rules.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dataDir = resolve(root, "data", "pokerogue");
const read = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;

// ───────────────────────────── source shapes (only fields we use)

type Stats = { hp: number; atk: number; def: number; spa: number; spd: number; spe: number };
interface RawForm {
  formKey: string;
  formSpriteKey: string;
  types: string[];
  abilities: { a1: string; a2: string | null; hidden: string | null };
  baseStats: Stats;
  bst: number;
}
interface RawSpecies {
  id: number;
  nationalDex: number;
  key: string;
  generation: number;
  types: string[];
  abilities: { a1: string; a2: string | null; hidden: string | null };
  baseStats: Stats;
  bst: number;
  height: number;
  weight: number;
  isSubLegendary: boolean;
  isLegendary: boolean;
  isMythical: boolean;
  prevolution: string | null;
  starter: string | null;
  forms: RawForm[];
}
interface RawAttr {
  name: string;
  args: unknown[];
  implicit?: boolean;
}
interface RawMove {
  id: number | null;
  key: string;
  class: string;
  type: string;
  category: "physical" | "special" | "status";
  power: number | null;
  accuracy: number | null;
  pp: number;
  chance: number | null;
  priority: number;
  target: string;
  flags: string[];
  attrs: RawAttr[];
  chargeAttrs?: RawAttr[];
  unused?: boolean;
  gigantamax?: { species: string; formKey: string };
}
interface RawEvolution {
  to: string;
  preFormKey: string | null;
  level: number;
  item: string | null;
  conditionData: { key: string; value?: number; pkmnType?: string; time?: string[] }[] | null;
}
interface RawFormChange {
  formKey: string;
  trigger: string;
  item: string | null;
  synthesized?: boolean;
}

const species = read<RawSpecies[]>(resolve(dataDir, "species.json"));
const moves = read<RawMove[]>(resolve(dataDir, "moves.json"));
const gmaxMoves = read<RawMove[]>(resolve(dataDir, "gmax-moves.json"));
const learnsets = read<Record<string, [number, string][]>>(resolve(dataDir, "learnsets.json"));
const tms = read<Record<string, (string | { species: string })[]>>(resolve(dataDir, "tms.json"));
const evolutions = read<Record<string, RawEvolution[]>>(resolve(dataDir, "evolutions.json"));
const formChanges = read<Record<string, RawFormChange[]>>(resolve(dataDir, "form-changes.json"));
const typeChartRaw = read<Record<string, Record<string, number>>>(resolve(dataDir, "type-chart.json"));
const meta = read<Record<string, unknown>>(resolve(dataDir, "meta.json"));
const roster = read<{ species: number[] }>(resolve(root, "data", "roster-ids.json"));

const TYPES = [
  "normal", "fighting", "flying", "poison", "ground", "rock", "bug", "ghost", "steel",
  "fire", "water", "grass", "electric", "psychic", "ice", "dragon", "dark", "fairy",
];

// ───────────────────────────── moves

const STAT: Record<string, string> = { ATK: "atk", DEF: "def", SPATK: "spa", SPDEF: "spd", SPD: "spe", ACC: "acc", EVA: "eva" };
const STATUS: Record<string, string> = { PARALYSIS: "par", BURN: "brn", POISON: "psn", TOXIC: "tox", SLEEP: "slp", FREEZE: "frz" };
const WEATHER: Record<string, string> = { SUNNY: "sun", HARSH_SUN: "sun", RAIN: "rain", HEAVY_RAIN: "rain", SANDSTORM: "sand", HAIL: "snow", SNOW: "snow" };
const TERRAIN: Record<string, string> = { ELECTRIC: "electric", GRASSY: "grassy", PSYCHIC: "psychic", MISTY: "misty" };
const TARGET: Record<string, string> = {
  NEAR_OTHER: "enemy",
  NEAR_ENEMY: "enemy",
  ATTACKER: "enemy",
  OTHER: "enemy",
  RANDOM_NEAR_ENEMY: "randomEnemy",
  ALL_NEAR_ENEMIES: "enemySpread",
  ALL_NEAR_OTHERS: "allAround",
  ALL_ENEMIES: "allEnemies",
  ALL_OTHERS: "allEnemies",
  USER: "self",
  CURSE: "self",
  NEAR_ALLY: "ally",
  USER_OR_NEAR_ALLY: "ally",
  USER_SIDE: "allySide",
  USER_AND_ALLIES: "allySide",
  PARTY: "allySide",
  ENEMY_SIDE: "field",
  BOTH_SIDES: "field",
  ALL: "field",
};
const FLAG: Record<string, string> = {
  punchingMove: "punch",
  bitingMove: "bite",
  slicingMove: "slice",
  soundBased: "sound",
  pulseMove: "pulse",
  ballBombMove: "ballBomb",
  recklessMove: "recoil",
  windMove: "wind",
  danceMove: "dance",
  powderMove: "powder",
  triageMove: "triage",
};
/** Attrs that only matter for mechanics this game does not have (doubles, switching, semi-invulnerable hits...). */
const IGNORED_ATTRS = new Set([
  "HitsTagForDoubleDamageAttr",
  "HitsTagAttr",
  "AlwaysHitMinimizeAttr",
  "MissEffectAttr",
  "NoEffectAttr",
  "FrenzyAttr",
  "BypassRedirectAttr",
  "GulpMissileTagAttr",
  "HealStatusEffectAttr",
  "BypassBurnDamageReductionAttr",
  "RespectAttackTypeImmunityAttr",
  "ToxicAccuracyAttr",
  "OneHitKOAccuracyAttr",
  "SheerColdAccuracyAttr",
  "PreMoveMessageAttr",
  "MessageAttr",
  "FlameBurstAttr",
  "RemoveHeldItemAttr",
  "StealHeldItemChanceAttr",
  "StealEatBerryAttr",
  "RemoveScreensAttr",
  "RemoveArenaTrapAttr",
  "ClearTerrainAttr",
  "IncrementMovePriorityAttr",
]);
/** Variable-power attacks get a fixed power so they stay usable. */
const POWER_OVERRIDE: Record<string, number> = {
  RETURN: 102,
  GYRO_BALL: 80,
  ELECTRO_BALL: 80,
  MAGNITUDE: 70,
  PUNISHMENT: 60,
  TRUMP_CARD: 60,
  HIDDEN_POWER: 60,
  NATURE_POWER: 80,
  SECRET_POWER: 70,
  WRING_OUT: 60,
  HARD_PRESS: 60,
  RAGE_FIST: 70,
};
const EXCLUDED_MOVES = new Set([
  "COUNTER", "MIRROR_COAT", "METAL_BURST", "ENDEAVOR", "FINAL_GAMBIT", "BEAT_UP", "SPIT_UP", "PRESENT", "NATURAL_GIFT",
  "FLING", "BIDE", "SKETCH", "ENDURE",
  // Their drawback is a condition this game cannot express, so they would be free power.
  "FOCUS_PUNCH", "DREAM_EATER", "STEEL_ROLLER", "SNORE", "SLEEP_TALK", "BELCH", "LAST_RESORT", "POLTERGEIST", "BURN_UP",
  "SYNCHRONOISE", "SHELL_TRAP", "BEAK_BLAST", "HOLD_BACK", "FALSE_SWIPE",
]);

interface MoveOut {
  key: string;
  id: number | null;
  type: string;
  category: string;
  power: number;
  accuracy: number | null;
  pp: number;
  priority: number;
  target: string;
  contact: boolean;
  flags: string[];
  effects: Record<string, unknown>[];
  partial?: boolean;
}

const unmappedAttrs = new Map<string, number>();

function mapMove(m: RawMove): MoveOut | null {
  if (m.unused || m.flags.includes("unimplemented") || EXCLUDED_MOVES.has(m.key)) return null;
  const target = TARGET[m.target];
  if (!target) return null;
  const effects: Record<string, unknown>[] = [];
  let partial = false;
  const status = m.category === "status";
  const chance = status ? 100 : (m.chance ?? 100);
  let power = m.power ?? 0;
  for (const a of m.attrs) {
    if (a.implicit) continue;
    const args = a.args;
    switch (a.name) {
      case "StatStageChangeAttr": {
        const stats = (args[0] as string[]).map((s) => STAT[s]).filter(Boolean);
        const self = args[2] === true;
        let tgt = self ? "self" : "target";
        if (status && !self && (target === "allySide" || target === "self" || target === "ally")) tgt = target === "allySide" ? "allies" : "self";
        effects.push({ kind: "stages", stats, delta: args[1] as number, target: tgt, chance: self && !status ? chance : chance });
        break;
      }
      case "GrowthStatStageChangeAttr":
        effects.push({ kind: "stages", stats: ["atk", "spa"], delta: 1, target: "self", chance: 100 });
        break;
      case "StatusEffectAttr": {
        const s = STATUS[args[0] as string];
        if (s) effects.push({ kind: "status", status: s, chance, ...(args[1] === true ? { self: true } : {}) });
        break;
      }
      case "MultiStatusEffectAttr":
        effects.push({ kind: "randomStatus", options: (args[0] as string[]).map((s) => STATUS[s]).filter(Boolean), chance });
        break;
      case "ConfuseAttr":
        effects.push({ kind: "confuse", chance, ...(args[0] === true ? { self: true } : {}) });
        break;
      case "FlinchAttr":
        effects.push({ kind: "flinch", chance });
        if (m.key === "FAKE_OUT" || m.key === "FIRST_IMPRESSION") effects.push({ kind: "fakeOut" });
        break;
      case "HighCritAttr":
        effects.push({ kind: "critStage", stages: typeof args[0] === "number" ? args[0] : 1 });
        break;
      case "CritOnlyAttr":
        effects.push({ kind: "alwaysCrit" });
        break;
      case "MultiHitAttr": {
        const t = (args[0] as string | undefined) ?? "TWO_TO_FIVE";
        const n: Record<string, [number, number]> = { TWO_TO_FIVE: [2, 5], TWO: [2, 2], THREE: [3, 3], TEN: [10, 10] };
        const [min, max] = n[t] ?? [2, 5];
        effects.push({ kind: "multiHit", min, max });
        break;
      }
      case "RecoilAttr":
        effects.push({ kind: "recoil", ratio: typeof args[1] === "number" ? args[1] : 0.25, basis: args[0] === true ? "maxHp" : "damage" });
        break;
      case "HitHealAttr":
        effects.push({ kind: "drain", ratio: typeof args[0] === "number" ? args[0] : 0.5 });
        break;
      case "HealAttr":
        effects.push({ kind: "heal", ratio: typeof args[0] === "number" ? args[0] : 0.5 });
        break;
      case "PlantHealAttr":
      case "SandHealAttr":
        effects.push({ kind: "heal", ratio: 0.5, weatherScaled: true });
        break;
      case "WeatherChangeAttr": {
        const w = WEATHER[args[0] as string];
        if (w) effects.push({ kind: "weather", weather: w });
        break;
      }
      case "TerrainChangeAttr": {
        const t = TERRAIN[args[0] as string];
        if (t) effects.push({ kind: "terrain", terrain: t });
        break;
      }
      case "RechargeAttr":
        effects.push({ kind: "recharge" });
        break;
      case "DelayedAttackAttr":
        // Future Sight / Doom Desire land later: treated as a charge-then-hit move.
        effects.push({ kind: "charge" });
        break;
      case "HalfSacrificialAttr":
        effects.push({ kind: "recoil", ratio: 0.5, basis: "maxHp" });
        break;
      case "OneHitKOAttr":
        effects.push({ kind: "ohko" });
        break;
      case "FixedDamageAttr":
        effects.push({ kind: "fixedDamage", amount: args[0] as number });
        break;
      case "LevelDamageAttr":
      case "RandomLevelDamageAttr":
        effects.push({ kind: "levelDamage" });
        break;
      case "TargetHalfHpDamageAttr":
        effects.push({ kind: "halveHp" });
        break;
      case "ProtectAttr":
        effects.push({ kind: "protect" });
        break;
      case "SacrificialAttr":
        effects.push({ kind: "selfFaint" });
        break;
      case "RestAttr":
        effects.push({ kind: "rest" });
        break;
      case "RandomMoveAttr":
        effects.push({ kind: "metronome" });
        break;
      case "TransformAttr":
        effects.push({ kind: "transform" });
        break;
      case "LeechSeedAttr":
        effects.push({ kind: "leechSeed" });
        break;
      case "TrapAttr":
        effects.push({ kind: "bind" });
        break;
      case "PositiveStatStagePowerAttr":
        effects.push({ kind: "storedPower" });
        break;
      case "LowHpPowerAttr":
        effects.push({ kind: "reversal" });
        break;
      case "HpPowerAttr":
        effects.push({ kind: "eruption" });
        break;
      case "WeightPowerAttr":
        effects.push({ kind: "weightPower", mode: "target" });
        break;
      case "CompareWeightPowerAttr":
        effects.push({ kind: "weightPower", mode: "ratio" });
        break;
      case "MoneyAttr":
        effects.push({ kind: "payDay" });
        break;
      case "PartyStatusCureAttr":
        effects.push({ kind: "cureTeam" });
        break;
      case "CutHpStatStageBoostAttr":
        effects.push({ kind: "bellyDrum" });
        break;
      case "ResetStatsAttr":
        effects.push({ kind: "haze" });
        break;
      case "WeatherBallTypeAttr":
        effects.push({ kind: "weatherBall" });
        break;
      case "ThunderAccuracyAttr":
        effects.push({ kind: "weatherAccuracy", weather: "rain" });
        break;
      case "BlizzardAccuracyAttr":
        effects.push({ kind: "weatherAccuracy", weather: "snow" });
        break;
      case "AntiSunlightPowerDecreaseAttr":
        effects.push({ kind: "weatherPowerHalved", except: "sun" });
        break;
      case "AddArenaTagAttr": {
        const tag = args[0] as string;
        if (tag === "REFLECT") effects.push({ kind: "screen", screen: "reflect" });
        else if (tag === "LIGHT_SCREEN") effects.push({ kind: "screen", screen: "lightScreen" });
        else if (tag === "AURORA_VEIL") effects.push({ kind: "screen", screen: "auroraVeil" });
        else if (tag === "TAILWIND") effects.push({ kind: "tailwind" });
        else partial = true;
        break;
      }
      case "AddBattlerTagAttr":
        if (args[0] === "CRIT_BOOST") effects.push({ kind: "focusEnergy" });
        else partial = true;
        break;
      case "MovePowerMultiplierAttr":
        if (m.key === "HEX" || m.key === "INFERNAL_PARADE" || m.key === "BITTER_MALICE") effects.push({ kind: "hex" });
        else if (m.key === "VENOSHOCK" || m.key === "BARB_BARRAGE") effects.push({ kind: "venoshock" });
        else if (m.key === "FACADE") effects.push({ kind: "facade" });
        else partial = true;
        break;
      case "FriendshipPowerAttr":
      case "GyroBallPowerAttr":
      case "ElectroBallPowerAttr":
      case "MagnitudePowerAttr":
      case "PunishmentPowerAttr":
      case "LessPPMorePowerAttr":
      case "HiddenPowerTypeAttr":
      case "NaturePowerAttr":
      case "OpponentHighHpPowerAttr":
        break;
      default:
        if (!IGNORED_ATTRS.has(a.name)) {
          partial = true;
          unmappedAttrs.set(a.name, (unmappedAttrs.get(a.name) ?? 0) + 1);
        }
    }
  }
  if (m.class === "ChargingAttackMove" || m.class === "ChargingSelfStatusMove") {
    const charge: Record<string, unknown> = { kind: "charge" };
    for (const a of m.chargeAttrs ?? []) {
      if (a.name === "WeatherInstantChargeAttr") {
        const list = (a.args[0] as string[]).map((w) => WEATHER[w]).filter(Boolean);
        if (list[0]) charge.skipIn = list[0];
      }
      if (a.name === "SemiInvulnerableAttr") charge.invulnerable = true;
    }
    effects.push(charge);
  }
  if (!status && power === 0) {
    const computed = effects.some((e) =>
      ["fixedDamage", "levelDamage", "halveHp", "ohko", "reversal", "eruption", "weightPower", "storedPower"].includes(e.kind as string),
    );
    if (POWER_OVERRIDE[m.key]) power = POWER_OVERRIDE[m.key]!;
    else if (!computed) return null;
  }
  if (status && effects.length === 0) return null;
  return {
    key: m.key,
    id: m.id,
    type: m.type,
    category: m.category,
    power,
    accuracy: m.accuracy === null || m.accuracy < 0 ? null : m.accuracy,
    pp: m.pp,
    priority: m.priority,
    target,
    contact: m.flags.includes("makesContact"),
    flags: m.flags.map((f) => FLAG[f]).filter((f): f is string => !!f),
    effects,
    ...(partial ? { partial: true } : {}),
  };
}

const movesOut: Record<string, MoveOut> = {};
for (const m of moves) {
  const mapped = mapMove(m);
  if (mapped) movesOut[m.key] = mapped;
}
movesOut.STRUGGLE = {
  key: "STRUGGLE",
  id: moves.find((m) => m.key === "STRUGGLE")?.id ?? null,
  type: "normal",
  category: "physical",
  power: 50,
  accuracy: null,
  pp: 1,
  priority: 0,
  target: "enemy",
  contact: true,
  flags: [],
  effects: [{ kind: "struggle" }, { kind: "recoil", ratio: 0.25, basis: "maxHp" }],
};

// ───────────────────────────── species

const byKey = new Map(species.map((s) => [s.key, s]));
const rosterIds = new Set(roster.species);
// PokéRogue species ids: national dex numbers, or 2000+ for regional forms (Alolan Ninetales = 2038).
const rosterKeys = new Set(species.filter((s) => rosterIds.has(s.id)).map((s) => s.key));

/** Long, snake-like Pokémon take a single row whose length follows their body length. */
const SERPENTS = new Set(["DRATINI", "DRAGONAIR", "ONIX", "STEELIX", "GYARADOS", "RAYQUAZA", "MILOTIC"]);
const PSEUDO_BASES = new Set(["DRATINI", "LARVITAR", "BELDUM", "GIBLE", "DEINO", "GOOMY", "JANGMO_O", "DREEPY", "FRIGIBAX"]);
/** Only obtainable through their own mechanic (fossils, Nincada). */
const NOT_IN_SHOP = new Set(["SHEDINJA", "LILEEP", "CRADILY", "ANORITH", "ARMALDO"]);
const TIER_OVERRIDE: Record<string, number> = { DITTO: 2, SHUCKLE: 2, MAGIKARP: 1, SNORLAX: 3 };

/** Board footprint from real height (m) and weight (kg): 1×1, 2×1, 2×2, 3×2, or a 2–4 cell row. */
function footprint(s: RawSpecies): { w: number; h: number } {
  if (SERPENTS.has(s.key)) return { w: s.height < 2.5 ? 2 : s.height < 5 ? 3 : 4, h: 1 };
  if (s.height >= 3.0 || s.weight >= 400) return { w: 3, h: 2 };
  if (s.height >= 1.8 || s.weight >= 150) return { w: 2, h: 2 };
  if (s.height >= 1.0 || s.weight >= 50) return { w: 2, h: 1 };
  return { w: 1, h: 1 };
}

function rosterEvolutions(key: string): RawEvolution[] {
  const seen = new Set<string>();
  const out: RawEvolution[] = [];
  for (const e of evolutions[key] ?? []) {
    if (!rosterKeys.has(e.to) || seen.has(e.to + (e.item ?? ""))) continue;
    if (e.preFormKey === "partner") continue;
    seen.add(e.to + (e.item ?? ""));
    out.push(e);
  }
  return out;
}

function prevoOf(key: string): string | null {
  const s = byKey.get(key);
  const p = s?.prevolution ?? null;
  return p && rosterKeys.has(p) ? p : null;
}

function stageOf(key: string): number {
  let n = 0;
  let cur = prevoOf(key);
  while (cur) {
    n++;
    cur = prevoOf(cur);
  }
  return n;
}

function lineLength(key: string): number {
  let base = key;
  while (prevoOf(base)) base = prevoOf(base)!;
  const depth = (k: string): number => 1 + Math.max(0, ...rosterEvolutions(k).map((e) => depth(e.to)));
  return depth(base);
}

function lineBase(key: string): string {
  let base = key;
  while (prevoOf(base)) base = prevoOf(base)!;
  return base;
}

function tierOf(s: RawSpecies): number {
  if (TIER_OVERRIDE[s.key]) return TIER_OVERRIDE[s.key]!;
  if (s.isLegendary || s.isMythical) return 5;
  if (s.isSubLegendary) return 4;
  const stage = stageOf(s.key);
  const len = lineLength(s.key);
  const final = rosterEvolutions(s.key).length === 0;
  if (PSEUDO_BASES.has(lineBase(s.key))) return Math.min(4, 2 + stage);
  if (len === 1) return s.bst < 420 ? 1 : s.bst < 490 ? 2 : s.bst <= 540 ? 3 : 4;
  if (!final) return stage === 0 ? 1 : 2;
  if (len === 2) return s.bst < 480 ? 2 : 3;
  return 3;
}

function evoLevelOf(key: string): number {
  const p = prevoOf(key);
  if (!p) return 0;
  const e = rosterEvolutions(p).find((x) => x.to === key);
  return e && e.level > 1 ? e.level : 0;
}

const ENGINE_ITEMS = new Set([
  "FIRE_STONE", "WATER_STONE", "THUNDER_STONE", "LEAF_STONE", "MOON_STONE", "SUN_STONE",
  "SHINY_STONE", "DUSK_STONE", "DAWN_STONE", "ICE_STONE", "LINKING_CORD",
]);
const TRADE_FALLBACK_LEVEL = 40;
/** Branches split by an item the game does not sell: the battle result picks the branch instead. */
const BRANCH_BY_RESULT: Record<string, "win" | "loss"> = { ARMAROUGE: "win", CERULEDGE: "loss" };

function convertEvolution(fromKey: string, e: RawEvolution): Record<string, unknown>[] {
  const out: Record<string, unknown> = { to: e.to };
  const conds = e.conditionData ?? [];
  const friendship = conds.find((c) => c.key === "FRIENDSHIP");
  const time = conds.find((c) => c.key === "TIME");
  const moveType = conds.find((c) => c.key === "MOVE_TYPE");
  const shedinja = conds.some((c) => c.key === "SHEDINJA");
  if (shedinja) return [];
  if (e.item) {
    if (ENGINE_ITEMS.has(e.item)) {
      const list: Record<string, unknown>[] = [{ to: e.to, item: e.item }];
      if (e.item === "LINKING_CORD") list.push({ to: e.to, level: TRADE_FALLBACK_LEVEL });
      return list;
    }
    // Items the game does not sell (Prism Scale, Leader's Crest) become a level threshold.
    const level = Math.min(60, Math.max(36, evoLevelOf(fromKey) + 10));
    return [{ to: e.to, level, ...(BRANCH_BY_RESULT[e.to] ? { onResult: BRANCH_BY_RESULT[e.to] } : {}) }];
  }
  if (friendship) {
    // Every friendship evolution takes 5 battles (high-friendship ones took 8: Riolu evolved in 1 of 4 live runs).
    out.battles = 5;
    // Day / night becomes the battle result only where it picks a branch (Espeon / Umbreon); on a single
    // evolution (Riolu, Budew, Snom) it only held the evolution back until a run's next win or loss.
    const friendshipBranches = rosterEvolutions(fromKey).filter((x) => x.conditionData?.some((c) => c.key === "FRIENDSHIP")).length;
    if (friendshipBranches > 1 && time?.time?.some((t) => t === "DAWN" || t === "DAY")) out.onResult = "win";
    if (friendshipBranches > 1 && time?.time?.some((t) => t === "DUSK" || t === "NIGHT")) out.onResult = "loss";
    if (moveType?.pkmnType) out.adjacentType = moveType.pkmnType.toLowerCase();
    return [out];
  }
  if (e.level > 1) {
    out.level = e.level;
    return [out];
  }
  return [{ to: e.to, level: Math.min(60, Math.max(36, evoLevelOf(fromKey) + 10)) }];
}

const gmaxBySpecies = new Map<string, { move: string; type: string }>();
for (const g of gmaxMoves) if (g.gigantamax) gmaxBySpecies.set(g.gigantamax.species, { move: g.key, type: g.type });

/**
 * Moves beyond the level-up table become automatic candidates once a Pokémon is strong enough:
 * TMs by PokéRogue's TM tier, and the first three PokéRogue egg moves of the line (the fourth is
 * the rare egg move, left out) from Lv.40.
 */
const TM_TIER_LEVEL: Record<string, number> = { COMMON: 15, GREAT: 30, ULTRA: 45 };
const EGG_MOVE_LEVEL = 40;
const tmTiers = read<Record<string, string>>(resolve(dataDir, "tm-tiers.json"));
const eggMoves = read<Record<string, string[]>>(resolve(dataDir, "egg-moves.json"));

const tmLearners = new Map<string, string[]>();
for (const [move, list] of Object.entries(tms)) {
  if (!movesOut[move]) continue;
  for (const entry of list) {
    const sp = typeof entry === "string" ? entry : entry.species;
    if (!rosterKeys.has(sp)) continue;
    const arr = tmLearners.get(sp) ?? [];
    arr.push(move);
    tmLearners.set(sp, arr);
  }
}

const speciesOut: Record<string, unknown> = {};
const rosterAbilities = new Set<string>();
const megaItems = new Set<string>();
for (const key of [...rosterKeys].sort((a, b) => byKey.get(a)!.id - byKey.get(b)!.id)) {
  const s = byKey.get(key)!;
  const base = s.forms[0];
  const abilities = [s.abilities.a1, s.abilities.a2].filter((a): a is string => !!a && a !== "NONE");
  const hidden = s.abilities.hidden && s.abilities.hidden !== "NONE" ? s.abilities.hidden : null;
  for (const a of [...abilities, hidden]) if (a) rosterAbilities.add(a);
  const learnset = (learnsets[key] ?? [])
    .filter(([lvl, m]) => lvl >= 0 && movesOut[m])
    .map(([lvl, m]) => [lvl, m] as [number, string])
    .sort((a, b) => a[0] - b[0]);
  const evos: Record<string, unknown>[] = [];
  for (const e of rosterEvolutions(key)) evos.push(...convertEvolution(key, e));
  if (key === "NINCADA") {
    const ninjask = evos.find((e) => e.to === "NINJASK");
    if (ninjask) ninjask.spawn = "SHEDINJA";
  }
  const changes = formChanges[key] ?? [];
  const megaForms = s.forms
    .filter((f) => f.formKey.startsWith("mega") || f.formKey === "primal")
    .map((f) => {
      const change = changes.find((c) => c.formKey === f.formKey && c.item && !c.synthesized);
      if (!change?.item) return null;
      megaItems.add(change.item);
      const ability = f.abilities.a1;
      if (ability) rosterAbilities.add(ability);
      return { formKey: f.formSpriteKey || f.formKey, types: f.types, baseStats: f.baseStats, ability, item: change.item };
    })
    .filter((f) => f !== null);
  const gmaxForm = s.forms.find((f) => f.formKey === "gigantamax");
  const gmaxMove = gmaxBySpecies.get(key);
  const blade = key === "AEGISLASH" ? s.forms.find((f) => f.formKey === "blade") : undefined;
  speciesOut[key] = {
    key,
    id: s.nationalDex,
    generation: s.generation,
    types: s.types,
    baseStats: s.baseStats,
    bst: s.bst,
    abilities,
    hiddenAbility: hidden,
    heightM: s.height,
    weightKg: s.weight,
    footprint: footprint(s),
    tier: tierOf(s),
    shop: !NOT_IN_SHOP.has(key),
    legendary: s.isLegendary,
    subLegendary: s.isSubLegendary,
    mythical: s.isMythical,
    learnset,
    tmMoves: [...new Set(tmLearners.get(key) ?? [])].sort(),
    extraMoves: (() => {
      const learned = new Map(learnset.map(([lvl, m]) => [m, lvl]));
      const extra = new Map<string, number>();
      for (const m of new Set(tmLearners.get(key) ?? [])) extra.set(m, TM_TIER_LEVEL[tmTiers[m] ?? ""] ?? 30);
      for (const m of (eggMoves[s.starter ?? key] ?? []).slice(0, 3)) {
        if (movesOut[m]) extra.set(m, Math.min(extra.get(m) ?? Infinity, EGG_MOVE_LEVEL));
      }
      return [...extra.entries()]
        .filter(([m, lvl]) => !(learned.has(m) && learned.get(m)! <= lvl))
        .map(([m, lvl]) => [lvl, m] as [number, string])
        .sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1));
    })(),
    evolutions: evos,
    prevo: prevoOf(key),
    spriteForm: base?.formSpriteKey ?? "",
    megaForms,
    gmax:
      gmaxForm && gmaxMove
        ? { formKey: gmaxForm.formSpriteKey || "gigantamax", types: gmaxForm.types, baseStats: gmaxForm.baseStats, ability: null, move: gmaxMove.move, moveType: gmaxMove.type }
        : null,
    altForms: blade ? [{ formKey: "blade", types: blade.types, baseStats: blade.baseStats, ability: null }] : [],
  };
}

// Keep only moves something can actually use.
const usedMoves = new Set<string>(["STRUGGLE", "HYPER_BEAM", "METRONOME"]);
for (const s of Object.values(speciesOut) as { learnset: [number, string][]; tmMoves: string[]; extraMoves: [number, string][] }[]) {
  for (const [, m] of s.learnset) usedMoves.add(m);
  for (const m of s.tmMoves) usedMoves.add(m);
  for (const [, m] of s.extraMoves) usedMoves.add(m);
}
const contentMoves: Record<string, MoveOut> = {};
for (const k of [...usedMoves].sort()) if (movesOut[k]) contentMoves[k] = movesOut[k]!;

const typeChart: Record<string, Record<string, number>> = {};
for (const a of TYPES) {
  typeChart[a] = {};
  for (const d of TYPES) typeChart[a]![d] = typeChartRaw[a]![d]!;
}

const zMoveByType: Record<string, string> = {
  normal: "BREAKNECK_BLITZ", fighting: "ALL_OUT_PUMMELING", flying: "SUPERSONIC_SKYSTRIKE", poison: "ACID_DOWNPOUR",
  ground: "TECTONIC_RAGE", rock: "CONTINENTAL_CRUSH", bug: "SAVAGE_SPIN_OUT", ghost: "NEVER_ENDING_NIGHTMARE",
  steel: "CORKSCREW_CRASH", fire: "INFERNO_OVERDRIVE", water: "HYDRO_VORTEX", grass: "BLOOM_DOOM",
  electric: "GIGAVOLT_HAVOC", psychic: "SHATTERED_PSYCHE", ice: "SUBZERO_SLAMMER", dragon: "DEVASTATING_DRAKE",
  dark: "BLACK_HOLE_ECLIPSE", fairy: "TWINKLE_TACKLE",
};
const maxMoveByType: Record<string, string> = {
  normal: "MAX_STRIKE", fighting: "MAX_KNUCKLE", flying: "MAX_AIRSTREAM", poison: "MAX_OOZE", ground: "MAX_QUAKE",
  rock: "MAX_ROCKFALL", bug: "MAX_FLUTTERBY", ghost: "MAX_PHANTASM", steel: "MAX_STEELSPIKE", fire: "MAX_FLARE",
  water: "MAX_GEYSER", grass: "MAX_OVERGROWTH", electric: "MAX_LIGHTNING", psychic: "MAX_MINDSTORM", ice: "MAX_HAILSTORM",
  dragon: "MAX_WYRMWIND", dark: "MAX_DARKNESS", fairy: "MAX_STARFALL",
};

const content = {
  version: `pokerogue-${String((meta as { sources?: { pokerogue?: { commit?: string } } }).sources?.pokerogue?.commit ?? "unknown").slice(0, 7)}`,
  species: speciesOut,
  moves: contentMoves,
  typeChart,
  zMoves: zMoveByType,
  maxMoves: maxMoveByType,
  maxGuard: "MAX_GUARD",
};
const contentPath = resolve(root, "packages", "game", "src", "generated", "content.json");
mkdirSync(dirname(contentPath), { recursive: true });
writeFileSync(contentPath, JSON.stringify(content) + "\n");

// ───────────────────────────── client locale bundles

type Dict = Record<string, unknown>;
const i18nDir = resolve(root, "data", "i18n");
const gameLocaleDir = resolve(root, "packages", "game", "locales");
const outDir = resolve(root, "apps", "client", "public", "locales");
mkdirSync(outDir, { recursive: true });

const langs = readdirSync(i18nDir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.slice(0, -5))
  .sort();
const loadI18n = (lang: string) => read<Dict>(resolve(i18nDir, `${lang}.json`));
const gameLocales = new Map<string, Dict>();
for (const f of readdirSync(gameLocaleDir)) if (f.endsWith(".json")) gameLocales.set(f.slice(0, -5), read<Dict>(resolve(gameLocaleDir, f)));

function deepMerge(base: Dict, over: Dict): Dict {
  const out: Dict = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] = b && typeof b === "object" && !Array.isArray(b) && v && typeof v === "object" && !Array.isArray(v) ? deepMerge(b as Dict, v as Dict) : v;
  }
  return out;
}

function pick(section: unknown, keys: Iterable<string>): Dict {
  const src = (section ?? {}) as Dict;
  const out: Dict = {};
  for (const k of keys) if (src[k] !== undefined) out[k] = src[k];
  return out;
}

const speciesKeys = Object.keys(speciesOut);
const formKeys: string[] = [];
for (const s of Object.values(speciesOut) as { key: string; megaForms: { formKey: string }[]; gmax: { formKey: string } | null }[]) {
  for (const f of s.megaForms) formKeys.push(`${s.key}:${f.formKey}`);
  if (s.gmax) formKeys.push(`${s.key}:${s.gmax.formKey}`);
}
const moveKeys = Object.keys(contentMoves);
const itemsManifest = read<Record<string, unknown>>(resolve(root, "apps", "client", "public", "assets", "items-manifest.json"));
const itemKeys = new Set([...Object.keys(itemsManifest), ...megaItems]);
const CHAMPIONS = ["red", "lance", "steven", "cynthia", "alder", "diantha", "kukui", "leon", "geeta"];

function bundle(lang: string): Dict {
  const chain = [lang, ...(((loadI18n(lang)._meta as Dict | undefined)?.fallbackChain as string[] | undefined) ?? ["en"])];
  let merged: Dict = {};
  for (const l of [...chain].reverse()) if (langs.includes(l)) merged = deepMerge(merged, loadI18n(l));
  const game = deepMerge((gameLocales.get("en") ?? {}) as Dict, (gameLocales.get(lang) ?? gameLocales.get(lang.split("-")[0]!) ?? {}) as Dict);
  return {
    lang,
    species: pick(merged.species, speciesKeys),
    forms: pick(merged.forms, formKeys),
    moves: pick(merged.moves, [...moveKeys]),
    abilities: pick(merged.abilities, rosterAbilities),
    types: merged.types,
    natures: merged.natures,
    stats: merged.stats,
    statusEffects: merged.statusEffects,
    items: pick(merged.items, itemKeys),
    itemTemplates: merged.itemTemplates,
    trainers: pick(merged.trainers, CHAMPIONS),
    trainerTitles: pick(merged.trainerTitles, ["champion"]),
    zMoves: merged.zMoves,
    maxMoves: merged.maxMoves,
    game,
  };
}

const NATIVE: Record<string, string> = {
  ca: "Català", da: "Dansk", de: "Deutsch", en: "English", "es-419": "Español (LatAm)", "es-ES": "Español", eu: "Euskara",
  fr: "Français", gl: "Galego", he: "עברית", hi: "हिन्दी", id: "Bahasa Indonesia", it: "Italiano", ja: "日本語", ko: "한국어",
  "nb-NO": "Norsk", pl: "Polski", "pt-BR": "Português (BR)", ro: "Română", ru: "Русский", sv: "Svenska", th: "ไทย",
  tl: "Tagalog", tr: "Türkçe", uk: "Українська", vi: "Tiếng Việt", "zh-Hans": "简体中文", "zh-Hant": "繁體中文",
};
const index: { code: string; name: string; ui: boolean }[] = [];
for (const lang of langs) {
  writeFileSync(resolve(outDir, `${lang}.json`), JSON.stringify(bundle(lang)) + "\n");
  index.push({ code: lang, name: NATIVE[lang] ?? lang, ui: gameLocales.has(lang) });
}
writeFileSync(resolve(outDir, "index.json"), JSON.stringify(index, null, 1) + "\n");

// ───────────────────────────── report

const tierCounts = [1, 2, 3, 4, 5].map((t) => (Object.values(speciesOut) as { tier: number }[]).filter((s) => s.tier === t).length);
console.log(`species ${speciesKeys.length} (tiers ${tierCounts.join("/")}), moves ${moveKeys.length}, abilities ${rosterAbilities.size}, mega items ${megaItems.size}, langs ${langs.length}`);
console.log(`partial moves ${Object.values(contentMoves).filter((m) => m.partial).length}`);
console.log("unmapped attrs:", [...unmappedAttrs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${k}:${v}`).join(" "));
