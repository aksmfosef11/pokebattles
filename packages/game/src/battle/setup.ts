import { BAGS, COIN_CASE_EXTRA_GOLD, COIN_CASE_WIN_GOLD, poweredByBag } from "../board.ts";
import { CHAMPION_RULES, cynthiaBonusScale, earlyBonus } from "../content/champions.ts";
import { getMove, getSpecies, ITEMS } from "../content/index.ts";
import { type ItemFamily, PLATE_TYPE_BOOST, TIMED_ITEMS } from "../content/items.ts";
import { TYPES, type Stats, type TypeKey } from "../content/schema.ts";
import { CHOICE_BOOST, CHOICE_ITEMS, choicePicks } from "../run/choice.ts";
import { computeAdjacency, cellsOf } from "../run/layout.ts";
import { isLanceKinLine } from "../run/pool.ts";
import type { Piece, PokemonPiece, TeamSnapshot } from "../run/types.ts";
import { battleHpMultiplier, bondBonus, calcStats } from "../stats.ts";
import { stackMul } from "./calc.ts";
import { TICKS_PER_SECOND, type Battler, type BattleStats, type ItemBundle, type Side, type SideState, type TimedItemState } from "./types.ts";

const REGIS = new Set(["REGIROCK", "REGICE", "REGISTEEL"]);
const LEGEND_ORBS: Record<string, { species: string; types: TypeKey[] }> = {
  ADAMANT_ORB: { species: "DIALGA", types: ["steel", "dragon"] },
  LUSTROUS_ORB: { species: "PALKIA", types: ["water", "dragon"] },
  GRISEOUS_ORB: { species: "GIRATINA", types: ["ghost", "dragon"] },
};

/** Klutz ignores held items but still uses its champion gimmick items. */
const KLUTZ_KEEPS = new Set<ItemFamily>(["mega", "zCrystal", "tera", "dynamax"]);
const KLUTZ_STAT_BONUS = 1.15;

function emptyBundle(): ItemBundle {
  return {
    counts: new Map(),
    uses: new Map(),
    pouched: new Map(),
    typeBoost: new Map(),
    zTypes: new Set(),
    teraType: null,
    megaForm: null,
    megaAtStart: false,
    dynamaxBand: false,
  };
}

function isLegend(speciesKey: string): boolean {
  const s = getSpecies(speciesKey);
  return s.legendary || s.mythical || s.subLegendary;
}

