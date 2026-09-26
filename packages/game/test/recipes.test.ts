import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyAction,
  computeAdjacency,
  createRun,
  ITEMS,
  layoutIsValid,
  newPokemon,
  reachCells,
  RECIPES,
  rngFor,
  rollTraits,
  type ItemPiece,
  type Piece,
  type RunState,
} from "../src/index.ts";

let n = 0;
function item(key: string, x: number, y: number, rot: 0 | 1 | 2 | 3 = 0): ItemPiece {
  return { uid: `r${n++}`, kind: "item", place: { x, y, rot }, paid: 3, item: key, age: 0 };
}
function withPieces(pieces: Piece[], champion: "red" | "alder" = "red"): RunState {
  const s = createRun({ runId: "r", seed: "s", playerName: "p", champion });
  // A full 9×7 board of bags so placements only test the rule at hand.
  const bags: Piece[] = [];
  for (let y = 0; y < 7; y += 3) for (let x = 0; x < 9; x += 3) bags.push({ uid: `b${x}${y}`, kind: "bag", place: { x, y, rot: 0 }, paid: 0, bag: "BAG_3X3" });
  s.pieces = Object.fromEntries([...bags, ...pieces].map((p) => [p.uid, p]));
  s.gold = 99;
  return s;
}

describe("reach patterns", () => {
  const key = (c: { x: number; y: number }) => `${c.x},${c.y}`;
  it("front and line point where the item is turned", () => {
    expect(reachCells([{ x: 4, y: 4 }], "front", 0).map(key)).toEqual(["4,3"]);
    expect(reachCells([{ x: 4, y: 4 }], "front", 1).map(key)).toEqual(["5,4"]);
    expect(reachCells([{ x: 4, y: 4 }], "line", 0).map(key)).toEqual(["4,1", "4,2", "4,3"]);
    // Turned to face the back, it stops at the board's last row (y = 5).
    expect(reachCells([{ x: 4, y: 3 }], "line", 2).map(key)).toEqual(["4,4", "4,5"]);
  });
  it("diagonal hits only corners, around hits all eight", () => {
    expect(reachCells([{ x: 4, y: 4 }], "diagonal", 0).map(key)).toEqual(["3,3", "5,3", "3,5", "5,5"]);
    expect(reachCells([{ x: 4, y: 4 }], "around", 0)).toHaveLength(8);
  });
  it("row covers the whole row, or the column when turned", () => {
    expect(reachCells([{ x: 4, y: 2 }], "row", 0)).toHaveLength(8);
    expect(reachCells([{ x: 4, y: 2 }], "row", 1)).toHaveLength(5);
  });
  it("a Scope Lens reaches a Pokémon two cells ahead but not one beside it", () => {
    const mon = (x: number, y: number, uid: string) => {
      const p = newPokemon(uid, "PIKACHU", 10, rollTraits("PIKACHU", rngFor(uid)), 3, 4);
      p.place = { x, y, rot: 0 };
      return p;
    };
    const lens = item("SCOPE_LENS", 4, 4);
    const s = withPieces([lens, mon(4, 2, "ahead"), mon(5, 4, "beside")]);
    expect(computeAdjacency(s.pieces).holdersOf.get(lens.uid)).toEqual(["ahead"]);
  });
});

describe("big items", () => {
  it("an Expert Belt takes 3 cells in a row and rotates", () => {
    const belt = item("EXPERT_BELT", 1, 1);
    let s = withPieces([belt]);
    expect(layoutIsValid(s.pieces)).toBe(true);
    s = applyAction(s, { t: "move", uid: belt.uid, place: { x: 1, y: 1, rot: 1 } });
    const blocker = item("CHARCOAL", 1, 3);
    expect(() => applyAction({ ...s, pieces: { ...s.pieces, [blocker.uid]: blocker } }, { t: "move", uid: belt.uid, place: { x: 1, y: 1, rot: 1 } })).not.toThrow();
  });
});

describe("recipes", () => {
  it("two touching Charcoals become a Flame Plate where they were", () => {
    const a = item("CHARCOAL", 2, 2);
    const b = item("CHARCOAL", 5, 5);
    const s = applyAction(withPieces([a, b]), { t: "move", uid: b.uid, place: { x: 3, y: 2, rot: 0 } });
    const items = Object.values(s.pieces).filter((p) => p.kind === "item");
    expect(items.map((p) => (p as ItemPiece).item)).toEqual(["FLAME_PLATE"]);
    expect(items[0]!.place).toMatchObject({ y: 2 });
    expect(s.notices.some((x) => x.key === "notice.combined")).toBe(true);
  });

  it("items that do not touch stay apart", () => {
    const a = item("CHARCOAL", 2, 2);
    const b = item("CHARCOAL", 5, 5);
    const s = applyAction(withPieces([a, b]), { t: "move", uid: b.uid, place: { x: 4, y: 2, rot: 0 } });
    expect(Object.values(s.pieces).filter((p) => p.kind === "item")).toHaveLength(2);
  });

  it("Poké Balls chain into an Ultra Ball", () => {
    const pieces = [item("POKE_BALL", 1, 1), item("POKE_BALL", 4, 4), item("GREAT_BALL", 3, 1)];
    const s = applyAction(withPieces(pieces, "alder"), { t: "move", uid: pieces[1]!.uid, place: { x: 2, y: 1, rot: 0 } });
    expect(Object.values(s.pieces).filter((p) => p.kind === "item").map((p) => (p as ItemPiece).item)).toEqual(["ULTRA_BALL"]);
  });

  it("every recipe output has a name, rules text and icon", () => {
    const b = (lang: string) =>
      JSON.parse(readFileSync(new URL(`../../../apps/client/public/locales/${lang}.json`, import.meta.url), "utf8")) as {
        items: Record<string, { name: string }>;
        game: { itemEffect: Record<string, string> };
      };
    const icons = JSON.parse(readFileSync(new URL("../../../apps/client/public/assets/items-manifest.json", import.meta.url), "utf8")) as Record<string, unknown>;
    for (const lang of ["ko", "en"]) {
      const bundle = b(lang);
      for (const r of RECIPES) {
        const def = ITEMS[r.output]!;
        expect(bundle.items[r.output]?.name, `${lang} ${r.output}`).toBeTruthy();
        expect(bundle.game.itemEffect[def.family === "plate" ? "PLATE" : r.output], `${lang} effect ${r.output}`).toBeTruthy();
        expect(icons[r.output], `icon ${r.output}`).toBeTruthy();
      }
    }
  });
});
