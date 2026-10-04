import { BERRY_POUCH_SAVE_CHANCE, touches } from "../board.ts";
import { CHAMPION_RULES, isLanceKin } from "../content/champions.ts";
import { CONTENT, getMove, getSpecies, ITEMS, RESIST_BERRIES, STATUS_ORB_ABILITIES, TIMED_ITEMS } from "../content/index.ts";
import type { MoveDef, MoveEffect, StageStat, StatusKey, Stats, Terrain, TypeKey, Weather } from "../content/schema.ts";
import { rngFor, type Rng } from "../rng.ts";
import { calcStats } from "../stats.ts";
import { chooseMove } from "./ai.ts";
import {
  accStageMult,
  count,
  critRate,
  isGrounded,
  maxPower,
  stackMul,
  stageMult,
  typeMult,
  zPower,
} from "./calc.ts";
import { buildSide } from "./setup.ts";
import {
  GAUGE_FULL,
  MAX_TICKS,
  PULSE_TICKS,
  SUDDEN_DEATH_TICK,
  TICKS_PER_SECOND,
  type BattleEvent,
  type BattleInput,
  type BattleResult,
  type Battler,
  type BattlerView,
  type DamageCause,
  type FieldState,
  type Frame,
  type HealCause,
  type ResolvedMove,
  type Side,
  type SideState,
  type TimedItemState,
} from "./types.ts";

type EventBody = BattleEvent extends infer E ? (E extends { t: number } ? Omit<E, "t"> : never) : never;

const MAX_MOVE_EFFECT: Record<TypeKey, { kind: "foe" | "ally" | "weather" | "terrain"; stat?: StageStat; delta?: number; weather?: Weather; terrain?: Terrain }> = {
  normal: { kind: "foe", stat: "spe", delta: -1 },
  fighting: { kind: "ally", stat: "atk", delta: 1 },
  flying: { kind: "ally", stat: "spe", delta: 1 },
  poison: { kind: "ally", stat: "spa", delta: 1 },
  ground: { kind: "ally", stat: "spd", delta: 1 },
  rock: { kind: "weather", weather: "sand" },
  bug: { kind: "foe", stat: "spa", delta: -1 },
  ghost: { kind: "foe", stat: "def", delta: -1 },
  steel: { kind: "ally", stat: "def", delta: 1 },
  fire: { kind: "weather", weather: "sun" },
  water: { kind: "weather", weather: "rain" },
  grass: { kind: "terrain", terrain: "grassy" },
  electric: { kind: "terrain", terrain: "electric" },
  psychic: { kind: "terrain", terrain: "psychic" },
  ice: { kind: "weather", weather: "snow" },
  dragon: { kind: "foe", stat: "atk", delta: -1 },
  dark: { kind: "foe", stat: "spd", delta: -1 },
  fairy: { kind: "terrain", terrain: "misty" },
};

const WEATHER_ABILITY: Record<string, Weather> = {
  DROUGHT: "sun",
  ORICHALCUM_PULSE: "sun",
  DRIZZLE: "rain",
  SAND_STREAM: "sand",
  SNOW_WARNING: "snow",
};
const TERRAIN_ABILITY: Record<string, Terrain> = {
  HADRON_ENGINE: "electric",
  ELECTRIC_SURGE: "electric",
  GRASSY_SURGE: "grassy",
  PSYCHIC_SURGE: "psychic",
  MISTY_SURGE: "misty",
};
/** Primal weather: lasts while its source is on the field and blocks other weather. */
const PRIMAL_ABILITY: Record<string, "sun" | "rain" | "wind"> = {
  DESOLATE_LAND: "sun",
  PRIMORDIAL_SEA: "rain",
  DELTA_STREAM: "wind",
};
const MOLD_BREAKERS = new Set(["MOLD_BREAKER", "TURBOBLAZE", "TERAVOLT"]);
/**
 * Speed Boost: +1 Speed every SPEED_BOOST_EVERY pulses, up to SPEED_BOOST_MAX. Speed is how often a
 * Pokémon acts here, so the main-series +1 per turn up to +6 snowballed (Ninjask carried Steven's early game).
 */
const SPEED_BOOST_EVERY = 2;
/** Knockouts per battle that raise a legendary's (tier 5) better attacking stat a stage. */
export const LEGEND_KO_BOOSTS = 2;
/** `ability` event key of that boost; the client shows it as "legendary aura", not as an ability name. */
export const LEGEND_AURA = "LEGEND_AURA";
const SPEED_BOOST_MAX = 6;
/** Paradox abilities and the field condition that powers them (Booster Energy stands in for it). */
const PARADOX_FIELD: Record<string, { weather?: Weather; terrain?: Terrain }> = {
  PROTOSYNTHESIS: { weather: "sun" },
  QUARK_DRIVE: { terrain: "electric" },
};
const PARADOX_STATS = ["atk", "def", "spa", "spd", "spe"] as const;
type ParadoxStat = (typeof PARADOX_STATS)[number];
const CUTE_CHARM_GAUGE = 300;
const CURSED_BODY_TICKS = 40;
const WEATHER_ROCK: Record<Weather, string> = { sun: "HEAT_ROCK", rain: "DAMP_ROCK", sand: "SMOOTH_ROCK", snow: "ICY_ROCK" };
const PINCH_BERRIES: Record<string, StageStat> = { LIECHI_BERRY: "atk", SALAC_BERRY: "spe", PETAYA_BERRY: "spa" };
const SECONDARY_KINDS = new Set(["status", "randomStatus", "confuse", "flinch"]);
const RESIST_BERRY_BY_TYPE = new Map<TypeKey, string>(RESIST_BERRIES.map(([key, type]) => [type, key]));
const TERRAIN_SEED: Record<Terrain, [string, StageStat]> = {
  electric: ["ELECTRIC_SEED", "def"],
  grassy: ["GRASSY_SEED", "def"],
  misty: ["MISTY_SEED", "spd"],
  psychic: ["PSYCHIC_SEED", "spd"],
};

function minRow(b: Battler): number {
  let m = Infinity;
  for (const c of b.cells) m = Math.min(m, c.y);
  return m;
}

function centerX(b: Battler): number {
  let s = 0;
  for (const c of b.cells) s += c.x;
  return s / Math.max(1, b.cells.length);
}

export interface SimOptions {
  recordFrames?: boolean;
}

export function simulateBattle(input: BattleInput, opts: SimOptions = {}): BattleResult {
  return new BattleSim(input, opts).run();
}

export class BattleSim {
  tick = 0;
  readonly events: BattleEvent[] = [];
  readonly frames: Frame[] = [];
  readonly battlers: Battler[];
  readonly sides: [SideState, SideState];
  readonly field: FieldState = { weather: null, weatherPulses: 0, terrain: null, terrainPulses: 0, primal: null };
  readonly rng: Rng;
  private fatiguePulses = 0;
  /** Opportunist copies are not copied again. */
  private copyingBoosts = false;
  private mirroring = false;
  /** Paradox Pokémon whose Booster Energy is active for the rest of the battle. */
  private readonly boosted = new Set<number>();
  /** Start-of-battle abilities already ran (a mega evolution before that must not trigger them twice). */
  private started = false;
  private ended = false;
  private winner: Side | null = null;
  private readonly initial: BattlerView[];

  constructor(
    input: BattleInput,
    private readonly opts: SimOptions,
  ) {
    this.rng = rngFor(input.seed, "battle");
    const a = buildSide(input.teams[0], 0, 0);
    const b = buildSide(input.teams[1], 1, a.battlers.length);
    this.battlers = [...a.battlers, ...b.battlers];
    this.sides = [a.state, b.state];
    this.initial = this.battlers.map((x) => this.view(x));
  }

  // ───────────────────────────── plumbing

  emit(e: EventBody): void {
    this.events.push({ ...e, t: this.tick } as BattleEvent);
  }

  private view(b: Battler): BattlerView {
    return {
      id: b.id,
      side: b.side,
      uid: b.uid,
      species: b.species.key,
      formKey: b.formKey,
      shiny: b.piece.shiny,
      level: b.level,
      types: [...b.types],
      ability: b.ability,
      maxHp: b.maxHp,
      hp: b.hp,
      cells: b.cells.map((c) => ({ ...c })),
      moves: b.moves.map((m) => m.key),
      items: [...b.items.counts.keys()].sort(),
    };
  }

  living(side?: Side): Battler[] {
    return this.battlers.filter((b) => b.alive && (side === undefined || b.side === side));
  }

  enemiesOf(b: Battler): Battler[] {
    return this.living((1 - b.side) as Side);
  }

  alliesOf(b: Battler, includeSelf = false): Battler[] {
    return this.living(b.side).filter((x) => includeSelf || x !== b);
  }

  adjacentAllies(b: Battler): Battler[] {
    return this.alliesOf(b).filter((x) => touches(b.cells, x.cells));
  }

  weather(): Weather | null {
    if (!this.field.weather) return null;
    if (this.battlers.some((b) => b.alive && (b.ability === "AIR_LOCK" || b.ability === "CLOUD_NINE"))) return null;
    return this.field.weather;
  }

  private has(b: Battler, ability: string, attacker?: Battler): boolean {
    if (b.ability !== ability) return false;
    // Mold Breaker (and Turboblaze / Teravolt) ignores the target's defensive abilities.
    if (attacker && attacker !== b && attacker.side !== b.side && MOLD_BREAKERS.has(attacker.ability)) return false;
    return true;
  }

  /** Weather as the attacker's own moves see it: Mega Sol uses every move as if in harsh sunlight. */
  private moveWeather(att: Battler): Weather | null {
    return att.ability === "MEGA_SOL" ? "sun" : this.weather();
  }

  /** Protosynthesis / Quark Drive: is the ability's field condition up (sun / Electric Terrain)? */
  private paradoxFieldUp(b: Battler): boolean {
    const need = PARADOX_FIELD[b.ability];
    if (!need) return false;
    return need.weather ? this.weather() === need.weather : this.field.terrain === need.terrain;
  }

  /** Highest of the five stats; ties go to the earlier stat, as in the main series. */
  private paradoxStat(b: Battler): ParadoxStat {
    let best: ParadoxStat = "atk";
    for (const k of PARADOX_STATS) if (b.stats[k] > b.stats[best]) best = k;
    return best;
  }

  /** Protosynthesis / Quark Drive: the highest stat ×1.3 (Speed ×1.5) in their field or after Booster Energy. */
  private paradoxMult(b: Battler, stat: ParadoxStat): number {
    if (!PARADOX_FIELD[b.ability] || this.paradoxStat(b) !== stat) return 1;
    if (!this.boosted.has(b.id) && !this.paradoxFieldUp(b)) return 1;
    return stat === "spe" ? 1.5 : 1.3;
  }

  /** Booster Energy kicks in whenever a paradox Pokémon's field condition is not up (battle start, or when it ends). */
  private checkBoosterEnergy(): void {
    for (const b of this.living()) {
      if (!PARADOX_FIELD[b.ability] || this.boosted.has(b.id) || this.paradoxFieldUp(b)) continue;
      if (!this.useOnce(b, "BOOSTER_ENERGY")) continue;
      this.boosted.add(b.id);
      this.emit({ k: "ability", src: b.id, ability: b.ability });
    }
  }

  /** A weather or terrain just came up: show the paradox Pokémon it powers. */
  private announceParadox(): void {
    for (const b of this.living()) {
      if (PARADOX_FIELD[b.ability] && !this.boosted.has(b.id) && this.paradoxFieldUp(b)) this.emit({ k: "ability", src: b.id, ability: b.ability });
    }
  }

  /** Primal weather in effect (suppressed by Air Lock / Cloud Nine like normal weather). */
  primalKind(): "sun" | "rain" | "wind" | null {
    const p = this.field.primal;
    if (!p) return null;
    if (this.battlers.some((b) => b.alive && (b.ability === "AIR_LOCK" || b.ability === "CLOUD_NINE"))) return null;
    return p.kind;
  }

  /** Weight used by weight-based moves. */
  weightOf(b: Battler): number {
    let kg = b.species.weightKg;
    if (b.ability === "HEAVY_METAL") kg *= 2;
    if (b.ability === "LIGHT_METAL") kg /= 2;
    return kg;
  }

  /** Aroma Veil protects the Pokémon and its adjacent allies from mind games. */
  private aromaVeiled(b: Battler): boolean {
    return b.ability === "AROMA_VEIL" || this.adjacentAllies(b).some((a) => a.ability === "AROMA_VEIL");
  }

  /** Magnet Pull and Shadow Tag hold enemies in place: their gauge fills slower. */
  private trapSlow(b: Battler): number {
    let mult = 1;
    const foes = this.enemiesOf(b);
    if (b.types.includes("steel") && foes.some((f) => f.ability === "MAGNET_PULL")) mult *= 0.75;
    if (foes.some((f) => f.ability === "SHADOW_TAG")) {
      const mine = this.living(b.side);
      if (mine.length > 0 && minRow(b) === Math.min(...mine.map(minRow))) mult *= 0.8;
    }
    return mult;
  }