/** Converts a team snapshot into battlers with every static (pre-battle) modifier applied. */
export function buildSide(team: TeamSnapshot, side: Side, firstId: number): { battlers: Battler[]; state: SideState } {
  const pieces: Record<string, Piece> = {};
  for (const p of team.pieces) if (p.place) pieces[p.uid] = p;
  const adj = computeAdjacency(pieces);
  const choice = choicePicks(pieces, adj);
  const mons = Object.values(pieces)
    .filter((p): p is PokemonPiece => p.kind === "pokemon")
    .sort((a, b) => a.place!.y - b.place!.y || a.place!.x - b.place!.x || (a.uid < b.uid ? -1 : 1));

  const teamTypes = mons.map((m) => getSpecies(m.species).types);
  const distinctTypes = new Set(teamTypes.flat());
  const typeUseCount = new Map<TypeKey, number>();
  for (const t of teamTypes.flat()) typeUseCount.set(t, (typeUseCount.get(t) ?? 0) + 1);
  const smallCount = mons.filter((m) => {
    const f = getSpecies(m.species).footprint;
    return f.w * f.h === 1;
  }).length;
  const legendCount = mons.filter((m) => isLegend(m.species)).length;
  const kanto = ["VENUSAUR", "CHARIZARD", "BLASTOISE"].every((k) => mons.some((m) => m.species === k));
  const placedTeraOrbs = team.pieces.filter((p) => p.place && p.kind === "item" && p.item === "TERA_ORB").length;

  const battlers: Battler[] = [];
  mons.forEach((piece, i) => {
    const species = getSpecies(piece.species);
    const items = emptyBundle();
    const klutz = piece.ability === "KLUTZ";
    for (const it of adj.itemsOf.get(piece.uid) ?? []) {
      const def = ITEMS[it.item];
      if (klutz && (!def || !KLUTZ_KEEPS.has(def.family))) continue;
      // A Choice item powers one of the Pokémon it touches.
      if (it.item in CHOICE_ITEMS && choice.holder.get(it.uid) !== piece.uid) continue;
      items.counts.set(it.item, (items.counts.get(it.item) ?? 0) + 1);
      if (!def) continue;
      if (def.family === "berry" || def.oneShot) items.uses.set(it.item, (items.uses.get(it.item) ?? 0) + 1);
      if (def.family === "berry" && poweredByBag(it.item, adj.bagUnder.get(it.uid))) {
        items.pouched.set(it.item, (items.pouched.get(it.item) ?? 0) + 1);
      }
      if (def.family === "typeBoost" && def.type) items.typeBoost.set(def.type, (items.typeBoost.get(def.type) ?? 1) + 0.2);
      if (def.family === "plate" && def.type) items.typeBoost.set(def.type, (items.typeBoost.get(def.type) ?? 1) + PLATE_TYPE_BOOST);
      if (def.family === "zCrystal" && def.type) {
        items.zTypes.add(def.type);
        const zBoost = team.subclass === "kukui_zmaster" ? CHAMPION_RULES.kukui.zMasterCrystalBoost : CHAMPION_RULES.kukui.zCrystalTypeBoost;
        items.typeBoost.set(def.type, (items.typeBoost.get(def.type) ?? 1) + zBoost);
      }
      if (it.item === "TERA_SHARD" && it.param && !items.teraType) items.teraType = it.param as TypeKey | "stellar";
      if (def.mega && def.mega.species === piece.species && !items.megaForm) items.megaForm = def.mega.formKey;
      if (it.item === "MEGA_BRACELET") items.megaAtStart = true;
      if (it.item === "DYNAMAX_BAND") items.dynamaxBand = true;
      if (it.item === "DRAGON_SCALE") items.typeBoost.set("dragon", (items.typeBoost.get("dragon") ?? 1) + 0.2);
      if (it.item === "SOUL_DEW") {
        for (const t of ["dragon", "psychic"] as TypeKey[]) items.typeBoost.set(t, (items.typeBoost.get(t) ?? 1) + 0.2);
      }
      const orb = LEGEND_ORBS[it.item];
      if (orb && orb.species === piece.species) {
        for (const t of orb.types) items.typeBoost.set(t, (items.typeBoost.get(t) ?? 1) + 0.2);
      }
    }

    const raw: Stats = calcStats(species.baseStats, piece.ivs, piece.level, piece.nature);
    // Multiplier on every stat including HP.
    let all = 1;
    if (piece.shiny) all *= 1.1;
    all *= 1 + bondBonus(piece.battles ?? 0);
    if (team.champion === "red" && team.ace === piece.uid) all *= 1 + piece.aceBonus;
    if (team.champion === "steven") all *= 1 + earlyBonus(CHAMPION_RULES.steven.earlyStatBonus, CHAMPION_RULES.steven.earlyStatPerRound, team.round);
    if (team.champion === "lance" && species.evolutions.length > 0 && isLanceKinLine(piece.species)) {
      all *= 1 + earlyBonus(CHAMPION_RULES.lance.youngKinStatBonus, CHAMPION_RULES.lance.youngKinPerRound, team.round);
    }
    if (team.champion === "alder" && species.evolutions.length > 0 && species.types.includes("bug")) {
      all *= 1 + earlyBonus(CHAMPION_RULES.alder.youngBugStatBonus, CHAMPION_RULES.alder.youngBugPerRound, team.round);
    }
    if (team.champion === "cynthia") {
      const per =
        team.subclass === "cynthia_diversity"
          ? CHAMPION_RULES.cynthia.diversityBonusUpgraded
          : CHAMPION_RULES.cynthia.typeDiversityBonus;
      const fade = cynthiaBonusScale(team.round);
      all *= 1 + fade * per * Math.min(distinctTypes.size, CHAMPION_RULES.cynthia.typeDiversityCap);
      if (team.subclass === "cynthia_diversity" && [...typeUseCount.values()].every((n) => n < 2)) {
        all *= 1 + fade * CHAMPION_RULES.cynthia.noDuplicateTypeBonus;
      }
      if (team.subclass === "cynthia_myth") all *= 1 + fade * CHAMPION_RULES.cynthia.mythTeamBonusPerLegend * legendCount;
    }
    if (team.champion === "leon") {
      const per =
        team.subclass === "leon_champtime" ? CHAMPION_RULES.leon.champTimeStreakStatBonus : CHAMPION_RULES.leon.streakStatBonus;
      all *= 1 + per * Math.min(team.streak, CHAMPION_RULES.leon.streakStatCap) + CHAMPION_RULES.leon.flatStatBonus;
    }
    for (const [orbKey, orb] of Object.entries(LEGEND_ORBS)) {
      if (orb.species === piece.species && items.counts.has(orbKey)) all *= 1.1;
    }
    if (team.champion === "steven" && team.subclass === "steven_regi" && REGIS.has(piece.species)) {
      const regiNeighbours = (adj.alliesOf.get(piece.uid) ?? []).filter((u) => REGIS.has((pieces[u] as PokemonPiece).species));
      all *= 1 + CHAMPION_RULES.steven.regiAdjacentBonus * regiNeighbours.length;
    }

    const stats: BattleStats = { atk: raw.atk * all, def: raw.def * all, spa: raw.spa * all, spd: raw.spd * all, spe: raw.spe * all };
    if (klutz) for (const k of ["atk", "def", "spa", "spd", "spe"] as const) stats[k] *= KLUTZ_STAT_BONUS;
    // Multitype: Arceus takes the type (and form) of an adjacent plate.
    let types = [...species.types];
    let formKey = species.spriteForm;
    if (piece.ability === "MULTITYPE") {
      const plate = (adj.itemsOf.get(piece.uid) ?? []).map((it) => ITEMS[it.item]).find((d) => d?.family === "plate" && d.type);
      if (plate?.type) {
        types = [plate.type];
        formKey = plate.type;
      }
    }
    if (team.champion === "alder") {
      const per = team.subclass === "alder_legion" ? CHAMPION_RULES.alder.legionAttackBonus : CHAMPION_RULES.alder.smallPokemonAttackBonus;
      stats.atk *= 1 + per * smallCount;
      stats.spa *= 1 + per * smallCount;
    }
    if (team.champion === "diantha" && items.megaAtStart) {
      for (const k of ["atk", "def", "spa", "spd", "spe"] as const) stats[k] *= 1 + CHAMPION_RULES.diantha.keyStoneStatBonus;
    }
    if (team.champion === "steven") {
      const devon = 1 + CHAMPION_RULES.steven.teamDefenseBonus + CHAMPION_RULES.steven.teamDefensePerRound * team.round;
      stats.def *= devon;
      stats.spd *= devon;
    }
    if (team.champion === "steven" && (species.types.includes("rock") || species.types.includes("steel"))) {
      let stones = 0;
      for (const it of adj.itemsOf.get(piece.uid) ?? []) if (ITEMS[it.item]?.stone) stones++;
      stats.def *= 1 + CHAMPION_RULES.steven.stoneDefenseBonus * stones;
      stats.spd *= 1 + CHAMPION_RULES.steven.stoneDefenseBonus * stones;
    }
    const n = (k: string) => items.counts.get(k) ?? 0;
    if (piece.species === "PIKACHU" && n("LIGHT_BALL") > 0) {
      stats.atk *= CHAMPION_RULES.red.lightBallMultiplier;
      stats.spa *= CHAMPION_RULES.red.lightBallMultiplier;
    }
    stats.atk *= stackMul(CHOICE_BOOST, n("CHOICE_BAND"));
    stats.spa *= stackMul(CHOICE_BOOST, n("CHOICE_SPECS"));
    stats.spe *= stackMul(CHOICE_BOOST, n("CHOICE_SCARF"));
    stats.spd *= stackMul(1.5, n("ASSAULT_VEST"));
    if (species.evolutions.length > 0) {
      stats.def *= stackMul(1.5, n("EVIOLITE"));
      stats.spd *= stackMul(1.5, n("EVIOLITE"));
    }
    let speedMult = stackMul(0.75, n("MACHO_BRACE"));
    let damageTakenMult = 1;
    if (piece.species === "DITTO") {
      speedMult *= stackMul(2, n("QUICK_POWDER"));
      damageTakenMult *= stackMul(0.5, n("METAL_POWDER"));
    }
    const maxHp =
      species.baseStats.hp === 1 ? 1 : Math.max(1, Math.floor(raw.hp * all * battleHpMultiplier(team.round)));

    const moveTypeMult = new Map<TypeKey, number>();
    if (team.subclass === "red_pikachu" && team.ace === piece.uid && (piece.species === "PIKACHU" || piece.species === "RAICHU")) {
      moveTypeMult.set("electric", CHAMPION_RULES.red.pikachuElectricMultiplier);
    }
    if (team.subclass === "red_kanto" && kanto) {
      const starterType: Record<string, TypeKey> = { VENUSAUR: "grass", CHARIZARD: "fire", BLASTOISE: "water" };
      const t = starterType[piece.species];
      if (t) moveTypeMult.set(t, 1.5);
    }
    if (team.subclass === "diantha_beauty") moveTypeMult.set("fairy", CHAMPION_RULES.diantha.beautyFairyMultiplier);
    if (team.champion === "kukui") {
      const early = earlyBonus(CHAMPION_RULES.kukui.earlyMovePowerBonus, CHAMPION_RULES.kukui.earlyMovePowerPerRound, team.round);
      const research = (1 + CHAMPION_RULES.kukui.movePowerPerRoundSquared * team.round ** 2) * (1 + early);
      for (const t of TYPES) moveTypeMult.set(t, (moveTypeMult.get(t) ?? 1) * research);
    }

    let critStage = n("SCOPE_LENS");
    if (team.champion === "red" && team.ace === piece.uid) critStage += CHAMPION_RULES.red.aceCritStages;
    let bagHeal = 0;
    for (const bagUid of adj.bagsOf.get(piece.uid) ?? []) {
      const bag = pieces[bagUid];
      if (bag && bag.kind === "bag" && bag.bag === "BAG_LUCKY") critStage += 1;
      if (bag && bag.kind === "bag" && bag.bag === "BAG_MEDIC") bagHeal += 1 / 32;
    }

    const moves = piece.moves.map((key) => ({ key, pp: getMove(key).pp, enabled: true }));

    battlers.push({
      id: firstId + i,
      side,
      uid: piece.uid,
      piece,
      species,
      formKey,
      types,
      originalTypes: [...types],
      ability: piece.ability,
      level: piece.level,
      stats,
      maxHp,
      hp: maxHp,
      alive: true,
      stages: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, acc: 0, eva: 0 },
      critStage,
      status: null,
      sleepTurns: 0,
      poisonStacks: 0,
      confusion: 0,
      gauge: 0,
      moves,
      charging: null,
      invulnerable: false,
      recharge: false,
      protectUntil: -1,
      protectChain: 0,
      leechSeedBy: null,
      bind: null,
      actions: 0,
      cells: cellsOf(piece),
      choiceLock: choice.lock.get(piece.uid) ?? null,
      items,
      moveTypeMult,
      damageTakenMult,
      speedMult,
      lastMove: null,
      streak: 0,
      flashFire: false,
      megaDone: false,
      isMega: false,
      dynamax: null,
      tera: null,
      stellarUsed: new Set(),
      researched: new Set(),
      zUsed: false,
      damageDealt: 0,
      transformedFrom: null,
      stance: species.key === "AEGISLASH" ? "shield" : null,
      bagHeal,
      disabledMove: null,
      spent: new Set(),
      legendBoosts: 0,
    });
  });

  const idOf = new Map(battlers.map((b) => [b.uid, b.id]));
  const timed: TimedItemState[] = [];
  for (const p of Object.values(pieces)) {
    const def = p.kind === "item" ? TIMED_ITEMS[p.item] : undefined;
    if (p.kind !== "item" || !def) continue;
    const holders = (adj.holdersOf.get(p.uid) ?? [])
      .filter((u) => (pieces[u] as PokemonPiece).ability !== "KLUTZ")
      .map((u) => idOf.get(u)!)
      .sort((a, b) => a - b);
    if (holders.length > 0) timed.push({ item: p.item, holders, readyAt: def.every * TICKS_PER_SECOND, usesLeft: def.uses });
  }
  // Copies ready on the same tick act in board order of the first Pokémon they touch.
  timed.sort((a, b) => a.holders[0]! - b.holders[0]! || (a.item < b.item ? -1 : a.item > b.item ? 1 : 0));

  const rules = CHAMPION_RULES;
  const state: SideState = {
    side,
    team,
    champion: team.champion,
    subclass: team.subclass,
    zLeft: team.champion === "kukui" ? (team.subclass === "kukui_zmaster" ? 99 : rules.kukui.zMovesPerBattle) : 0,
    megasLeft:
      team.champion === "diantha"
        ? team.subclass === "diantha_dual"
          ? rules.diantha.dualMegasPerBattle
          : rules.diantha.megasPerBattle
        : team.subclass === "steven_mega"
          ? 1
          : 0,
    terasLeft: team.champion === "geeta" ? rules.geeta.terasPerBattle + placedTeraOrbs : 0,
    dynamaxDone: team.champion !== "leon",
    screens: { reflect: 0, lightScreen: 0, auroraVeil: 0 },
    tailwind: 0,
    firstFaintDone: false,
    fainted: 0,
    gmaxResidual: null,
    gold: 0,
    amuletCoins: team.pieces.reduce((gold, p) => {
      if (p.place && p.kind === "bag" && BAGS[p.bag]?.effect === "coin") return gold + COIN_CASE_WIN_GOLD;
      if (!p.place || p.kind !== "item" || (adj.holdersOf.get(p.uid)?.length ?? 0) === 0) return gold;
      const base = p.item === "AMULET_COIN" ? 1 : p.item === "LUCK_INCENSE" ? 2 : 0;
      if (base === 0) return gold;
      return gold + base + (poweredByBag(p.item, adj.bagUnder.get(p.uid)) ? COIN_CASE_EXTRA_GOLD : 0);
    }, 0),
    timed,
  };
  return { battlers, state };
}
