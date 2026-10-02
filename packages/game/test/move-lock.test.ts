import { describe, expect, it } from "vitest";
import {
  applyAction,
  BattleSim,
  chooseMoves,
  createRun,
  getMove,
  getSpecies,
  isSupport,
  moveSlotsFor,
  newPokemon,
  refreshMoves,
  rngFor,
  rollTraits,
  type PokemonPiece,
  type RunState,
  type TeamSnapshot,
} from "../src/index.ts";

const statusCount = (moves: string[]) => moves.filter((m) => getMove(m).category === "status").length;

/** A fresh run with its starter swapped for a Chansey at a level. */
function withChansey(level: number): { s: RunState; mon: PokemonPiece } {
  const s = createRun({ runId: "lock", seed: "lock", playerName: "t", champion: "red" });
  const mon = newPokemon("chansey", "CHANSEY", level, rollTraits("CHANSEY", rngFor("lock", "c")), 0, moveSlotsFor(s.subclass));
  s.pieces[mon.uid] = mon;
  return { s, mon };
}

describe("move locks", () => {
  it("start unlocked", () => {
    const { mon } = withChansey(10);
    expect(mon.locked ?? []).toEqual([]);
  });

  it("a locked move survives level-ups, an unlocked one can be re-picked", () => {
    const { s, mon } = withChansey(7);
    expect(mon.moves).toContain("LIFE_DEW");
    const locked = applyAction(s, { t: "lockMove", uid: mon.uid, move: "LIFE_DEW" });
    const piece = locked.pieces[mon.uid] as PokemonPiece;
    expect(piece.locked).toEqual(["LIFE_DEW"]);
    for (const level of [20, 40, 60, 80]) {
      piece.level = level;
      refreshMoves(piece, moveSlotsFor(locked.subclass));
      expect(piece.moves).toContain("LIFE_DEW");
      expect(piece.moves).toHaveLength(4);
    }
  });

  it("lockMove toggles, and refuses a move the Pokémon does not have", () => {
    const { s, mon } = withChansey(30);
    const key = mon.moves[0]!;
    const on = applyAction(s, { t: "lockMove", uid: mon.uid, move: key });
    expect((on.pieces[mon.uid] as PokemonPiece).locked).toEqual([key]);
    const off = applyAction(on, { t: "lockMove", uid: mon.uid, move: key });
    expect((off.pieces[mon.uid] as PokemonPiece).locked).toEqual([]);
    expect(() => applyAction(s, { t: "lockMove", uid: mon.uid, move: "NOT_A_MOVE" })).toThrow("invalid_move");
    expect(() => applyAction(s, { t: "lockMove", uid: "missing", move: key })).toThrow();
  });

  it("a TM can replace a locked move the player picks, which unlocks it", () => {
    const { s, mon } = withChansey(60);
    const tm = getSpecies("CHANSEY").tmMoves.find((m) => !mon.moves.includes(m) && getMove(m).category !== "status")!;
    s.pieces.tm = { uid: "tm", kind: "item", place: null, paid: 0, item: "TM", param: tm, age: 0 };
    const give = mon.moves[0]!;
    const locked = applyAction(s, { t: "lockMove", uid: mon.uid, move: give });
    const out = applyAction(locked, { t: "use", uid: "tm", target: mon.uid, replace: give });
    const piece = out.pieces[mon.uid] as PokemonPiece;
    expect(piece.moves).toContain(tm);
    expect(piece.moves).not.toContain(give);
    expect(piece.locked).not.toContain(give);
  });

  it("a TM with no room (every move locked, none picked) is refused", () => {
    const { s, mon } = withChansey(60);
    const tm = getSpecies("CHANSEY").tmMoves.find((m) => !mon.moves.includes(m) && getMove(m).category !== "status")!;
    s.pieces.tm = { uid: "tm", kind: "item", place: null, paid: 0, item: "TM", param: tm, age: 0 };
    mon.locked = [...mon.moves];
    expect(() => applyAction(s, { t: "use", uid: "tm", target: mon.uid })).toThrow("moves_locked");
  });

  it("a locked move the species no longer knows is dropped without breaking the set", () => {
    const moves = chooseMoves("CHANSEY", 60, [], 4, [], [], ["NOT_A_MOVE", "LIFE_DEW"]);
    expect(moves).toContain("LIFE_DEW");
    expect(moves).toHaveLength(4);
  });
});

describe("auto-picked moves", () => {
  it("healer types may carry two status moves, others still one", () => {
    expect(isSupport(getSpecies("CHANSEY"))).toBe(true);
    expect(isSupport(getSpecies("BLISSEY"))).toBe(true);
    expect(isSupport(getSpecies("PIKACHU"))).toBe(false);
    expect(isSupport(getSpecies("MACHAMP"))).toBe(false);
    const chansey = chooseMoves("CHANSEY", 60, [], 4);
    expect(statusCount(chansey)).toBeGreaterThanOrEqual(2);
    expect(statusCount(chooseMoves("PIKACHU", 60, [], 4))).toBeLessThanOrEqual(1);
  });
});

describe("Life Dew", () => {
  it("heals the allies on the user's side, not only the user", () => {
    const mk = (species: string, x: number, y: number, moves: string[]): PokemonPiece => {
      const p = newPokemon(`${species}${x}`, species, 50, rollTraits(species, rngFor("dew", species)), 0, 4);
      return { ...p, place: { x, y, rot: 0 }, moves };
    };
    const team = (pieces: PokemonPiece[]): TeamSnapshot => ({ name: "t", champion: "red", subclass: null, round: 10, wins: 0, losses: 0, streak: 0, ace: null, pieces });
    const sim = new BattleSim({ seed: "dew", teams: [team([mk("CHANSEY", 3, 1, ["LIFE_DEW"]), mk("PIKACHU", 3, 3, ["GROWL"])]), team([mk("BLISSEY", 3, 1, ["GROWL"])])] }, {});
    const [healer, ally] = sim.battlers;
    ally!.hp = Math.floor(ally!.maxHp * 0.3);
    const r = sim.run();
    const healed = r.events.filter((e) => e.k === "heal" && e.cause === "move").map((e) => e.k === "heal" && e.target);
    expect(healed).toContain(ally!.id);
    expect(healer!.id).not.toBe(ally!.id);
  });
});