  /** Gauge loss from flinching, Cute Charm or G-Max Terror (Suction Cups holds on). */
  private loseGauge(b: Battler, amount: number): boolean {
    if (b.ability === "SUCTION_CUPS") {
      this.emit({ k: "ability", src: b.id, ability: b.ability });
      return false;
    }
    b.gauge = Math.max(0, b.gauge - amount);
    return true;
  }

  /** An unused berry or one-shot item Frisk / Pickpocket can take away. */
  private stealableItem(b: Battler): string | null {
    const keys = [...b.items.uses.keys()].filter((k) => !k.startsWith("__") && (b.items.uses.get(k) ?? 0) > 0).sort();
    return keys[0] ?? null;
  }

  /** Pickpocket / Magician: once per battle, take one unused berry or one-shot item. */
  private steal(thief: Battler, victim: Battler): void {
    if (thief.spent.has(thief.ability) || !thief.alive || !victim.alive) return;
    const item = this.stealableItem(victim);
    if (!item) return;
    if (this.has(victim, "STICKY_HOLD", thief)) {
      this.emit({ k: "ability", src: victim.id, ability: "STICKY_HOLD" });
      return;
    }
    thief.spent.add(thief.ability);
    this.emit({ k: "ability", src: thief.id, ability: thief.ability });
    this.removeItemUse(victim, item);
    thief.items.counts.set(item, (thief.items.counts.get(item) ?? 0) + 1);
    thief.items.uses.set(item, (thief.items.uses.get(item) ?? 0) + 1);
    this.checkThresholds(thief);
  }

  private removeItemUse(b: Battler, item: string): void {
    b.items.uses.set(item, (b.items.uses.get(item) ?? 1) - 1);
    b.items.counts.set(item, Math.max(0, (b.items.counts.get(item) ?? 1) - 1));
    this.emit({ k: "item", src: b.id, item });
  }

  effSpeed(b: Battler): number {
    let spe = b.stats.spe * stageMult(b.stages.spe);
    const w = this.weather();
    if ((w === "sun" && b.ability === "CHLOROPHYLL") || (w === "rain" && b.ability === "SWIFT_SWIM")) spe *= 2;
    if ((w === "sand" && b.ability === "SAND_RUSH") || (w === "snow" && b.ability === "SLUSH_RUSH")) spe *= 2;
    if (b.status && b.ability === "QUICK_FEET") spe *= 1.5;
    else if (b.status === "par") spe *= 0.5;
    if (this.sides[b.side].tailwind > 0) spe *= 2;
    spe *= b.speedMult;
    if (b.ability === "UNBURDEN" && (b.items.uses.get("__consumed") ?? 0) > 0) spe *= 2;
    if (b.ability === "LIGHT_METAL") spe *= 1.1;
    spe *= this.paradoxMult(b, "spe");
    spe *= this.trapSlow(b);
    return spe;
  }

  private gaugeGain(b: Battler): number {
    // Action interval (s) = 4.8 / (1 + speed / 60); 10 ticks per second.
    return (100 * (1 + this.effSpeed(b) / 60)) / 4.8;
  }

  private gaugeCost(priority: number): number {
    return Math.max(400, Math.min(2400, GAUGE_FULL * (1 - 0.2 * priority)));
  }

  // ───────────────────────────── main loop

  run(): BattleResult {
    this.start();
    this.recordFrame();
    while (!this.ended) {
      this.tick++;
      if (this.tick % PULSE_TICKS === 0) this.pulse();
      if (!this.ended) this.timedEvents();
      if (!this.ended) {
        for (const b of this.battlers) if (b.alive) b.gauge += this.gaugeGain(b);
        this.resolveReady();
      }
      this.recordFrame();
      if (!this.ended && this.tick >= MAX_TICKS) this.finish(null);
    }
    const fainted: [string[], string[]] = [[], []];
    for (const b of this.battlers) if (!b.alive) fainted[b.side].push(b.uid);
    return {
      winner: this.winner,
      ticks: this.tick,
      events: this.events,
      initial: this.initial,
      frames: this.frames,
      fainted,
      rewards: [this.rewardsFor(0), this.rewardsFor(1)],
    };
  }

  private rewardsFor(side: Side): { gold: number } {
    const s = this.sides[side];
    let gold = s.gold;
    if (this.winner === side) gold += s.amuletCoins;
    for (const b of this.battlers) {
      if (b.side !== side) continue;
      const punches = count(b, "GOLDEN_PUNCH");
      if (punches > 0) gold += Math.min(3 * punches, Math.floor(b.damageDealt / b.maxHp));
      if (b.ability === "PICKUP" && this.rng.chance(0.2)) gold += 1;
    }
    return { gold };
  }

  private recordFrame(): void {
    if (!this.opts.recordFrames) return;
    this.frames.push({
      hp: this.battlers.map((b) => b.hp),
      gauge: this.battlers.map((b) => (b.alive ? Math.min(GAUGE_FULL, Math.round(b.gauge)) : 0)),
    });
  }

  private resolveReady(): void {
    for (let guard = 0; guard < 64 && !this.ended; guard++) {
      let next: Battler | null = null;
      for (const b of this.battlers) {
        if (!b.alive || b.gauge < GAUGE_FULL) continue;
        if (
          !next ||
          b.gauge > next.gauge ||
          (b.gauge === next.gauge && this.effSpeed(b) > this.effSpeed(next)) ||
          (b.gauge === next.gauge && this.effSpeed(b) === this.effSpeed(next) && b.id < next.id)
        ) {
          next = b;
        }
      }
      if (!next) return;
      const cost = this.act(next);
      next.gauge -= cost;
      this.checkEnd();
    }
  }

  private checkEnd(): void {
    if (this.ended) return;
    const a = this.living(0).length;
    const b = this.living(1).length;
    if (a === 0 && b === 0) this.finish(null);
    else if (a === 0) this.finish(1);
    else if (b === 0) this.finish(0);
  }

  private finish(winner: Side | null): void {
    this.ended = true;
    this.winner = winner;
    this.emit({ k: "end", winner });
  }

  // ───────────────────────────── battle start

  private start(): void {
    for (const b of this.battlers) b.gauge = this.rng.int(0, 300);
    for (const side of this.sides) this.startTera(side);
    for (const b of this.battlers) {
      const side = this.sides[b.side];
      if (b.items.megaForm && (b.items.megaAtStart || (side.subclass === "steven_mega" && b.species.key === "METAGROSS"))) {
        this.megaEvolve(b);
      }
    }
    // Fastest first so the slowest weather setter wins, as in the main series.
    const order = [...this.battlers].sort((x, y) => this.effSpeed(y) - this.effSpeed(x) || x.id - y.id);
    for (const b of order) this.startAbility(b);
    this.checkBoosterEnergy();
    this.started = true;
    for (const b of this.battlers) {
      // Orbs only work on Pokémon that gain from a status. Toxic Orb gives plain poison: badly poisoned
      // stacks every pulse here and would knock out even a Guts Pokémon in about ten seconds.
      if (STATUS_ORB_ABILITIES.includes(b.ability)) {
        for (const [orb, status] of [["FLAME_ORB", "brn"], ["TOXIC_ORB", "psn"]] as const) {
          if (b.status || count(b, orb) === 0 || !this.canHaveStatus(b, status)) continue;
          this.emit({ k: "item", src: b.id, item: orb });
          this.applyStatus(b, status);
        }
      }
      const side = this.sides[b.side];
      if (side.subclass === "lance_dragondance" && isLanceKin(b.types)) this.changeStages(b, ["atk", "spe"], 1);
      if (side.subclass === "alder_volcarona" && b.types.includes("bug")) this.changeStages(b, ["spa", "spd", "spe"], 1);
      if (side.subclass === "lance_hyperbeam" && isLanceKin(b.types) && CONTENT.moves.HYPER_BEAM) {
        if (!b.moves.some((m) => m.key === "HYPER_BEAM")) b.moves.unshift({ key: "HYPER_BEAM", pp: getMove("HYPER_BEAM").pp, enabled: true });
      }
    }
  }

  private startTera(side: SideState): void {
    if (side.terasLeft <= 0) return;
    for (const b of this.battlers) {
      if (b.side !== side.side || !b.items.teraType || side.terasLeft <= 0) continue;
      side.terasLeft--;
      b.tera = b.items.teraType;
      if (b.tera !== "stellar") b.types = [b.tera];
      const boost = CHAMPION_RULES.geeta.teraStatBonus + CHAMPION_RULES.geeta.teraStatPerRound * side.team.round;
      for (const k of ["atk", "def", "spa", "spd", "spe"] as const) b.stats[k] *= boost;
      this.emitForm(b, "tera");
    }
  }

  private startAbility(b: Battler): void {
    if (!b.alive) return;
    const ab = b.ability;
    const weather = WEATHER_ABILITY[ab];
    if (weather) {
      this.emit({ k: "ability", src: b.id, ability: ab });
      this.setWeather(weather, b);
    }
    const terrain = TERRAIN_ABILITY[ab];
    if (terrain) {
      this.emit({ k: "ability", src: b.id, ability: ab });
      this.setTerrain(terrain, b);
    }
    const primal = PRIMAL_ABILITY[ab];
    if (primal) {
      this.emit({ k: "ability", src: b.id, ability: ab });
      this.field.primal = { kind: primal, src: b.id };
      if (primal === "wind") {
        if (this.field.weather) {
          this.field.weather = null;
          this.emit({ k: "weather", weather: null });
        }
      } else {
        this.field.weather = primal;
        this.field.weatherPulses = Number.MAX_SAFE_INTEGER;
        this.emit({ k: "weather", weather: primal });
      }
    }
    switch (ab) {
      case "INTIMIDATE": {
        this.emit({ k: "ability", src: b.id, ability: ab });
        const foes = this.enemiesOf(b);
        if (foes.length === 0) break;
        const front = Math.min(...foes.map(minRow));
        for (const f of foes) {
          if (minRow(f) !== front) continue;
          if (f.ability === "INNER_FOCUS" || f.ability === "OWN_TEMPO" || f.ability === "OBLIVIOUS" || f.ability === "SCRAPPY") {
            this.emit({ k: "ability", src: f.id, ability: f.ability });
            continue;
          }
          this.changeStages(f, ["atk"], -1, b);
          if (f.ability === "RATTLED") this.changeStages(f, ["spe"], 1);
          if (this.useOnce(f, "ADRENALINE_ORB")) this.changeStages(f, ["spe"], 1);
        }
        break;
      }
      case "DOWNLOAD": {
        const foes = this.enemiesOf(b);
        if (foes.length === 0) break;
        const def = foes.reduce((s, f) => s + f.stats.def, 0);
        const spd = foes.reduce((s, f) => s + f.stats.spd, 0);
        this.emit({ k: "ability", src: b.id, ability: ab });
        this.changeStages(b, [def < spd ? "atk" : "spa"], 1);
        break;
      }
      case "INTREPID_SWORD":
        this.emit({ k: "ability", src: b.id, ability: ab });
        this.changeStages(b, ["atk"], 1);
        break;
      case "DAUNTLESS_SHIELD":
        this.emit({ k: "ability", src: b.id, ability: ab });
        this.changeStages(b, ["def"], 1);
        break;
      case "IMPOSTER": {
        const target = this.frontTarget(b, this.enemiesOf(b));
        if (target) {
          this.emit({ k: "ability", src: b.id, ability: ab });
          this.transform(b, target);
        }
        break;
      }
      case "TRACE": {
        const target = this.frontTarget(b, this.enemiesOf(b));
        if (target && target.ability !== "TRACE" && target.ability !== "IMPOSTER") {
          b.ability = target.ability;
          this.emit({ k: "ability", src: b.id, ability: "TRACE" });
          this.startAbility(b);
        }
        break;
      }
      case "ANTICIPATION": {
        const threat = this.enemiesOf(b).some((e) =>
          e.moves.some((m) => {
            const mv = CONTENT.moves[m.key];
            return !!mv && mv.category !== "status" && (typeMult(mv.type, b.types) > 1 || mv.effects.some((x) => x.kind === "ohko"));
          }),
        );
        if (threat) {
          this.emit({ k: "ability", src: b.id, ability: ab });
          this.changeStages(b, ["eva"], 1);
        }
        break;
      }
      case "FRISK": {
        const target = this.frontTarget(b, this.enemiesOf(b));
        if (!target) break;
        const item = this.stealableItem(target);
        if (!item) break;
        if (this.has(target, "STICKY_HOLD", b)) {
          this.emit({ k: "ability", src: target.id, ability: "STICKY_HOLD" });
          break;
        }
        this.emit({ k: "ability", src: b.id, ability: ab });
        this.removeItemUse(target, item);
        break;
      }
      case "AIR_LOCK":
      case "CLOUD_NINE":
      case "PRESSURE":
      case "UNNERVE":
      case "MOLD_BREAKER":
      case "TURBOBLAZE":
      case "TERAVOLT":
      case "FAIRY_AURA":
      case "DARK_AURA":
        this.emit({ k: "ability", src: b.id, ability: ab });
        break;
    }
  }

