import { describe, expect, it } from "vitest";
import { applyAction, createRun, getMove, getSpecies, moveSlotsFor, refreshMoves, type ItemPiece, type PokemonPiece, type RunState } from "../src/index.ts";

/** A level-60 starter with a full moveset and a TM it does not know yet. */
function setup(): { s: RunState; mon: PokemonPiece; tm: ItemPiece } {
  const s = createRun({ runId: "tm", seed: "tm", playerName: "t", champion: "red" });
  const mon = Object.values(s.pieces).find((p): p is PokemonPiece => p.kind === "pokemon")!;
  mon.level = 60;
  refreshMoves(mon, moveSlotsFor(s.subclass));
  const param = getSpecies(mon.species).tmMoves.find((m) => !mon.moves.includes(m) && getMove(m).category !== "status")!;
  const tm: ItemPiece = { uid: "tm", kind: "item", place: null, paid: 0, item: "TM", param, age: 0 };
  s.pieces.tm = tm;
  return { s, mon, tm };
}

describe("TM move choice", () => {
  it("replaces exactly the chosen move and keeps the rest", () => {
    const { s, mon, tm } = setup();
    expect(mon.moves).toHaveLength(moveSlotsFor(s.subclass));
    for (const give of mon.moves) {
      const fresh = setup();
      const before = [...fresh.mon.moves];
      const out = applyAction(fresh.s, { t: "use", uid: "tm", target: fresh.mon.uid, replace: give });
      const after = (out.pieces[fresh.mon.uid] as PokemonPiece).moves;
      expect([...after].sort()).toEqual([...before.filter((m) => m !== give), fresh.tm.param!].sort());
    }
    expect(tm.param).toBeTruthy();
  });

  it("does not bring the given-up move back when the moveset is recomputed", () => {
    const { s, mon } = setup();
    const give = mon.moves[0]!;
    const out = applyAction(s, { t: "use", uid: "tm", target: mon.uid, replace: give });
    const taught = out.pieces[mon.uid] as PokemonPiece;
    refreshMoves(taught, moveSlotsFor(out.subclass));
    expect(taught.moves).not.toContain(give);
  });

  it("refuses a move the Pokémon does not have, and still re-picks the set without a choice", () => {
    const { s, mon, tm } = setup();
    expect(() => applyAction(s, { t: "use", uid: "tm", target: mon.uid, replace: "NOT_A_MOVE" })).toThrow("invalid_target");
    const out = applyAction(s, { t: "use", uid: "tm", target: mon.uid });
    expect((out.pieces[mon.uid] as PokemonPiece).moves).toContain(tm.param);
  });
});
