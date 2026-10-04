import { describe, expect, it } from "vitest";
import {
  CHAMPION_RULES,
  newPokemon,
  rollTraits,
  rngFor,
  simulateBattle,
  teamBonuses,
  type ChampionKey,
  type Piece,
  type PokemonPiece,
  type SubclassKey,
  type TeamSnapshot,
} from "../src/index.ts";

let uid = 0;
function mon(species: string, level: number, x: number, y: number): PokemonPiece {
  const p = newPokemon(`b${uid++}`, species, level, rollTraits(species, rngFor("b", species, uid)), 0, 4);
  p.place = { x, y, rot: 0 };
  return p;
}
const asState = (champion: ChampionKey, pieces: Piece[], extra: { subclass?: SubclassKey | null; round?: number; streak?: number; ace?: string | null } = {}) => ({
  champion,
  subclass: extra.subclass ?? null,
  round: extra.round ?? 8,
  streak: extra.streak ?? 0,
  ace: extra.ace ?? null,
  pieces: Object.fromEntries(pieces.map((p) => [p.uid, p])),
});
const snapshot = (champion: ChampionKey, pieces: Piece[], round: number, streak = 0, subclass: SubclassKey | null = null): TeamSnapshot => ({
  name: champion,
  champion,
  subclass,
  round,
  wins: 0,
  losses: 0,
  streak,
  ace: null,
  pieces,
});
const wall = (): TeamSnapshot => snapshot("red", [mon("SNORLAX", 70, 2, 1)], 8);
const hp = (team: TeamSnapshot) => simulateBattle({ seed: "bonus", teams: [team, wall()] }).initial.filter((b) => b.side === 0).reduce((a, b) => a + b.maxHp, 0);

describe("team bonus panel (teamBonuses)", () => {
  it("lists nothing for a champion without a team-wide bonus, and the ace for Red", () => {
    const pikachu = mon("PIKACHU", 20, 3, 1);
    expect(teamBonuses(asState("red", [pikachu]))).toEqual([]);
    const [ace] = teamBonuses(asState("red", [{ ...pikachu, aceBonus: 0.08 }], { ace: pikachu.uid }));
    expect(ace).toMatchObject({ id: "red_ace", scope: "one", amount: 0.08 });
  });

  it("counts the types of the Pokémon on the board for Cynthia (dual types twice) and matches the battle", () => {
    const types = ["PIKACHU", "GEODUDE", "BULBASAUR", "SQUIRTLE", "CHARMANDER", "GASTLY"];
    const pieces = types.map((s, i) => mon(s, 50, i, 0));
    const [b] = teamBonuses(asState("cynthia", pieces, { round: 8 }));
    expect(b!.id).toBe("cynthia_types");
    expect(b!.params.n).toBeGreaterThanOrEqual(6);
    expect(b!.params.counted).toBe(CHAMPION_RULES.cynthia.typeDiversityCap);
    expect(b!.amount).toBeCloseTo(CHAMPION_RULES.cynthia.typeDiversityBonus * CHAMPION_RULES.cynthia.typeDiversityCap, 6);
    // In battle every stat (HP too) rises by exactly that much against Red, who has no bonus.
    const ratio = hp(snapshot("cynthia", pieces, 8)) / hp(snapshot("red", pieces, 8));
    expect(ratio).toBeCloseTo(1 + b!.amount, 2);
  });

  it("shows Leon's streak and flat bonus as the battle applies them", () => {
    const pieces = [mon("RILLABOOM", 40, 3, 1), mon("CINDERACE", 40, 5, 1)];
    const none = teamBonuses(asState("leon", pieces, { streak: 0 }))[0]!;
    const three = teamBonuses(asState("leon", pieces, { streak: 3 }))[0]!;
    expect(none.amount).toBeCloseTo(CHAMPION_RULES.leon.flatStatBonus, 6);
    expect(three.amount).toBeCloseTo(CHAMPION_RULES.leon.flatStatBonus + 3 * CHAMPION_RULES.leon.streakStatBonus, 6);
    const capped = teamBonuses(asState("leon", pieces, { streak: 99 }))[0]!;
    expect(capped.params.counted).toBe(CHAMPION_RULES.leon.streakStatCap);
    const ratio = hp(snapshot("leon", pieces, 8, 3)) / hp(snapshot("leon", pieces, 8, 0));
    expect(ratio).toBeCloseTo((1 + three.amount) / (1 + none.amount), 2);
  });

  it("shows Steven's defense growing with the round and the early bonus ending at round 5", () => {
    const pieces = [mon("METAGROSS", 40, 3, 1)];
    const r1 = teamBonuses(asState("steven", pieces, { round: 1 }));
    expect(r1.map((b) => b.id)).toEqual(["steven_defense", "steven_early"]);
    const r8 = teamBonuses(asState("steven", pieces, { round: 8 }));
    expect(r8.map((b) => b.id)).toEqual(["steven_defense"]);
    expect(r8[0]!.amount).toBeCloseTo(0.15 + 0.0135 * 8, 6);
  });

  it("counts Alder's 1-cell Pokémon, and his young bugs only while the early bonus lasts", () => {
    const pieces = [mon("CATERPIE", 10, 3, 1), mon("WEEDLE", 10, 4, 1)];
    const early = teamBonuses(asState("alder", pieces, { round: 2 }));
    expect(early.map((b) => b.id)).toEqual(["alder_small", "alder_youngBug"]);
    expect(early[0]!.amount).toBeCloseTo(2 * CHAMPION_RULES.alder.smallPokemonAttackBonus, 6);
    expect(early[1]!.params.n).toBe(2);
    expect(teamBonuses(asState("alder", pieces, { round: 6 })).map((b) => b.id)).toEqual(["alder_small"]);
    expect(teamBonuses(asState("alder", pieces, { round: 6, subclass: "alder_legion" }))[0]!.amount).toBeCloseTo(2 * CHAMPION_RULES.alder.legionAttackBonus, 6);
  });

  it("shows Kukui's research as the move power multiplier his team gets", () => {
    const [b] = teamBonuses(asState("kukui", [mon("LYCANROC", 30, 3, 1)], { round: 8 }));
    const research = 1 + CHAMPION_RULES.kukui.movePowerPerRoundSquared * 64;
    const early = Math.max(0, CHAMPION_RULES.kukui.earlyMovePowerBonus - CHAMPION_RULES.kukui.earlyMovePowerPerRound * 8);
    expect(b!.amount).toBeCloseTo(research * (1 + early) - 1, 6);
  });
});