  private timedEvents(): void {
    for (const side of this.sides) {
      if (side.dynamaxDone || this.tick < CHAMPION_RULES.leon.dynamaxTick) continue;
      side.dynamaxDone = true;
      const candidates = this.living(side.side).filter((b) => b.items.dynamaxBand);
      candidates.sort((x, y) => y.level - x.level || x.id - y.id);
      const target = candidates[0];
      if (target) this.dynamax(target);
    }
    for (const side of this.sides) for (const t of side.timed) this.useTimedItem(t);
  }

  /** A battle item whose cooldown is up: X items boost every Pokémon they touch, potions heal the most hurt one. */
  private useTimedItem(t: TimedItemState): void {
    if (t.usesLeft <= 0 || this.tick < t.readyAt) return;
    const def = TIMED_ITEMS[t.item]!;
    const holders = t.holders.map((id) => this.battlers[id]!).filter((b) => b.alive);
    if ("stage" in def) {
      const boosted = holders.filter((b) => b.ability !== "CONTRARY");
      if (boosted.length === 0) return;
      for (const b of boosted) {
        this.emit({ k: "item", src: b.id, item: t.item });
        this.changeStages(b, [def.stage], 1);
      }
    } else {
      // Waits for someone to be hurt; the cooldown starts again once it is used.
      const hurt = holders.filter((b) => b.hp < b.maxHp).sort((x, y) => x.hp / x.maxHp - y.hp / y.maxHp || x.id - y.id)[0];
      if (!hurt) return;
      this.emit({ k: "item", src: hurt.id, item: t.item });
      this.heal(hurt, Math.max(1, Math.floor(hurt.maxHp * def.heal)), "item");
    }
    t.usesLeft--;
    t.readyAt = this.tick + def.every * TICKS_PER_SECOND;
  }

  // ───────────────────────────── pulse (end-of-turn effects every 2 s)

  private pulse(): void {
    const w = this.weather();
    for (const b of this.battlers) {
      if (!b.alive) continue;
      if (w === "sand" && !b.types.some((t) => t === "rock" || t === "ground" || t === "steel")) {
        if (!["MAGIC_GUARD", "SAND_VEIL", "SAND_RUSH", "SAND_FORCE", "OVERCOAT"].includes(b.ability) && count(b, "SAFETY_GOGGLES") === 0) {
          this.damage(b, Math.max(1, Math.floor(b.maxHp / 16)), "weather");
        }
      }
      if (!b.alive) continue;
      if (b.status === "brn" && b.ability !== "MAGIC_GUARD") {
        this.damage(b, Math.max(1, Math.floor(b.maxHp / (b.ability === "HEATPROOF" ? 32 : 16))), "brn");
      }
      if ((b.status === "psn" || b.status === "tox") && b.alive) {
        if (b.ability === "POISON_HEAL") {
          this.heal(b, Math.floor(b.maxHp / 8), "ability");
        } else if (b.ability !== "MAGIC_GUARD") {
          this.damage(b, Math.max(1, Math.floor((b.maxHp * Math.min(8, b.poisonStacks)) / 16)), "psn");
        }
        if (b.status === "tox") b.poisonStacks = Math.min(8, b.poisonStacks + 1);
      }
      if (!b.alive) continue;
      const leftovers = count(b, "LEFTOVERS");
      if (leftovers > 0) this.heal(b, Math.floor((b.maxHp * leftovers) / 16), "leftovers");
      const sludge = count(b, "BLACK_SLUDGE");
      if (sludge > 0) {
        if (b.types.includes("poison")) this.heal(b, Math.floor((b.maxHp * sludge) / 16), "item");
        else if (b.ability !== "MAGIC_GUARD") this.damage(b, Math.max(1, Math.floor((b.maxHp * sludge) / 16)), "item");
        if (!b.alive) continue;
      }
      if (b.bagHeal > 0) this.heal(b, Math.floor(b.maxHp * b.bagHeal), "bag");
      if (this.field.terrain === "grassy" && isGrounded(b)) this.heal(b, Math.floor(b.maxHp / 16), "terrain");
      if (b.ability === "REGENERATOR") this.heal(b, Math.floor(b.maxHp / 24), "ability");
      if (b.leechSeedBy !== null) {
        const src = this.battlers[b.leechSeedBy];
        if (src && src.alive && b.ability !== "MAGIC_GUARD") {
          const dealt = this.damage(b, Math.max(1, Math.floor(b.maxHp / 8)), "leechSeed", src.id);
          this.heal(src, Math.floor(dealt * (1 + 0.3 * count(src, "BIG_ROOT"))), "leechSeed");
        } else {
          b.leechSeedBy = null;
        }
      }
      if (b.bind && b.alive) {
        if (b.ability !== "MAGIC_GUARD") this.damage(b, Math.max(1, Math.floor(b.maxHp / b.bind.divisor)), "bind", b.bind.src);
        b.bind.pulses--;
        if (b.bind.pulses <= 0) b.bind = null;
      }
      const residual = this.sides[(1 - b.side) as Side].gmaxResidual;
      if (residual && b.alive && !b.types.includes(residual.spare) && b.ability !== "MAGIC_GUARD") {
        this.damage(b, Math.max(1, Math.floor(b.maxHp / 6)), "gmax");
      }
      if (!b.alive) continue;
      this.pulseAbility(b, w);
    }
    this.tickDurations();
    if (this.tick >= SUDDEN_DEATH_TICK) {
      if (this.fatiguePulses === 0) this.emit({ k: "sudden" });
      this.fatiguePulses++;
      for (const b of this.battlers) {
        if (b.alive) this.damage(b, Math.max(1, Math.floor(b.maxHp * 0.05 * this.fatiguePulses)), "fatigue");
      }
    }
    this.checkEnd();
  }

  private pulseAbility(b: Battler, w: Weather | null): void {
    switch (b.ability) {
      case "SPEED_BOOST":
        if (b.stages.spe < SPEED_BOOST_MAX && (this.tick / PULSE_TICKS) % SPEED_BOOST_EVERY === 0) {
          this.emit({ k: "ability", src: b.id, ability: b.ability });
          this.changeStages(b, ["spe"], 1);
        }
        break;
      case "MOODY": {
        const stats: StageStat[] = ["atk", "def", "spa", "spd", "spe"];
        const up = this.rng.pick(stats.filter((s) => b.stages[s] < 6).length ? stats.filter((s) => b.stages[s] < 6) : stats);
        const downPool = stats.filter((s) => s !== up && b.stages[s] > -6);
        this.emit({ k: "ability", src: b.id, ability: b.ability });
        this.changeStages(b, [up], 2);
        if (downPool.length) this.changeStages(b, [this.rng.pick(downPool)], -1);
        break;
      }
      case "RAIN_DISH":
        if (w === "rain") this.heal(b, Math.floor(b.maxHp / 16), "ability");
        break;
      case "ICE_BODY":
        if (w === "snow") this.heal(b, Math.floor(b.maxHp / 16), "ability");
        break;
      case "DRY_SKIN":
        if (w === "rain") this.heal(b, Math.floor(b.maxHp / 8), "ability");
        if (w === "sun") this.damage(b, Math.floor(b.maxHp / 8), "ability");
        break;
      case "SOLAR_POWER":
        if (w === "sun") this.damage(b, Math.floor(b.maxHp / 8), "ability");
        break;
      case "SHED_SKIN":
        if (b.status && this.rng.chance(0.3)) this.cure(b, true);
        break;
      case "SCREEN_CLEANER": {
        const screens = this.sides[(1 - b.side) as Side].screens;
        if (screens.reflect > 0 || screens.lightScreen > 0 || screens.auroraVeil > 0) {
          this.emit({ k: "ability", src: b.id, ability: b.ability });
          screens.reflect = 0;
          screens.lightScreen = 0;
          screens.auroraVeil = 0;
        }
        break;
      }
      case "HEALER":
        for (const a of this.adjacentAllies(b)) {
          if (a.status && this.rng.chance(0.3)) {
            this.emit({ k: "ability", src: b.id, ability: b.ability });
            this.cure(a, false);
          }
        }
        break;
      case "NATURAL_CURE":
        if (b.status && this.rng.chance(0.5)) this.cure(b, true);
        break;
      case "HYDRATION":
        if (b.status && w === "rain") this.cure(b, true);
        break;
      case "HARVEST": {
        const consumed = [...b.items.counts.keys()].filter((k) => k.endsWith("_BERRY") && (b.items.uses.get(k) ?? 0) < (b.items.counts.get(k) ?? 0));
        if (consumed.length && this.rng.chance(w === "sun" ? 1 : 0.5)) {
          const k = consumed[0]!;
          b.items.uses.set(k, (b.items.uses.get(k) ?? 0) + 1);
          this.emit({ k: "ability", src: b.id, ability: b.ability });
        }
        break;
      }
    }
  }

  private tickDurations(): void {
    if (this.field.weather) {
      this.field.weatherPulses--;
      if (this.field.weatherPulses <= 0) {
        this.field.weather = null;
        this.emit({ k: "weather", weather: null });
        this.checkBoosterEnergy();
      }
    }
    if (this.field.terrain) {
      this.field.terrainPulses--;
      if (this.field.terrainPulses <= 0) {
        this.field.terrain = null;
        this.emit({ k: "terrain", terrain: null });
        this.checkBoosterEnergy();
      }
    }
    for (const s of this.sides) {
      s.screens.reflect = Math.max(0, s.screens.reflect - 1);
      s.screens.lightScreen = Math.max(0, s.screens.lightScreen - 1);
      s.screens.auroraVeil = Math.max(0, s.screens.auroraVeil - 1);
      s.tailwind = Math.max(0, s.tailwind - 1);
      if (s.gmaxResidual) {
        s.gmaxResidual.pulses--;
        if (s.gmaxResidual.pulses <= 0) s.gmaxResidual = null;
      }
    }
  }

  // ───────────────────────────── actions

  private act(b: Battler): number {
    b.actions++;
    if (b.recharge) {
      b.recharge = false;
      this.emit({ k: "cant", target: b.id, reason: "recharge" });
      return GAUGE_FULL;
    }
    if (b.status === "slp") {
      b.sleepTurns -= b.ability === "EARLY_BIRD" ? 2 : 1;
      if (b.sleepTurns > 0) {
        this.emit({ k: "cant", target: b.id, reason: "slp" });
        return GAUGE_FULL;
      }
      this.cure(b, false);
    }
    if (b.status === "frz") {
      if (this.rng.chance(0.2)) {
        this.cure(b, false);
      } else {
        this.emit({ k: "cant", target: b.id, reason: "frz" });
        return GAUGE_FULL;
      }
    }
    if (b.status === "par" && this.rng.chance(0.25)) {
      this.emit({ k: "cant", target: b.id, reason: "par" });
      return GAUGE_FULL;
    }
    if (b.confusion > 0) {
      b.confusion--;
      if (this.rng.chance(1 / 3)) {
        const a = b.stats.atk * stageMult(b.stages.atk);
        const d = b.stats.def * stageMult(b.stages.def);
        const dmg = Math.floor(Math.floor((Math.floor((2 * b.level) / 5 + 2) * 40 * a) / d) / 50) + 2;
        this.damage(b, dmg, "confusion");
        return GAUGE_FULL;
      }
    }

    let cost: number;
    if (b.charging) {
      const key = b.charging;
      b.charging = null;
      b.invulnerable = false;
      cost = this.useMove(b, this.resolveMove(b, key), true);
    } else {
      const key = chooseMove(this, b);
      cost = this.useMove(b, this.resolveMove(b, key), false);
    }
    if (b.alive && b.dynamax) {
      b.dynamax.actionsLeft--;
      if (b.dynamax.actionsLeft <= 0) this.undynamax(b);
    }
    const claws = count(b, "QUICK_CLAW");
    if (b.alive && claws > 0 && this.rng.chance(1 - stackMul(0.8, claws))) {
      this.emit({ k: "item", src: b.id, item: "QUICK_CLAW" });
      b.gauge += 500;
    }
    return cost;
  }

  /** Base move plus Z / Max transformations the battler would apply right now. */
  resolveMove(b: Battler, key: string): ResolvedMove {
    const base = CONTENT.moves[key] ?? struggleMove();
    const move: ResolvedMove = { ...base, baseKey: base.key };
    if (b.dynamax) {
      if (base.category === "status") {
        return { ...move, key: CONTENT.maxGuard, category: "status", target: "self", effects: [{ kind: "protect" }], accuracy: null, priority: 4, variant: "max" };
      }
      const gmax = b.dynamax.gmax && b.species.gmax && b.species.gmax.moveType === base.type ? b.species.gmax : null;
      return {
        ...move,
        key: gmax ? gmax.move : CONTENT.maxMoves[base.type],
        power: maxPower(base.power || 100, base.type),
        accuracy: null,
        target: "enemy",
        effects: [],
        priority: 0,
        variant: gmax ? "gmax" : "max",
      };
    }
    const side = this.sides[b.side];
    if (!b.zUsed && side.zLeft > 0 && base.category !== "status" && b.items.zTypes.has(base.type)) {
      return {
        ...move,
        key: CONTENT.zMoves[base.type],
        power: zPower(base.power || 120),
        accuracy: null,
        effects: [],
        variant: "z",
      };
    }
    return move;
  }

