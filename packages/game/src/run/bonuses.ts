import { CHAMPION_RULES, cynthiaBonusScale, earlyBonus } from "../content/champions.ts";
import { getSpecies } from "../content/index.ts";
import { computeAdjacency } from "./layout.ts";
import { isLanceKinLine } from "./pool.ts";
import type { Piece, PokemonPiece, RunState } from "./types.ts";

/**
 * One bonus the champion's passives give the field right now (the "team bonus" panel on the run screen).
 * `id` is the locale key (`ui.teamBonus.entries.<id>`), `params` fill its text.
 */
export interface TeamBonus {
  id: string;
  /** `team`: every Pokémon on the board; `group`: only the Pokémon the text names; `one`: a single Pokémon. */
  scope: "team" | "group" | "one";
  /** The size of the bonus as a fraction (0.035 = +3.5%). Stats, or move power for Kukui's research. */
  amount: number;
  params: Record<string, number>;
}

/** Percent points with one decimal: 0.035 → 3.5. */
const pct = (x: number): number => Math.round(x * 1000) / 10;

type BonusState = Pick<RunState, "champion" | "subclass" | "round" | "streak" | "pieces" | "ace">;

/**
 * Every field-wide (and group-wide) bonus of the champion's passives for the board as it stands. Mirrors what
 * battle/setup.ts applies, so what the panel says is what the next battle gets (test/bonuses.test.ts checks it).
 */
export function teamBonuses(state: BonusState): TeamBonus[] {
  const out: TeamBonus[] = [];
  const placed = Object.values(state.pieces).filter((p): p is PokemonPiece => p.kind === "pokemon" && p.place !== null);
  const R = CHAMPION_RULES;
  const round = state.round;
  const add = (id: string, scope: TeamBonus["scope"], amount: number, params: Record<string, number> = {}) => out.push({ id, scope, amount, params });

  switch (state.champion) {
    case "red": {
      const ace = state.ace ? placed.find((m) => m.uid === state.ace) : undefined;
      if (ace) add("red_ace", "one", ace.aceBonus, { pct: pct(ace.aceBonus), cap: pct(R.red.aceWinStatCap), crit: R.red.aceCritStages });
      break;
    }
    case "lance": {
      const kin = placed.filter((m) => getSpecies(m.species).evolutions.length > 0 && isLanceKinLine(m.species));
      const early = earlyBonus(R.lance.youngKinStatBonus, R.lance.youngKinPerRound, round);
      if (early > 0) add("lance_youngKin", "group", early, { pct: pct(early), n: kin.length });
      break;
    }
    case "steven": {
      const defense = R.steven.teamDefenseBonus + R.steven.teamDefensePerRound * round;
      add("steven_defense", "team", defense, { pct: pct(defense) });
      const early = earlyBonus(R.steven.earlyStatBonus, R.steven.earlyStatPerRound, round);
      if (early > 0) add("steven_early", "team", early, { pct: pct(early) });
      break;
    }
    case "cynthia": {
      const types = new Set(placed.flatMap((m) => getSpecies(m.species).types));
      const useCount = new Map<string, number>();
      for (const m of placed) for (const t of getSpecies(m.species).types) useCount.set(t, (useCount.get(t) ?? 0) + 1);
      const per = state.subclass === "cynthia_diversity" ? R.cynthia.diversityBonusUpgraded : R.cynthia.typeDiversityBonus;
      const fade = cynthiaBonusScale(round);
      const counted = Math.min(types.size, R.cynthia.typeDiversityCap);
      add("cynthia_types", "team", fade * per * counted, { pct: pct(fade * per * counted), n: types.size, counted, per: pct(per), fade: pct(fade) });
      if (state.subclass === "cynthia_diversity") {
        const unique = placed.length > 0 && [...useCount.values()].every((n) => n < 2);
        add(unique ? "cynthia_unique" : "cynthia_uniqueOff", "team", unique ? fade * R.cynthia.noDuplicateTypeBonus : 0, {
          pct: pct(fade * R.cynthia.noDuplicateTypeBonus),
        });
      }
      if (state.subclass === "cynthia_myth") {
        const legends = placed.filter((m) => {
          const s = getSpecies(m.species);
          return s.legendary || s.mythical || s.subLegendary;
        }).length;
        add("cynthia_myth", "team", fade * R.cynthia.mythTeamBonusPerLegend * legends, {
          pct: pct(fade * R.cynthia.mythTeamBonusPerLegend * legends),
          n: legends,
          per: pct(fade * R.cynthia.mythTeamBonusPerLegend),
        });
      }
      break;
    }
    case "alder": {
      const small = placed.filter((m) => {
        const f = getSpecies(m.species).footprint;
        return f.w * f.h === 1;
      }).length;
      const per = state.subclass === "alder_legion" ? R.alder.legionAttackBonus : R.alder.smallPokemonAttackBonus;
      add("alder_small", "team", per * small, { pct: pct(per * small), n: small, per: pct(per) });
      const young = placed.filter((m) => getSpecies(m.species).evolutions.length > 0 && getSpecies(m.species).types.includes("bug"));
      const early = earlyBonus(R.alder.youngBugStatBonus, R.alder.youngBugPerRound, round);
      if (early > 0) add("alder_youngBug", "group", early, { pct: pct(early), n: young.length });
      break;
    }
    case "diantha": {
      const pieces: Record<string, Piece> = {};
      for (const p of Object.values(state.pieces)) if (p.place) pieces[p.uid] = p;
      const adj = computeAdjacency(pieces);
      const touched = placed.filter((m) => (adj.itemsOf.get(m.uid) ?? []).some((it) => it.item === "MEGA_BRACELET")).length;
      add("diantha_keyStone", "group", touched > 0 ? R.diantha.keyStoneStatBonus : 0, { pct: pct(R.diantha.keyStoneStatBonus), n: touched });
      break;
    }
    case "kukui": {
      const early = earlyBonus(R.kukui.earlyMovePowerBonus, R.kukui.earlyMovePowerPerRound, round);
      const research = 1 + R.kukui.movePowerPerRoundSquared * round ** 2;
      const total = research * (1 + early) - 1;
      add("kukui_research", "team", total, { pct: pct(total), research: pct(research - 1), early: pct(early) });
      break;
    }
    case "leon": {
      const per = state.subclass === "leon_champtime" ? R.leon.champTimeStreakStatBonus : R.leon.streakStatBonus;
      const streak = Math.min(state.streak, R.leon.streakStatCap);
      const total = per * streak + R.leon.flatStatBonus;
      add("leon_streak", "team", total, {
        pct: pct(total),
        streak: state.streak,
        counted: streak,
        streakPct: pct(per * streak),
        flat: pct(R.leon.flatStatBonus),
        per: pct(per),
        cap: R.leon.streakStatCap,
      });
      break;
    }
    case "geeta": {
      const mult = R.geeta.teraStatBonus + R.geeta.teraStatPerRound * round;
      add("geeta_tera", "group", mult - 1, { pct: pct(mult - 1), mult: Math.round(mult * 100) / 100 });
      break;
    }
  }
  return out;
}
