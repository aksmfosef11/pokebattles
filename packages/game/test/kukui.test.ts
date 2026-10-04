import { describe, expect, it } from "vitest";
import {
  CHAMPION_RULES,
  CHAMPIONS,
  newPokemon,
  rollTraits,
  rngFor,
  simulateBattle,
  type ItemPiece,
  type Piece,
  type PokemonPiece,
  type SubclassKey,
  type TeamSnapshot,
} from "../src/index.ts";

let uid = 0;
function mon(species: string, level: number, x: number, y: number, moves?: string[]): PokemonPiece {
  const p = newPokemon(`k${uid++}`, species, level, rollTraits(species, rngFor("k", species, 1)), 0, 4);
  p.place = { x, y, rot: 0 };
  return moves ? { ...p, moves } : p;
}
function item(key: string, x: number, y: number): ItemPiece {
  return { uid: `ki${uid++}`, kind: "item", place: { x, y, rot: 0 }, paid: 0, item: key, age: 0 };
}
const team = (champion: TeamSnapshot["champion"], pieces: Piece[], subclass: SubclassKey | null): TeamSnapshot => ({
  name: champion,
  champion,
  subclass,
  round: 10,
  wins: 0,
  losses: 0,
  streak: 0,
  ace: null,
  pieces,
});

describe("Kukui's subclasses", () => {
  it("offers Z Master and Royal Mask; the retired Research stays valid for old runs", () => {
    expect(CHAMPIONS.kukui.subclasses).toEqual(["kukui_zmaster", "kukui_royal"]);
    // A ghost or run that picked it before 2026-10-04 still fights.
    const r = simulateBattle({ seed: "old", teams: [team("kukui", [mon("LYCANROC", 40, 3, 1)], "kukui_research"), team("red", [mon("SNORLAX", 40, 3, 1)], null)] });
    expect(r.winner).not.toBeUndefined();
  });

  it("Royal Mask: a type that has hit a Pokémon once hurts it less afterwards", () => {
    const attacker = () => team("red", [mon("MACHAMP", 60, 3, 1, ["CLOSE_COMBAT"])], null);
    const tank = (subclass: SubclassKey | null) => team("kukui", [mon("SNORLAX", 60, 3, 1, ["REST"])], subclass);
    const hits = (subclass: SubclassKey | null) => {
      const r = simulateBattle({ seed: "royal", teams: [tank(subclass), attacker()] });
      return r.events.filter((e) => e.k === "damage" && e.target === 0 && e.cause === "move").map((e) => (e.k === "damage" ? e.amount : 0));
    };
    const plain = hits(null);
    const royal = hits("kukui_royal");
    expect(plain.length).toBeGreaterThan(2);
    expect(royal.length).toBeGreaterThan(2);
    // The first hit is as strong as ever (it is how the type gets researched) ...
    expect(royal[0]).toBe(plain[0]);
    // ... and the rest do 25% less (one level of rounding either way).
    const mean = (a: number[]) => a.slice(1, 4).reduce((s, v) => s + v, 0) / a.slice(1, 4).length;
    expect(mean(royal) / mean(plain)).toBeLessThan(1 - CHAMPION_RULES.kukui.royalResearchReduction + 0.06);
    expect(mean(royal) / mean(plain)).toBeGreaterThan(1 - CHAMPION_RULES.kukui.royalResearchReduction - 0.06);
  });

  it("Royal Mask does nothing for other champions", () => {
    const attacker = () => team("red", [mon("MACHAMP", 60, 3, 1, ["CLOSE_COMBAT"])], null);
    const tank = (champion: TeamSnapshot["champion"], subclass: SubclassKey | null) => team(champion, [mon("SNORLAX", 60, 3, 1, ["REST"])], subclass);
    const hits = (champion: TeamSnapshot["champion"], subclass: SubclassKey | null) =>
      simulateBattle({ seed: "royal", teams: [tank(champion, subclass), attacker()] }).events.filter((e) => e.k === "damage" && e.target === 0 && e.cause === "move").length;
    expect(hits("diantha", null)).toBe(hits("diantha", "kukui_royal"));
  });

  it("Z Master's crystals power their type more than other Kukui boards' do", () => {
    const board = (subclass: SubclassKey | null) =>
      team("kukui", [mon("LYCANROC", 45, 3, 1, ["ROCK_SLIDE", "ACCELEROCK"]), item("ROCKIUM_Z", 4, 1)], subclass);
    const dealt = (subclass: SubclassKey | null) => {
      const r = simulateBattle({ seed: "zm", teams: [board(subclass), team("red", [mon("SNORLAX", 70, 3, 1, ["REST"])], null)] });
      return r.events.reduce((s, e) => (e.k === "damage" && e.src === 0 && e.cause === "move" ? s + e.amount : s), 0);
    };
    expect(CHAMPION_RULES.kukui.zMasterCrystalBoost).toBeGreaterThan(CHAMPION_RULES.kukui.zCrystalTypeBoost);
    expect(dealt("kukui_zmaster")).toBeGreaterThan(dealt(null));
  });
});