  private useMove(b: Battler, move: ResolvedMove, fromCharge: boolean): number {
    const slot = b.moves.find((m) => m.key === move.baseKey);
    if (slot && !fromCharge) {
      const pressure = this.enemiesOf(b).some((e) => e.ability === "PRESSURE");
      slot.pp = Math.max(0, slot.pp - (pressure ? 2 : 1));
      if (slot.pp === 0 && this.useOnce(b, "LEPPA_BERRY")) slot.pp = 10;
    }
    if (b.lastMove === move.baseKey) b.streak++;
    else {
      b.lastMove = move.baseKey;
      b.streak = 1;
    }
    if (move.variant === "z") {
      b.zUsed = true;
      this.sides[b.side].zLeft--;
    }
    let priority = move.priority;
    if (move.category === "status" && b.ability === "PRANKSTER") priority += 1;
    if (move.type === "flying" && b.ability === "GALE_WINGS" && b.hp === b.maxHp) priority += 1;

    const charge = move.effects.find((e): e is Extract<MoveEffect, { kind: "charge" }> => e.kind === "charge");
    if (charge && !fromCharge && !(charge.skipIn && this.moveWeather(b) === charge.skipIn) && !this.useOnce(b, "POWER_HERB")) {
      b.charging = move.baseKey;
      b.invulnerable = !!charge.invulnerable;
      this.emit({ k: "charge", src: b.id, move: move.baseKey });
      return this.gaugeCost(priority);
    }
    if (!move.effects.some((e) => e.kind === "protect")) b.protectChain = 0;
    this.executeMove(b, move);
    if (b.alive && move.flags.includes("sound") && this.useOnce(b, "THROAT_SPRAY")) this.changeStages(b, ["spa"], 1);
    return this.gaugeCost(priority);
  }

  // ───────────────────────────── targeting

  frontTarget(att: Battler, pool: Battler[]): Battler | null {
    if (pool.length === 0) return null;
    const row = Math.min(...pool.map(minRow));
    const cx = centerX(att);
    const front = pool.filter((p) => minRow(p) === row);
    front.sort((a, b) => Math.abs(centerX(a) - cx) - Math.abs(centerX(b) - cx) || a.id - b.id);
    return front[0]!;
  }

  /**
   * Whether an attack can do anything to this foe: type immunity, Wonder Guard, Levitate/Air Balloon
   * and absorbing abilities. Attackers aim past foes their move cannot touch, as a player would.
   */
  canAffect(att: Battler, def: Battler, move: MoveDef): boolean {
    if (move.category === "status") return true;
    const { type } = this.moveType(att, move);
    const eff = move.effects.some((e) => e.kind === "struggle") ? 1 : typeMult(type, def.types, { scrappy: att.ability === "SCRAPPY" });
    if (eff === 0) return false;
    const ab = (k: string) => this.has(def, k, att);
    if (eff <= 1 && ab("WONDER_GUARD")) return false;
    if (type === "ground" && (ab("LEVITATE") || ab("EARTH_EATER") || (def.items.uses.get("AIR_BALLOON") ?? 0) > 0)) return false;
    if (type === "water" && (ab("WATER_ABSORB") || ab("DRY_SKIN") || ab("STORM_DRAIN"))) return false;
    if (type === "electric" && (ab("VOLT_ABSORB") || ab("LIGHTNING_ROD") || ab("MOTOR_DRIVE"))) return false;
    if (type === "fire" && ab("FLASH_FIRE")) return false;
    if (type === "grass" && ab("SAP_SIPPER")) return false;
    return true;
  }

  /** `estimate` is used by the AI: it must not consume randomness, so random targets resolve to the front. */
  primaryTarget(att: Battler, move: MoveDef, estimate = false): Battler | null {
    const all = this.enemiesOf(att);
    const reachable = all.filter((f) => this.canAffect(att, f, move));
    const foes = reachable.length > 0 ? reachable : all;
    if ((att.ability === "INFILTRATOR" || att.ability === "STALWART") && foes.length > 0) {
      return [...foes].sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp || a.id - b.id)[0]!;
    }
    if (move.target === "randomEnemy" && !estimate) return foes.length ? this.rng.pick(foes) : null;
    return this.frontTarget(att, foes);
  }

  resolveTargets(att: Battler, move: MoveDef, estimate = false): Battler[] {
    switch (move.target) {
      case "self":
        return [att];
      case "ally": {
        const allies = this.adjacentAllies(att);
        if (allies.length === 0) return [att];
        return [allies.sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp || a.id - b.id)[0]!];
      }
      case "allySide":
        return this.alliesOf(att, true);
      case "field":
        return [];
      case "allEnemies":
        return this.enemiesOf(att);
      case "enemySpread":
      case "allAround": {
        const t = this.primaryTarget(att, move, estimate);
        if (!t) return [];
        const out = [t, ...this.enemiesOf(att).filter((e) => e !== t && touches(t.cells, e.cells))];
        if (move.target === "allAround") out.push(...this.adjacentAllies(att));
        return out;
      }
      default: {
        const t = this.primaryTarget(att, move, estimate);
        return t ? [t] : [];
      }
    }
  }

  // ───────────────────────────── move execution

  moveType(att: Battler, move: MoveDef): { type: TypeKey; boosted: boolean } {
    if (move.effects.some((e) => e.kind === "weatherBall")) {
      const w = this.moveWeather(att);
      if (w) return { type: ({ sun: "fire", rain: "water", sand: "rock", snow: "ice" } as const)[w], boosted: false };
    }
    if (att.ability === "LIQUID_VOICE" && move.flags.includes("sound")) return { type: "water", boosted: false };
    if (move.type === "normal") {
      const conv: Record<string, TypeKey> = { AERILATE: "flying", PIXILATE: "fairy", REFRIGERATE: "ice", GALVANIZE: "electric", DRAGONIZE: "dragon" };
      const t = conv[att.ability];
      if (t) return { type: t, boosted: true };
    }
    return { type: move.type, boosted: false };
  }

  private executeMove(att: Battler, move: ResolvedMove): void {
    if (move.effects.some((e) => e.kind === "metronome")) {
      this.emit({ k: "move", src: att.id, move: move.key, targets: [] });
      const pool = Object.values(CONTENT.moves).filter((m) => !m.effects.some((e) => e.kind === "metronome" || e.kind === "struggle" || e.kind === "charge"));
      const picked = this.rng.pick(pool.sort((a, b) => (a.key < b.key ? -1 : 1)));
      this.executeMove(att, { ...picked, baseKey: picked.key });
      return;
    }
    if (move.effects.some((e) => e.kind === "fakeOut") && att.actions > 1) {
      this.emit({ k: "move", src: att.id, move: move.key, targets: [] });
      return;
    }
    const targets = this.resolveTargets(att, move);
    this.emit({
      k: "move",
      src: att.id,
      move: move.key,
      targets: targets.map((t) => t.id),
      ...(move.variant ? { variant: move.variant } : {}),
    });
    if (move.category === "status") {
      this.statusMove(att, move, targets);
      return;
    }
    if (move.effects.some((e) => e.kind === "selfFaint")) {
      const damp = this.battlers.find((x) => x.alive && this.has(x, "DAMP", att));
      if (damp) {
        this.emit({ k: "ability", src: damp.id, ability: "DAMP" });
        return;
      }
    }
    if (att.stance === "shield") this.switchStance(att, "blade");
    const { type, boosted } = this.moveType(att, move);
    if ((att.ability === "PROTEAN" || att.ability === "LIBERO") && !att.tera && (att.types.length !== 1 || att.types[0] !== type)) {
      att.types = [type];
      this.emit({ k: "ability", src: att.id, ability: att.ability });
    }

    const spread = targets.length > 1;
    let total = 0;
    let anyHit = false;
    const secondaries = move.effects.filter((e) => SECONDARY_KINDS.has(e.kind) || (e.kind === "stages" && e.target === "target"));
    const sheerForce = att.ability === "SHEER_FORCE" && secondaries.length > 0;

    const primal = this.primalKind();
    for (const def of targets) {
      if (!def.alive || !att.alive) continue;
      const pierced = def !== att && def.protectUntil >= this.tick && move.contact && att.ability === "PIERCING_DRILL";
      if (def !== att && def.protectUntil >= this.tick && !pierced) {
        this.emit({ k: "protect", target: def.id });
        continue;
      }
      if (pierced) this.emit({ k: "ability", src: att.id, ability: att.ability });
      if (def !== att && def.side === att.side && this.has(def, "TELEPATHY")) {
        this.emit({ k: "ability", src: def.id, ability: "TELEPATHY" });
        continue;
      }
      if ((primal === "sun" && type === "water") || (primal === "rain" && type === "fire")) {
        const src = this.battlers[this.field.primal!.src]!;
        this.emit({ k: "ability", src: src.id, ability: src.ability });
        this.emit({ k: "immune", src: att.id, target: def.id });
        continue;
      }
      let eff = move.effects.some((e) => e.kind === "struggle")
        ? 1
        : typeMult(type, def.types, { scrappy: att.ability === "SCRAPPY" });
      // Delta Stream: strong winds take away the Flying type's weaknesses.
      if (primal === "wind" && def.types.includes("flying") && typeMult(type, ["flying"]) > 1) eff /= 2;
      if (def !== att && this.absorbs(def, att, move, type, eff)) continue;
      if (eff === 0) {
        this.emit({ k: "immune", src: att.id, target: def.id });
        continue;
      }
      if (!this.hitCheck(att, def, move)) {
        this.emit({ k: "miss", src: att.id, target: def.id });
        if (this.useOnce(att, "BLUNDER_POLICY")) this.changeStages(att, ["spe"], 2);
        continue;
      }
      anyHit = true;
      if (!def.spent.has("DISGUISE") && !def.dynamax && this.has(def, "DISGUISE", att)) {
        def.spent.add("DISGUISE");
        this.emit({ k: "ability", src: def.id, ability: "DISGUISE" });
        if (def.species.key === "MIMIKYU") {
          def.formKey = "busted";
          this.emitForm(def, "disguise");
        }
        this.damage(def, Math.max(1, Math.floor(def.maxHp / 8)), "ability");
        continue;
      }
      const ohko = move.effects.some((e) => e.kind === "ohko");
      if (ohko) {
        if (def.dynamax || def.level > att.level || this.has(def, "STURDY", att)) {
          this.emit({ k: "immune", src: att.id, target: def.id });
          continue;
        }
        total += this.damage(def, def.hp, "move", att.id, { eff });
        if (!def.alive) this.onKo(att, def);
        continue;
      }

      const hits = this.hitCount(att, move, targets.length);
      for (let h = 0; h < hits.count; h++) {
        if (!def.alive) break;
        const crit = this.rollCrit(att, def, move);
        let dmg = this.computeDamage(att, def, move, type, boosted, { spread, crit, eff });
        if (h >= hits.full) dmg = Math.max(1, Math.floor(dmg * 0.25));
        if (pierced) dmg = Math.max(1, Math.floor(dmg * 0.25));
        const dealt = this.damage(def, dmg, "move", att.id, { crit, eff });
        if (crit && def.alive && def.ability === "ANGER_POINT") {
          this.emit({ k: "ability", src: def.id, ability: def.ability });
          this.changeStages(def, ["atk"], 12);
        }
        total += dealt;
        att.damageDealt += dealt;
        if (move.contact && att.alive && att.ability !== "LONG_REACH") this.contactEffects(att, def, move);
        if (move.contact && att.ability === "POISON_TOUCH" && def.alive && count(def, "COVERT_CLOAK") === 0 && this.rng.chance(0.3)) {
          if (this.applyStatus(def, "psn", att)) this.emit({ k: "ability", src: att.id, ability: att.ability });
        }
      }
      if (!def.alive) {
        this.onKo(att, def);
        continue;
      }
      // Fire thaws the target.
      if (type === "fire" && def.status === "frz") this.cure(def, false);
      const cloaked = count(def, "COVERT_CLOAK") > 0;
      if (!sheerForce && !cloaked && !this.has(def, "SHIELD_DUST", att)) this.secondaryEffects(att, def, move);
      const kingsRock = count(att, "KINGS_ROCK");
      const flinchChance = 1 - stackMul(0.9, kingsRock) + (att.ability === "STENCH" ? 0.1 : 0);
      if (!cloaked && flinchChance > 0 && !move.effects.some((e) => e.kind === "flinch") && this.rng.chance(flinchChance)) this.flinch(def);
      this.onHitTaken(def, att, move, type, eff);
      if (att.ability === "MAGICIAN") this.steal(att, def);
      for (const e of move.effects) {
        if (e.kind === "bind" && def.alive && !def.bind) {
          def.bind = { src: att.id, pulses: count(att, "GRIP_CLAW") > 0 ? 8 : 4, divisor: count(att, "BINDING_BAND") > 0 ? 6 : 8 };
        }
      }
    }

    if (anyHit && att.alive) this.afterHit(att, move, total, sheerForce);
    if (move.effects.some((e) => e.kind === "selfFaint") && att.alive) this.damage(att, att.hp, "selfFaint");
    if (move.variant === "max" || move.variant === "gmax") this.maxMoveEffect(att, move, type);
  }

  private afterHit(att: Battler, move: ResolvedMove, total: number, sheerForce: boolean): void {
    for (const e of move.effects) {
      if (e.kind === "drain" && total > 0) this.heal(att, Math.max(1, Math.floor(total * e.ratio * (1 + 0.3 * count(att, "BIG_ROOT")))), "drain");
      if (e.kind === "recoil" && att.ability !== "ROCK_HEAD" && att.ability !== "MAGIC_GUARD") {
        const side = this.sides[att.side];
        const volt = move.baseKey === "VOLT_TACKLE" && side.subclass === "red_pikachu" && side.team.ace === att.uid;
        if (!volt) {
          const amount = e.basis === "maxHp" ? Math.floor(att.maxHp * e.ratio) : Math.floor(total * e.ratio);
          if (amount > 0) this.damage(att, amount, "recoil");
        }
      }
      if (e.kind === "stages" && e.target === "self" && att.alive && (e.chance >= 100 || this.rng.chance(this.effectChance(att, e.chance)))) {
        this.changeStages(att, e.stats, e.delta);
      }
      if (e.kind === "recharge") {
        const lanceSkip = this.sides[att.side].champion === "lance";
        if (!lanceSkip) att.recharge = true;
      }
      if (e.kind === "payDay") this.sides[att.side].gold += 1;
      if (e.kind === "status" && e.self && att.alive) this.applyStatus(att, e.status, att);
      if (e.kind === "confuse" && e.self && att.alive) this.applyConfusion(att);
    }
    const orbs = count(att, "LIFE_ORB");
    if (orbs > 0 && att.alive && att.ability !== "MAGIC_GUARD" && !sheerForce) {
      this.damage(att, Math.max(1, Math.floor((att.maxHp * orbs) / 10)), "lifeOrb");
    }
    const bells = count(att, "SHELL_BELL");
    if (bells > 0 && att.alive && total > 0) this.heal(att, Math.max(1, Math.floor((total * bells) / 8)), "shellBell");
  }

  private hitCount(att: Battler, move: MoveDef, targetCount: number): { count: number; full: number } {
    const mh = move.effects.find((e): e is Extract<MoveEffect, { kind: "multiHit" }> => e.kind === "multiHit");
    let full = 1;
    if (mh) {
      if (att.ability === "SKILL_LINK" || mh.min === mh.max) full = mh.max;
      else if (mh.min === 2 && mh.max === 5 && count(att, "LOADED_DICE") > 0) full = this.rng.int(4, 5);
      else if (mh.min === 2 && mh.max === 5) full = this.rng.weighted([[2, 35], [3, 35], [4, 15], [5, 15]] as const);
      else full = this.rng.int(mh.min, mh.max);
    }
    const lens = !mh && targetCount === 1 ? count(att, "MULTI_LENS") : 0;
    return { count: full + lens, full };
  }

  private rollCrit(att: Battler, def: Battler, move: MoveDef): boolean {
    if (this.has(def, "BATTLE_ARMOR", att) || this.has(def, "SHELL_ARMOR", att)) return false;
    if (move.effects.some((e) => e.kind === "alwaysCrit")) return true;
    if (att.ability === "MERCILESS" && (def.status === "psn" || def.status === "tox")) return true;
    let stage = att.critStage;
    for (const e of move.effects) if (e.kind === "critStage") stage += e.stages;
    if (att.ability === "SUPER_LUCK") stage += 1;
    return this.rng.chance(critRate(stage));
  }

  hitCheck(att: Battler, def: Battler, move: MoveDef): boolean {
    if (def.invulnerable && def !== att) return att.ability === "NO_GUARD" || def.ability === "NO_GUARD";
    if (move.accuracy === null) return true;
    if (att.ability === "NO_GUARD" || def.ability === "NO_GUARD") return true;
    const w = this.moveWeather(att);
    for (const e of move.effects) if (e.kind === "weatherAccuracy" && e.weather === w) return true;
    let acc = move.accuracy;
    if (move.effects.some((e) => e.kind === "ohko")) acc = 30 + Math.max(0, att.level - def.level);
    let stage = att.stages.acc - (att.ability === "UNAWARE" || att.ability === "KEEN_EYE" ? Math.min(0, def.stages.eva) : def.stages.eva);
    if (def.ability === "UNAWARE") stage = -def.stages.eva;
    let mult = accStageMult(stage) * (1 + 0.1 * count(att, "WIDE_LENS")) * stackMul(0.9, count(def, "BRIGHT_POWDER"));
    if (this.effSpeed(def) > this.effSpeed(att)) mult *= stackMul(1.2, count(att, "ZOOM_LENS"));
    if (att.ability === "COMPOUND_EYES") mult *= 1.3;
    if (att.ability === "HUSTLE" && move.category === "physical") mult *= 0.8;
    if ((w === "sand" && this.has(def, "SAND_VEIL", att)) || (w === "snow" && this.has(def, "SNOW_CLOAK", att))) mult *= 0.8;
    if (def.confusion > 0 && this.has(def, "TANGLED_FEET", att)) mult *= 0.5;
    return this.rng.next() * 100 < acc * mult;
  }

  /** Ability-based immunities and absorptions. Returns true when the hit is stopped. */
  private absorbs(def: Battler, att: Battler, move: MoveDef, type: TypeKey, eff: number): boolean {
    const stop = (heal?: boolean, stat?: StageStat) => {
      this.emit({ k: "ability", src: def.id, ability: def.ability });
      if (heal) this.heal(def, Math.floor(def.maxHp / 4), "ability");
      if (stat) this.changeStages(def, [stat], 1);
      if (!heal && !stat) this.emit({ k: "immune", src: att.id, target: def.id });
      return true;
    };
    if (type === "ground" && this.has(def, "LEVITATE", att) && move.category !== "status") return stop();
    if (type === "ground" && move.category !== "status" && (def.items.uses.get("AIR_BALLOON") ?? 0) > 0) {
      this.emit({ k: "item", src: def.id, item: "AIR_BALLOON" });
      this.emit({ k: "immune", src: att.id, target: def.id });
      return true;
    }
    if (type === "ground" && this.has(def, "EARTH_EATER", att)) return stop(true);
    if (type === "fire" && this.has(def, "FLASH_FIRE", att)) {
      def.flashFire = true;
      return stop();
    }
    if (type === "water" && (this.has(def, "WATER_ABSORB", att) || this.has(def, "DRY_SKIN", att))) return stop(true);
    if (type === "water" && this.has(def, "STORM_DRAIN", att)) return stop(false, "spa");
    if (type === "electric" && this.has(def, "VOLT_ABSORB", att)) return stop(true);
    if (type === "electric" && this.has(def, "LIGHTNING_ROD", att)) return stop(false, "spa");
    if (type === "electric" && this.has(def, "MOTOR_DRIVE", att)) return stop(false, "spe");
    if (type === "grass" && this.has(def, "SAP_SIPPER", att)) return stop(false, "atk");
    if (move.flags.includes("ballBomb") && this.has(def, "BULLETPROOF", att)) return stop();
    if (move.flags.includes("sound") && this.has(def, "SOUNDPROOF", att)) return stop();
    if (move.category !== "status" && eff <= 1 && this.has(def, "WONDER_GUARD", att)) return stop();
    return false;
  }

  movePower(att: Battler, def: Battler, move: ResolvedMove, type: TypeKey): number {
    let power = move.power;
    const w = this.weather();
    for (const e of move.effects) {
      switch (e.kind) {
        case "storedPower": {
          let pos = 0;
          for (const k of ["atk", "def", "spa", "spd", "spe", "acc", "eva"] as const) pos += Math.max(0, att.stages[k]);
          power = 20 + 20 * pos;
          break;
        }
        case "hex":
          if (def.status) power *= 2;
          break;
        case "facade":
          if (att.status) power *= 2;
          break;
        case "venoshock":
          if (def.status === "psn" || def.status === "tox") power *= 2;
          break;
        case "reversal": {
          const r = (48 * att.hp) / att.maxHp;
          power = r < 2 ? 200 : r < 5 ? 150 : r < 10 ? 100 : r < 17 ? 80 : r < 33 ? 40 : 20;
          break;
        }
        case "eruption":
          power = Math.max(1, Math.floor((150 * att.hp) / att.maxHp));
          break;
        case "weightPower": {
          if (e.mode === "target") {
            const kg = this.weightOf(def);
            power = kg < 10 ? 20 : kg < 25 ? 40 : kg < 50 ? 60 : kg < 100 ? 80 : kg < 200 ? 100 : 120;
          } else {
            const ratio = this.weightOf(att) / Math.max(0.1, this.weightOf(def));
            power = ratio >= 5 ? 120 : ratio >= 4 ? 100 : ratio >= 3 ? 80 : ratio >= 2 ? 60 : 40;
          }
          break;
        }
        case "weatherBall":
          if (w) power *= 2;
          break;
        case "weatherPowerHalved":
          if (w && w !== e.except) power = Math.floor(power / 2);
          break;
      }
    }
    if (att.tera && att.tera !== "stellar" && type === att.tera && power < CHAMPION_RULES.geeta.teraMinPower && !move.variant) {
      power = CHAMPION_RULES.geeta.teraMinPower;
    }
    if (att.ability === "TECHNICIAN" && power <= 60) power *= 1.5;
    return power;
  }

  computeDamage(
    att: Battler,
    def: Battler,
    move: ResolvedMove,
    type: TypeKey,
    typeConverted: boolean,
    opts: { spread: boolean; crit: boolean; eff: number; roll?: number; estimate?: boolean },
  ): number {
    for (const e of move.effects) {
      if (e.kind === "fixedDamage") return e.amount;
      if (e.kind === "levelDamage") return att.level;
      if (e.kind === "halveHp") return Math.max(1, Math.floor(def.hp / 2));
    }
    const physical = move.category === "physical";
    const w = this.moveWeather(att);
    const power = this.movePower(att, def, move, type);

    let atkStage = physical ? att.stages.atk : att.stages.spa;
    if (opts.crit && atkStage < 0) atkStage = 0;
    if (this.has(def, "UNAWARE", att)) atkStage = 0;
    let A = (physical ? att.stats.atk : att.stats.spa) * stageMult(atkStage);
    if (physical && (att.ability === "HUGE_POWER" || att.ability === "PURE_POWER")) A *= 2;
    if (physical && att.ability === "GUTS" && att.status) A *= 1.5;
    if (physical && att.ability === "HUSTLE") A *= 1.5;
    if (!physical && att.ability === "SOLAR_POWER" && w === "sun") A *= 1.5;
    A *= this.paradoxMult(att, physical ? "atk" : "spa");
    if (type === "fire" && att.flashFire) A *= 1.5;
    const pinch: Record<string, TypeKey> = { BLAZE: "fire", TORRENT: "water", OVERGROW: "grass", SWARM: "bug" };
    if (pinch[att.ability] === type && att.hp * 3 <= att.maxHp) A *= 1.5;
    const plusMinus = (x: Battler) => x.ability === "PLUS" || x.ability === "MINUS";
    if (!physical && plusMinus(att) && this.adjacentAllies(att).some(plusMinus)) A *= 1.5;

    let defStage = physical ? def.stages.def : def.stages.spd;
    if (opts.crit && defStage > 0) defStage = 0;
    if (att.ability === "UNAWARE") defStage = 0;
    let D = (physical ? def.stats.def : def.stats.spd) * stageMult(defStage);
    if (!physical && w === "sand" && def.types.includes("rock")) D *= 1.5;
    if (physical && w === "snow" && def.types.includes("ice")) D *= 1.5;
    if (physical && def.status && this.has(def, "MARVEL_SCALE", att)) D *= 1.5;
    if (physical && this.has(def, "FUR_COAT", att)) D *= 2;
    if (physical && this.field.terrain === "grassy" && this.has(def, "GRASS_PELT", att)) D *= 1.5;
    D *= this.paradoxMult(def, physical ? "def" : "spd");

    const base = Math.floor(Math.floor((Math.floor((2 * att.level) / 5 + 2) * power * A) / Math.max(1, D)) / 50) + 2;

    let m = 1;
    if (opts.spread) m *= 0.75;
    const umbrella = count(att, "UTILITY_UMBRELLA") + count(def, "UTILITY_UMBRELLA") > 0;
    if (w === "sun" && !umbrella) m *= type === "fire" ? 1.5 : type === "water" ? 0.5 : 1;
    if (w === "rain" && !umbrella) m *= type === "water" ? 1.5 : type === "fire" ? 0.5 : 1;
    if (opts.crit) m *= att.ability === "SNIPER" ? 2.25 : 1.5;
    m *= (opts.roll ?? this.rng.int(85, 100)) / 100;
    m *= this.stab(att, type);
    m *= opts.eff;
    if (physical && att.status === "brn" && att.ability !== "GUTS" && !move.effects.some((e) => e.kind === "facade")) m *= 0.5;
    const screens = this.sides[def.side].screens;
    if (!opts.crit && att.ability !== "INFILTRATOR" && def.side !== att.side) {
      if (screens.auroraVeil > 0 || (physical ? screens.reflect > 0 : screens.lightScreen > 0)) m *= 2 / 3;
    }
    m *= att.items.typeBoost.get(type) ?? 1;
    m *= att.moveTypeMult.get(type) ?? 1;
    m *= stackMul(1.3, count(att, "LIFE_ORB"));
    m *= stackMul(1.1, count(att, physical ? "MUSCLE_BAND" : "WISE_GLASSES"));
    if (move.flags.includes("punch")) m *= stackMul(1.1, count(att, "PUNCHING_GLOVE"));
    const metronome = count(att, "METRONOME");
    if (metronome > 0 && att.streak > 1) m *= Math.min(2, 1 + 0.2 * metronome * (att.streak - 1));
    const resist = RESIST_BERRY_BY_TYPE.get(type);
    if (resist && def !== att && (def.items.uses.get(resist) ?? 0) > 0 && (opts.eff > 1 || resist === "CHILAN_BERRY")) {
      m *= 0.5;
      if (!opts.estimate) this.consume(def, resist);
    }
    if (opts.eff > 1) m *= stackMul(1.2, count(att, "EXPERT_BELT"));
    if (typeConverted) m *= 1.2;
    const f = move.flags;
    if (att.ability === "IRON_FIST" && f.includes("punch")) m *= 1.2;
    if (att.ability === "STRONG_JAW" && f.includes("bite")) m *= 1.5;
    if (att.ability === "SHARPNESS" && f.includes("slice")) m *= 1.5;
    if (att.ability === "MEGA_LAUNCHER" && f.includes("pulse")) m *= 1.5;
    if (att.ability === "TOUGH_CLAWS" && move.contact) m *= 1.3;
    if (att.ability === "RECKLESS" && move.effects.some((e) => e.kind === "recoil")) m *= 1.2;
    if (att.ability === "STEELWORKER" && type === "steel") m *= 1.5;
    if (att.ability === "FIRE_MANE" && type === "fire") m *= 1.5;
    if (att.ability === "SAND_FORCE" && w === "sand" && (type === "rock" || type === "ground" || type === "steel")) m *= 1.3;
    if (att.ability === "TINTED_LENS" && opts.eff < 1) m *= 2;
    if (att.ability === "SHEER_FORCE" && move.effects.some((e) => SECONDARY_KINDS.has(e.kind) || (e.kind === "stages" && e.target === "target"))) m *= 1.3;
    if (att.ability === "SUPREME_OVERLORD") m *= 1 + 0.1 * Math.min(5, this.sides[att.side].fainted);
    if (att.ability === "ANALYTIC" && this.effSpeed(def) > this.effSpeed(att)) m *= 1.3;
    if (att.ability === "RIVALRY" && def.types.some((t) => att.types.includes(t))) m *= 1.25;
    if (att.ability === "PUNK_ROCK" && f.includes("sound")) m *= 1.3;
    if (!physical && this.adjacentAllies(att).some((a) => a.ability === "BATTERY")) m *= 1.3;
    if ((type === "fairy" && this.auraActive("FAIRY_AURA")) || (type === "dark" && this.auraActive("DARK_AURA"))) m *= 4 / 3;
    if (f.includes("sound") && this.has(def, "PUNK_ROCK", att)) m *= 0.5;
    if (!physical && this.has(def, "ICE_SCALES", att)) m *= 0.5;
    if (physical && this.has(def, "HEAVY_METAL", att)) m *= 0.9;
    if (def.hp === def.maxHp && (this.has(def, "MULTISCALE", att) || this.has(def, "SHADOW_SHIELD", att))) m *= 0.5;
    if (opts.eff > 1 && (this.has(def, "FILTER", att) || this.has(def, "SOLID_ROCK", att) || this.has(def, "PRISM_ARMOR", att))) m *= 0.75;
    if ((type === "fire" || type === "ice") && this.has(def, "THICK_FAT", att)) m *= 0.5;
    if (type === "fire" && this.has(def, "HEATPROOF", att)) m *= 0.5;
    if (type === "fire" && this.has(def, "DRY_SKIN", att)) m *= 1.25;
    if (type === "ghost" && this.has(def, "PURIFYING_SALT", att)) m *= 0.5;
    if (this.has(def, "FLUFFY", att)) {
      if (move.contact && att.ability !== "LONG_REACH") m *= 0.5;
      if (type === "fire") m *= 2;
    }
    const t = this.field.terrain;
    if (t && isGrounded(att)) {
      if ((t === "electric" && type === "electric") || (t === "grassy" && type === "grass") || (t === "psychic" && type === "psychic")) m *= 1.3;
    }
    if (t === "misty" && type === "dragon" && isGrounded(def)) m *= 0.5;
    m *= def.damageTakenMult;
    if (this.sides[def.side].subclass === "kukui_royal" && def.side !== att.side) {
      // Royal Mask: hit once by a type, researched; the rest of the battle that type hurts less.
      if (def.researched.has(type)) m *= 1 - CHAMPION_RULES.kukui.royalResearchReduction;
      else if (!opts.estimate) def.researched.add(type);
    }
    if (move.variant === "gmax" && this.sides[att.side].subclass === "leon_gmax") m *= 1 + CHAMPION_RULES.leon.gmaxPowerBonus;
    if (move.baseKey === "HYPER_BEAM" && this.sides[att.side].subclass === "lance_hyperbeam") m *= 1 + CHAMPION_RULES.lance.hyperBeamPowerBonus;
    if (att.tera === "stellar" && !att.stellarUsed.has(type)) {
      m *= CHAMPION_RULES.geeta.stellarMultiplier;
      if (!opts.estimate) att.stellarUsed.add(type);
    }
    return Math.max(1, Math.floor(base * m));
  }

  private auraActive(ability: "FAIRY_AURA" | "DARK_AURA"): boolean {
    return this.battlers.some((b) => b.alive && b.ability === ability);
  }

  stab(att: Battler, type: TypeKey): number {
    const adapt = att.ability === "ADAPTABILITY";
    if (att.tera && att.tera !== "stellar") {
      if (type === att.tera) return att.originalTypes.includes(type) ? 2 : adapt ? 2 : 1.5;
      if (att.originalTypes.includes(type)) return 1.5;
      return 1;
    }
    if (att.types.includes(type)) return adapt ? 2 : 1.5;
    return 1;
  }

  effectChance(att: Battler, chance: number): number {
    const c = att.ability === "SERENE_GRACE" ? chance * 2 : chance;
    return Math.min(100, c) / 100;
  }

  private secondaryEffects(att: Battler, def: Battler, move: MoveDef): void {
    for (const e of move.effects) {
      switch (e.kind) {
        case "status":
          if (!e.self && this.rng.chance(this.effectChance(att, e.chance))) this.applyStatus(def, e.status, att);
          break;
        case "randomStatus":
          if (this.rng.chance(this.effectChance(att, e.chance))) this.applyStatus(def, this.rng.pick(e.options), att);
          break;
        case "confuse":
          if (!e.self && this.rng.chance(this.effectChance(att, e.chance))) this.applyConfusion(def);
          break;
        case "flinch":
          if (this.rng.chance(this.effectChance(att, e.chance))) this.flinch(def);
          break;
        case "stages":
          if (e.target === "target" && this.rng.chance(this.effectChance(att, e.chance))) this.changeStages(def, e.stats, e.delta, att);
          break;
      }
    }
  }

  private contactEffects(att: Battler, def: Battler, move: MoveDef): void {
    if (!move.contact) return;
    if (count(att, "PROTECTIVE_PADS") > 0) return;
    if (move.flags.includes("punch") && count(att, "PUNCHING_GLOVE") > 0) return;
    if ((def.ability === "ROUGH_SKIN" || def.ability === "IRON_BARBS") && att.ability !== "MAGIC_GUARD") {
      this.emit({ k: "ability", src: def.id, ability: def.ability });
      this.damage(att, Math.max(1, Math.floor(att.maxHp / 8)), "contact", def.id);
    }
    const helmets = count(def, "ROCKY_HELMET");
    if (helmets > 0 && att.alive && att.ability !== "MAGIC_GUARD") {
      this.emit({ k: "item", src: def.id, item: "ROCKY_HELMET" });
      this.damage(att, Math.max(1, Math.floor((att.maxHp * helmets) / 6)), "helmet", def.id);
    }
    if (!att.alive) return;
    if (def.ability === "GOOEY") {
      this.emit({ k: "ability", src: def.id, ability: def.ability });
      this.changeStages(att, ["spe"], -1, def);
    }
    if (def.ability === "PICKPOCKET") this.steal(def, att);
    const proc = this.rng.chance(0.3);
    if (!proc) return;
    if (def.ability === "CUTE_CHARM") {
      if (att.ability === "OBLIVIOUS" || this.aromaVeiled(att)) return;
      this.emit({ k: "ability", src: def.id, ability: def.ability });
      this.loseGauge(att, CUTE_CHARM_GAUGE);
      return;
    }
    const byAbility: Record<string, StatusKey | "spore"> = {
      STATIC: "par",
      FLAME_BODY: "brn",
      POISON_POINT: "psn",
      EFFECT_SPORE: "spore",
    };
    const s = byAbility[def.ability];
    if (!s) return;
    if (s === "spore") {
      if (att.types.includes("grass") || att.ability === "OVERCOAT") return;
      this.emit({ k: "ability", src: def.id, ability: def.ability });
      this.applyStatus(att, this.rng.pick(["psn", "par", "slp"] as const), def);
      return;
    }
    this.emit({ k: "ability", src: def.id, ability: def.ability });
    this.applyStatus(att, s, def);
  }

  private onHitTaken(def: Battler, att: Battler, move: MoveDef, type: TypeKey, eff: number): void {
    if (!def.alive) return;
    if ((def.items.uses.get("AIR_BALLOON") ?? 0) > 0) this.consume(def, "AIR_BALLOON");
    if (eff > 1 && this.useOnce(def, "WEAKNESS_POLICY")) this.changeStages(def, ["atk", "spa"], 2);
    if (eff > 1 && this.useOnce(def, "ENIGMA_BERRY")) this.heal(def, Math.floor(def.maxHp / 4), "berry");
    if (type === "water" && this.useOnce(def, "ABSORB_BULB")) this.changeStages(def, ["spa"], 1);
    if (type === "electric" && this.useOnce(def, "CELL_BATTERY")) this.changeStages(def, ["atk"], 1);
    const retaliate = move.category === "physical" ? "JABOCA_BERRY" : move.category === "special" ? "ROWAP_BERRY" : null;
    if (retaliate && att.alive && att !== def && this.useOnce(def, retaliate)) {
      this.damage(att, Math.max(1, Math.floor(att.maxHp / 8)), "item", def.id);
    }
    switch (def.ability) {
      case "JUSTIFIED":
        if (type === "dark") this.changeStages(def, ["atk"], 1);
        break;
      case "RATTLED":
        if (type === "bug" || type === "ghost" || type === "dark") this.changeStages(def, ["spe"], 1);
        break;
      case "STAMINA":
        this.changeStages(def, ["def"], 1);
        break;
      case "SPICY_SPRAY":
        if (att.alive && att !== def) {
          this.emit({ k: "ability", src: def.id, ability: def.ability });
          this.applyStatus(att, "brn", def);
        }
        break;
      case "WEAK_ARMOR":
        if (move.category === "physical") {
          this.changeStages(def, ["def"], -1);
          this.changeStages(def, ["spe"], 2);
        }
        break;
      case "TOXIC_DEBRIS":
        if (move.category === "physical" && att.alive) {
          this.emit({ k: "ability", src: def.id, ability: def.ability });
          this.applyStatus(att, "psn", def);
        }
        break;
      case "THERMAL_EXCHANGE":
        if (type === "fire") {
          this.emit({ k: "ability", src: def.id, ability: def.ability });
          this.changeStages(def, ["atk"], 1);
        }
        break;
      case "CURSED_BODY": {
        const key = (move as ResolvedMove).baseKey ?? move.key;
        const sealed = att.disabledMove !== null && att.disabledMove.until > this.tick;
        if (att.alive && att !== def && !sealed && !this.aromaVeiled(att) && this.rng.chance(0.3)) {
          this.emit({ k: "ability", src: def.id, ability: def.ability });
          att.disabledMove = { key, until: this.tick + CURSED_BODY_TICKS };
        }
        break;
      }
    }
    this.checkThresholds(def);
  }

  /** Berries, Berserk and Diantha's mega trigger when HP crosses a threshold. */
  private checkThresholds(b: Battler): void {
    if (!b.alive) return;
    const unnerved = this.enemiesOf(b).some((e) => e.ability === "UNNERVE");
    const ratio = b.hp / b.maxHp;
    const gluttony = b.ability === "GLUTTONY";
    if (!unnerved && ratio <= 0.5 && (b.items.uses.get("SITRUS_BERRY") ?? 0) > 0) {
      this.consume(b, "SITRUS_BERRY");
      this.heal(b, Math.floor(b.maxHp / 4), "berry");
    }
    if (!unnerved && ratio <= 0.5 && this.useOnce(b, "ORAN_BERRY")) this.heal(b, Math.floor(b.maxHp / 8), "berry");
    const pinchAt = gluttony ? 0.5 : 0.25;
    if (!unnerved && ratio <= pinchAt && this.useOnce(b, "LANSAT_BERRY")) b.critStage += 2;
    if (!unnerved && ratio <= pinchAt && this.useOnce(b, "STARF_BERRY")) {
      this.changeStages(b, [this.rng.pick(["atk", "def", "spa", "spd", "spe"] as const)], 2);
    }
    for (const [berry, stat] of Object.entries(PINCH_BERRIES)) {
      if (!unnerved && ratio <= (gluttony ? 0.5 : 0.25) && (b.items.uses.get(berry) ?? 0) > 0) {
        this.consume(b, berry);
        this.changeStages(b, [stat], 1);
      }
    }
    if (b.ability === "RUN_AWAY" && b.hp * 3 <= b.maxHp && !b.spent.has("RUN_AWAY")) {
      b.spent.add("RUN_AWAY");
      this.emit({ k: "ability", src: b.id, ability: b.ability });
      this.changeStages(b, ["spe", "eva"], 1);
    }
    if (b.ability === "BERSERK" && ratio <= 0.5 && !b.items.uses.get("__berserk")) {
      b.items.uses.set("__berserk", 1);
      this.emit({ k: "ability", src: b.id, ability: b.ability });
      this.changeStages(b, ["spa"], 1);
    }
    const side = this.sides[b.side];
    if (side.champion === "diantha" && ratio <= CHAMPION_RULES.diantha.megaThreshold && b.items.megaForm) this.megaEvolve(b);
  }

  /** Uses a one-shot item if one is left; returns whether it fired. */
  private useOnce(b: Battler, item: string): boolean {
    if ((b.items.uses.get(item) ?? 0) <= 0) return false;
    this.consume(b, item);
    return true;
  }

  private consume(b: Battler, item: string): void {
    // Copies off the pouch go first, so the pouch only rolls once every other copy is spent.
    const left = b.items.uses.get(item) ?? 1;
    const pouched = b.items.pouched.get(item) ?? 0;
    const pouchSaves = pouched > 0 && left <= pouched && this.rng.chance(BERRY_POUCH_SAVE_CHANCE);
    if (!pouchSaves) b.items.uses.set(item, left - 1);
    b.items.uses.set("__consumed", (b.items.uses.get("__consumed") ?? 0) + 1);
    this.emit({ k: "item", src: b.id, item });
    // Cheek Pouch: every berry eaten also restores a third of max HP.
    if (b.ability === "CHEEK_POUCH" && b.alive && ITEMS[item]?.family === "berry") {
      this.emit({ k: "ability", src: b.id, ability: "CHEEK_POUCH" });
      this.heal(b, Math.floor(b.maxHp / 3), "ability");
    }
  }

  private onKo(att: Battler, def: Battler): void {
    if (!att.alive || att === def || att.side === def.side) return;
    // Legendaries snowball: each knockout raises their better attacking stat a stage, a few times per battle.
    if (att.legendBoosts < LEGEND_KO_BOOSTS && getSpecies(att.piece.species).tier === 5) {
      att.legendBoosts++;
      this.emit({ k: "ability", src: att.id, ability: LEGEND_AURA });
      this.changeStages(att, [att.stats.atk >= att.stats.spa ? "atk" : "spa"], 1);
    }
    if (att.ability === "MOXIE" || att.ability === "CHILLING_NEIGH") {
      this.emit({ k: "ability", src: att.id, ability: att.ability });
      this.changeStages(att, ["atk"], 1);
    }
    if (att.ability === "GRIM_NEIGH") {
      this.emit({ k: "ability", src: att.id, ability: att.ability });
      this.changeStages(att, ["spa"], 1);
    }
    if (att.ability === "BEAST_BOOST") {
      const s = att.stats;
      const best = (["atk", "def", "spa", "spd", "spe"] as const).reduce((a, k) => (s[k] > s[a] ? k : a), "atk" as const);
      this.emit({ k: "ability", src: att.id, ability: att.ability });
      this.changeStages(att, [best], 1);
    }
  }

  private statusMove(att: Battler, move: ResolvedMove, targets: Battler[]): void {
    for (const e of move.effects) {
      switch (e.kind) {
        case "stages": {
          if (e.target === "self") this.changeStages(att, e.stats, e.delta);
          else if (e.target === "allies") for (const a of this.alliesOf(att, true)) this.changeStages(a, e.stats, e.delta);
          else for (const t of this.statusTargets(att, move, targets)) this.changeStages(t, e.stats, e.delta, att);
          break;
        }
        case "status":
          for (const t of this.statusTargets(att, move, targets)) {
            if (move.type === "electric" && t.types.includes("ground")) {
              this.emit({ k: "immune", src: att.id, target: t.id });
              continue;
            }
            if (move.flags.includes("powder") && (t.types.includes("grass") || t.ability === "OVERCOAT" || count(t, "SAFETY_GOGGLES") > 0)) {
              this.emit({ k: "immune", src: att.id, target: t.id });
              continue;
            }
            this.applyStatus(t, e.status, att);
          }
          break;
        case "confuse":
          for (const t of this.statusTargets(att, move, targets)) this.applyConfusion(t);
          break;
        case "heal": {
          let ratio = e.ratio;
          if (e.weatherScaled) {
            const w = this.moveWeather(att);
            ratio = w === "sun" ? 2 / 3 : w ? 1 / 4 : 1 / 2;
          }
          // Life Dew heals the user and every ally on its side.
          const who = move.target === "ally" ? [targets[0] ?? att] : move.target === "allySide" ? this.alliesOf(att, true) : [att];
          for (const w of who) this.heal(w, Math.floor(w.maxHp * ratio), "move");
          break;
        }
        case "rest":
          if (att.hp < att.maxHp) {
            this.heal(att, att.maxHp - att.hp, "move");
            att.status = null;
            att.poisonStacks = 0;
            att.status = "slp";
            att.sleepTurns = 3;
            this.emit({ k: "status", target: att.id, status: "slp" });
          }
          break;
        case "weather":
          this.setWeather(e.weather, att);
          break;
        case "terrain":
          this.setTerrain(e.terrain, att);
          break;
        case "protect": {
          let chance = 1;
          for (let i = 0; i < att.protectChain; i++) chance /= 3;
          if (this.rng.chance(chance)) {
            att.protectUntil = this.tick + 10;
            att.protectChain++;
            if (att.stance === "blade") this.switchStance(att, "shield");
          } else {
            att.protectChain = 0;
          }
          break;
        }
        case "transform": {
          const t = this.frontTarget(att, this.enemiesOf(att));
          if (t) this.transform(att, t);
          break;
        }
        case "leechSeed":
          for (const t of this.statusTargets(att, move, targets)) {
            if (t.types.includes("grass") || t.leechSeedBy !== null) continue;
            t.leechSeedBy = att.id;
          }
          break;
        case "focusEnergy":
          att.critStage += 2;
          break;
        case "bellyDrum":
          if (att.hp * 2 > att.maxHp) {
            this.damage(att, Math.floor(att.maxHp / 2), "move");
            this.changeStages(att, ["atk"], 12);
          }
          break;
        case "haze":
          for (const b of this.living()) b.stages = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, acc: 0, eva: 0 };
          break;
        case "screen":
          this.sides[att.side].screens[e.screen] = count(att, "LIGHT_CLAY") > 0 ? 8 : 5;
          break;
        case "tailwind":
          this.sides[att.side].tailwind = 4;
          break;
        case "cureTeam":
          for (const a of this.alliesOf(att, true)) if (a.status) this.cure(a, false);
          break;
        default:
          break;
      }
    }
  }

  /** Enemy targets of a status move after accuracy, protection, Magic Bounce and Good as Gold. */
  private statusTargets(att: Battler, move: MoveDef, targets: Battler[]): Battler[] {
    const out: Battler[] = [];
    for (const t of targets) {
      if (t.side === att.side) {
        out.push(t);
        continue;
      }
      if (t.protectUntil >= this.tick) {
        this.emit({ k: "protect", target: t.id });
        continue;
      }
      if (this.has(t, "GOOD_AS_GOLD", att)) {
        this.emit({ k: "ability", src: t.id, ability: t.ability });
        continue;
      }
      if (this.has(t, "MAGIC_BOUNCE", att)) {
        this.emit({ k: "ability", src: t.id, ability: t.ability });
        out.push(att);
        continue;
      }
      if (!this.hitCheck(att, t, move)) {
        this.emit({ k: "miss", src: att.id, target: t.id });
        continue;
      }
      out.push(t);
    }
    return out;
  }

  // ───────────────────────────── state changes

  damage(b: Battler, amount: number, cause: DamageCause, src?: number, meta?: { crit?: boolean; eff?: number }): number {
    if (!b.alive || amount <= 0) return 0;
    let dmg = Math.floor(amount);
    if (cause === "move" && b.hp === b.maxHp && dmg >= b.hp) {
      const attacker = src !== undefined ? this.battlers[src] : undefined;
      if (this.has(b, "STURDY", attacker)) {
        dmg = b.hp - 1;
        this.emit({ k: "ability", src: b.id, ability: "STURDY" });
      } else if ((b.items.uses.get("FOCUS_SASH") ?? 0) > 0) {
        dmg = b.hp - 1;
        this.consume(b, "FOCUS_SASH");
      }
    }
    const band = count(b, "FOCUS_BAND");
    if (cause === "move" && band > 0 && dmg >= b.hp && b.hp > 1 && this.rng.chance(1 - stackMul(0.9, band))) {
      dmg = b.hp - 1;
      this.emit({ k: "item", src: b.id, item: "FOCUS_BAND" });
    }
    dmg = Math.min(dmg, b.hp);
    if (dmg <= 0) return 0;
    b.hp -= dmg;
    this.emit({
      k: "damage",
      target: b.id,
      amount: dmg,
      hp: b.hp,
      cause,
      ...(src !== undefined ? { src } : {}),
      ...(meta?.crit ? { crit: true } : {}),
      ...(meta?.eff !== undefined && meta.eff !== 1 ? { eff: meta.eff } : {}),
    });
    if (b.hp <= 0) this.faint(b);
    else if (cause !== "move") this.checkThresholds(b);
    return dmg;
  }

  heal(b: Battler, amount: number, cause: HealCause): number {
    if (!b.alive || amount <= 0 || b.hp >= b.maxHp) return 0;
    const healed = Math.min(Math.floor(amount), b.maxHp - b.hp);
    if (healed <= 0) return 0;
    b.hp += healed;
    this.emit({ k: "heal", target: b.id, amount: healed, hp: b.hp, cause });
    return healed;
  }

  private faint(b: Battler): void {
    b.alive = false;
    b.hp = 0;
    b.gauge = 0;
    this.emit({ k: "faint", target: b.id });
    const side = this.sides[b.side];
    side.fainted++;
    if (side.champion === "lance" && isLanceKin(b.types)) {
      for (const a of this.adjacentAllies(b)) if (isLanceKin(a.types)) this.changeStages(a, ["atk", "spa"], 1);
    }
    if (!side.firstFaintDone) {
      side.firstFaintDone = true;
      if (side.subclass === "alder_legion") for (const a of this.alliesOf(b)) this.changeStages(a, ["atk"], 1);
    }
    for (const o of this.battlers) if (o.leechSeedBy === b.id) o.leechSeedBy = null;
    if (this.field.primal?.src === b.id) {
      const kind = this.field.primal.kind;
      this.field.primal = null;
      if (kind !== "wind" && this.field.weather === kind) {
        this.field.weather = null;
        this.emit({ k: "weather", weather: null });
      }
    }
  }

  /** Type, ability and field immunities to a new status (not whether one is already there). */
  private canHaveStatus(b: Battler, status: StatusKey, src?: Battler): boolean {
    const fromFoe = src && src.side !== b.side ? src : undefined;
    const corrosion = src?.ability === "CORROSION";
    const ab = (k: string) => this.has(b, k, fromFoe);
    const w = this.weather();
    const t = this.field.terrain;
    if (ab("PURIFYING_SALT") || ab("COMATOSE")) return false;
    if (ab("LEAF_GUARD") && w === "sun") return false;
    if (t === "misty" && isGrounded(b)) return false;
    switch (status) {
      case "brn":
        return !(b.types.includes("fire") || ab("WATER_VEIL") || ab("WATER_BUBBLE") || ab("THERMAL_EXCHANGE"));
      case "par":
        return !(b.types.includes("electric") || ab("LIMBER"));
      case "psn":
      case "tox":
        return !((!corrosion && (b.types.includes("poison") || b.types.includes("steel"))) || ab("IMMUNITY") || ab("PASTEL_VEIL"));
      case "slp":
        return !(ab("INSOMNIA") || ab("VITAL_SPIRIT") || ab("SWEET_VEIL") || (t === "electric" && isGrounded(b)));
      case "frz":
        return !(b.types.includes("ice") || ab("MAGMA_ARMOR") || w === "sun");
    }
    return true;
  }

  applyStatus(b: Battler, status: StatusKey, src?: Battler): boolean {
    if (!b.alive) return false;
    const fromFoe = src && src.side !== b.side ? src : undefined;
    const isPoison = status === "psn" || status === "tox";
    if (isPoison && (b.status === "psn" || b.status === "tox")) {
      b.poisonStacks = Math.min(8, b.poisonStacks + (status === "tox" ? 2 : 1));
      if (status === "tox") b.status = "tox";
      this.emit({ k: "status", target: b.id, status: b.status, stacks: b.poisonStacks });
      return true;
    }
    if (b.status || !this.canHaveStatus(b, status, src)) return false;
    b.status = status;
    if (status === "slp") b.sleepTurns = this.rng.int(1, 3) + 1;
    if (isPoison) b.poisonStacks = status === "tox" ? 2 : 1;
    this.emit({ k: "status", target: b.id, status, ...(isPoison ? { stacks: b.poisonStacks } : {}) });
    if (b.ability === "SYNCHRONIZE" && fromFoe && status !== "slp" && status !== "frz") {
      this.emit({ k: "ability", src: b.id, ability: b.ability });
      this.applyStatus(fromFoe, status, b);
    }
    if ((b.items.uses.get("LUM_BERRY") ?? 0) > 0) {
      this.consume(b, "LUM_BERRY");
      this.cure(b, false);
    }
    return true;
  }

  applyConfusion(b: Battler): boolean {
    if (!b.alive || b.confusion > 0 || b.ability === "OWN_TEMPO") return false;
    if (this.aromaVeiled(b)) return false;
    if (this.field.terrain === "misty" && isGrounded(b)) return false;
    b.confusion = this.rng.int(2, 5);
    this.emit({ k: "confuse", target: b.id });
    if (this.useOnce(b, "MENTAL_HERB")) {
      b.confusion = 0;
      this.emit({ k: "cure", target: b.id });
      return true;
    }
    if ((b.items.uses.get("LUM_BERRY") ?? 0) > 0) {
      this.consume(b, "LUM_BERRY");
      b.confusion = 0;
      this.emit({ k: "cure", target: b.id });
    }
    return true;
  }

  cure(b: Battler, byAbility: boolean): void {
    if (!b.status) return;
    if (byAbility) this.emit({ k: "ability", src: b.id, ability: b.ability });
    b.status = null;
    b.poisonStacks = 0;
    b.sleepTurns = 0;
    this.emit({ k: "cure", target: b.id });
  }

  flinch(b: Battler): void {
    if (!b.alive || b.dynamax) return;
    if (b.ability === "INNER_FOCUS") return;
    if (!this.loseGauge(b, 400)) return;
    this.emit({ k: "flinch", target: b.id });
    if (b.ability === "STEADFAST") this.changeStages(b, ["spe"], 1);
  }

  changeStages(b: Battler, stats: readonly StageStat[], delta: number, src?: Battler): void {
    if (!b.alive) return;
    let d = delta;
    if (b.ability === "SIMPLE") d *= 2;
    if (b.ability === "CONTRARY") d = -d;
    const byFoe = !!src && src.side !== b.side;
    if (d < 0 && byFoe && src && !this.mirroring && this.has(b, "MIRROR_ARMOR", src)) {
      // Bounces the drop back at whoever caused it; a bounced drop is not bounced again.
      this.emit({ k: "ability", src: b.id, ability: b.ability });
      this.mirroring = true;
      this.changeStages(src, stats, delta, b);
      this.mirroring = false;
      return;
    }
    if (d < 0 && byFoe) {
      if (this.has(b, "CLEAR_BODY", src) || this.has(b, "WHITE_SMOKE", src) || this.has(b, "FULL_METAL_BODY", src)) {
        this.emit({ k: "ability", src: b.id, ability: b.ability });
        return;
      }
      if (count(b, "CLEAR_AMULET") > 0) {
        this.emit({ k: "item", src: b.id, item: "CLEAR_AMULET" });
        return;
      }
    }
    let lowered = false;
    const raised: [StageStat, number][] = [];
    for (const stat of stats) {
      if (d < 0 && byFoe) {
        if ((stat === "atk" && this.has(b, "HYPER_CUTTER", src)) || (stat === "acc" && this.has(b, "KEEN_EYE", src)) || (stat === "def" && this.has(b, "BIG_PECKS", src))) {
          continue;
        }
      }
      const before = b.stages[stat];
      const after = Math.max(-6, Math.min(6, before + d));
      if (after === before) continue;
      b.stages[stat] = after;
      this.emit({ k: "stage", target: b.id, stat, delta: after - before });
      if (after < before) lowered = true;
      else raised.push([stat, after - before]);
    }
    if (raised.length > 0 && !this.copyingBoosts) {
      this.copyingBoosts = true;
      for (const o of this.enemiesOf(b)) {
        if (o.ability !== "OPPORTUNIST") continue;
        this.emit({ k: "ability", src: o.id, ability: o.ability });
        for (const [stat, n] of raised) this.changeStages(o, [stat], n);
      }
      this.copyingBoosts = false;
    }
    if (lowered && (b.items.uses.get("WHITE_HERB") ?? 0) > 0) {
      this.consume(b, "WHITE_HERB");
      for (const stat of ["atk", "def", "spa", "spd", "spe", "acc", "eva"] as const) {
        if (b.stages[stat] < 0) {
          this.emit({ k: "stage", target: b.id, stat, delta: -b.stages[stat] });
          b.stages[stat] = 0;
        }
      }
    }
    if (lowered && byFoe) {
      if (b.ability === "DEFIANT") this.changeStages(b, ["atk"], 2);
      if (b.ability === "COMPETITIVE") this.changeStages(b, ["spa"], 2);
    }
  }

  setWeather(w: Weather, src?: Battler): void {
    if (this.field.primal) return;
    const rock = src ? count(src, WEATHER_ROCK[w]) : 0;
    this.field.weather = w;
    this.field.weatherPulses = rock > 0 ? 8 : 5;
    this.emit({ k: "weather", weather: w });
    this.announceParadox();
  }

  setTerrain(t: Terrain, src?: Battler): void {
    this.field.terrain = t;
    this.field.terrainPulses = src && count(src, "TERRAIN_EXTENDER") > 0 ? 8 : 5;
    this.emit({ k: "terrain", terrain: t });
    this.announceParadox();
    const [seed, stat] = TERRAIN_SEED[t];
    for (const b of this.living()) if (this.useOnce(b, seed)) this.changeStages(b, [stat], 1);
  }

  // ───────────────────────────── gimmicks and forms

  private emitForm(b: Battler, form: Extract<BattleEvent, { k: "form" }>["form"]): void {
    this.emit({
      k: "form",
      target: b.id,
      form,
      species: b.species.key,
      formKey: b.formKey,
      types: [...b.types],
      maxHp: b.maxHp,
      hp: b.hp,
      ...(b.tera ? { tera: b.tera } : {}),
    });
  }

  /** Rescales stats to new base stats while keeping every static multiplier. */
  private rebase(b: Battler, from: Stats, to: Stats): void {
    const p = b.piece;
    const oldRaw = calcStats(from, p.ivs, p.level, p.nature);
    const newRaw = calcStats(to, p.ivs, p.level, p.nature);
    for (const k of ["atk", "def", "spa", "spd", "spe"] as const) {
      b.stats[k] = oldRaw[k] > 0 ? (b.stats[k] * newRaw[k]) / oldRaw[k] : newRaw[k];
    }
  }

  megaEvolve(b: Battler): void {
    const side = this.sides[b.side];
    if (!b.alive || b.megaDone || side.megasLeft <= 0 || !b.items.megaForm || b.dynamax) return;
    const form = b.species.megaForms.find((f) => f.formKey === b.items.megaForm);
    if (!form) return;
    side.megasLeft--;
    b.megaDone = true;
    b.isMega = true;
    this.rebase(b, b.species.baseStats, form.baseStats);
    b.originalTypes = [...form.types];
    if (!b.tera || b.tera === "stellar") b.types = [...form.types];
    if (form.ability) b.ability = form.ability;
    b.formKey = form.formKey;
    if (side.subclass === "diantha_beauty") b.damageTakenMult *= CHAMPION_RULES.diantha.beautyMegaDamageTaken;
    this.emitForm(b, "mega");
    if (side.champion === "diantha") this.heal(b, Math.floor(b.maxHp * CHAMPION_RULES.diantha.megaHealRatio), "mega");
    if (this.started) this.startAbility(b);
  }

  private dynamax(b: Battler): void {
    const gmax = !!b.species.gmax;
    const mult = count(b, "DYNAMAX_CANDY") > 0 ? CHAMPION_RULES.leon.dynamaxCandyHpMultiplier : CHAMPION_RULES.leon.dynamaxHpMultiplier;
    const side = this.sides[b.side];
    b.dynamax = {
      actionsLeft: gmax && side.subclass === "leon_gmax" ? CHAMPION_RULES.leon.gmaxActions : CHAMPION_RULES.leon.dynamaxActions,
      hpMult: mult,
      gmax,
      baseMaxHp: b.maxHp,
    };
    b.maxHp = Math.floor(b.maxHp * mult);
    b.hp = Math.floor(b.hp * mult);
    if (gmax && b.species.gmax) b.formKey = b.species.gmax.formKey;
    this.emitForm(b, gmax ? "gmax" : "dynamax");
    if (count(b, "MAX_MUSHROOMS") > 0) {
      this.emit({ k: "item", src: b.id, item: "MAX_MUSHROOMS" });
      this.changeStages(b, ["atk", "def", "spa", "spd", "spe"], 1);
    }
  }

  private undynamax(b: Battler): void {
    if (!b.dynamax) return;
    const { baseMaxHp } = b.dynamax;
    b.hp = Math.max(1, Math.round((b.hp * baseMaxHp) / b.maxHp));
    b.maxHp = baseMaxHp;
    b.dynamax = null;
    b.formKey = b.isMega ? b.formKey : b.species.spriteForm;
    this.emitForm(b, "undynamax");
  }

  private maxMoveEffect(att: Battler, move: ResolvedMove, type: TypeKey): void {
    if (move.variant === "gmax" && att.species.gmax) {
      const foes = this.enemiesOf(att);
      switch (move.key) {
        case "G_MAX_WILDFIRE":
        case "G_MAX_VINE_LASH":
        case "G_MAX_CANNONADE":
          this.sides[att.side].gmaxResidual = { pulses: 4, spare: type };
          return;
        case "G_MAX_VOLT_CRASH":
          for (const f of foes) this.applyStatus(f, "par", att);
          return;
        case "G_MAX_BEFUDDLE":
          for (const f of foes) this.applyStatus(f, this.rng.pick(["psn", "par", "slp"] as const), att);
          return;
        case "G_MAX_GOLD_RUSH":
          for (const f of foes) this.applyConfusion(f);
          this.sides[att.side].gold += 2;
          return;
        case "G_MAX_CHI_STRIKE":
          for (const a of this.alliesOf(att, true)) a.critStage += 1;
          return;
        case "G_MAX_TERROR":
          for (const f of foes) this.loseGauge(f, 300);
          return;
        case "G_MAX_RESONANCE":
          this.sides[att.side].screens.auroraVeil = 5;
          return;
        case "G_MAX_CUDDLE":
          for (const f of foes) this.changeStages(f, ["atk"], -1, att);
          return;
        case "G_MAX_REPLENISH":
          for (const a of this.alliesOf(att, true)) {
            for (const [k, n] of a.items.counts) if (k.endsWith("_BERRY")) a.items.uses.set(k, n);
          }
          return;
      }
    }
    const fx = MAX_MOVE_EFFECT[type];
    if (fx.kind === "weather" && fx.weather) this.setWeather(fx.weather, att);
    else if (fx.kind === "terrain" && fx.terrain) this.setTerrain(fx.terrain, att);
    else if (fx.kind === "ally" && fx.stat) for (const a of this.alliesOf(att, true)) this.changeStages(a, [fx.stat], fx.delta ?? 1);
    else if (fx.kind === "foe" && fx.stat) for (const f of this.enemiesOf(att)) this.changeStages(f, [fx.stat], fx.delta ?? -1, att);
  }

  private switchStance(b: Battler, stance: "shield" | "blade"): void {
    if (b.stance === null || b.stance === stance || b.ability !== "STANCE_CHANGE") return;
    const blade = b.species.altForms.find((f) => f.formKey === "blade");
    if (!blade) return;
    const from = stance === "blade" ? b.species.baseStats : blade.baseStats;
    const to = stance === "blade" ? blade.baseStats : b.species.baseStats;
    this.rebase(b, from, to);
    b.stance = stance;
    b.formKey = stance === "blade" ? "blade" : b.species.spriteForm;
    this.emit({ k: "ability", src: b.id, ability: b.ability });
    this.emitForm(b, "stance");
  }

  private transform(b: Battler, target: Battler): void {
    b.transformedFrom = b.species.key;
    b.species = getSpecies(target.species.key);
    b.formKey = target.formKey;
    b.types = [...target.types];
    b.originalTypes = [...target.originalTypes];
    b.stats = { ...target.stats };
    b.stages = { ...target.stages };
    b.ability = target.ability;
    b.moves = target.moves.map((m) => ({ key: m.key, pp: 5, enabled: true }));
    this.emitForm(b, "transform");
  }
}

function struggleMove(): MoveDef {
  return {
    key: "STRUGGLE",
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
}
