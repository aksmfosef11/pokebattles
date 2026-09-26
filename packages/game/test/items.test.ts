import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyAction,
  BAGS,
  createRun,
  ITEMS,
  newPokemon,
  rngFor,
  rollTraits,
  rotationSpot,
  simulateBattle,
  type ChampionKey,
  type ItemPiece,
  type Piece,
  type PokemonPiece,
  type RunState,
  type TeamSnapshot,
} from "../src/index.ts";

let n = 0;
function mon(species: string, level: number, x: number, y: number, ability?: string): PokemonPiece {
  const p = newPokemon(`m${n++}`, species, level, rollTraits(species, rngFor("items", species, n)), 3, 4);
  p.place = { x, y, rot: 0 };
  if (ability) p.ability = ability;
  return p;
}
function item(key: string, x: number, y: number): ItemPiece {
  return { uid: `i${n++}`, kind: "item", place: { x, y, rot: 0 }, paid: 3, item: key, age: 0 };
}
function team(pieces: Piece[], champion: ChampionKey = "red"): TeamSnapshot {
  return { name: "t", champion, subclass: null, round: 6, wins: 0, losses: 0, streak: 0, ace: null, pieces };
}
function withPieces(pieces: Piece[]): RunState {
  const s = createRun({ runId: "r", seed: "s", playerName: "p", champion: "red" });
  const bag: Piece = { uid: "bag", kind: "bag", place: { x: 1, y: 1, rot: 0 }, paid: 0, bag: "BAG_START_LEGACY" };
  s.pieces = Object.fromEntries([bag, ...pieces].map((p) => [p.uid, p]));
  return s;
}

describe("drag onto an occupied cell", () => {
  it("swaps two items", () => {
    const a = item("LEFTOVERS", 1, 1);
    const b = item("CHARCOAL", 3, 1);
    const s = applyAction(withPieces([a, b]), { t: "move", uid: a.uid, place: { x: 3, y: 1, rot: 0 } });
    expect(s.pieces[a.uid]!.place).toMatchObject({ x: 3, y: 1 });
    expect(s.pieces[b.uid]!.place).toMatchObject({ x: 1, y: 1 });
  });

  it("never pushes a Pokémon out of the party: no room to swap means no drop", () => {
    const small = item("LEFTOVERS", 5, 3);
    const big = mon("CHARIZARD", 40, 3, 1); // 2×1, cannot fit where the item was
    expect(() => applyAction(withPieces([small, big]), { t: "move", uid: small.uid, place: { x: 4, y: 1, rot: 0 } })).toThrow("occupied");
  });

  it("swaps a Pokémon into the dropped item's spot when it fits", () => {
    const leftovers = item("LEFTOVERS", 1, 3);
    const pika = mon("PIKACHU", 20, 3, 1);
    const s = applyAction(withPieces([leftovers, pika]), { t: "move", uid: leftovers.uid, place: { x: 3, y: 1, rot: 0 } });
    expect(s.pieces[pika.uid]!.place).toMatchObject({ x: 1, y: 3 });
  });

  it("refuses to buy an item onto a Pokémon", () => {
    const s = withPieces([mon("PIKACHU", 20, 2, 2)]);
    s.gold = 99;
    s.shop[0] = { offer: { kind: "item", tier: 1, item: "MYSTIC_WATER" }, locked: false, sale: false };
    expect(() => applyAction(s, { t: "buy", slot: 0, place: { x: 2, y: 2, rot: 0 } })).toThrow("occupied");
  });

  it("pushes the occupant to the stash when buying onto it", () => {
    let s = withPieces([item("CHARCOAL", 2, 2)]);
    s.gold = 99;
    s.shop[0] = { offer: { kind: "item", tier: 1, item: "MYSTIC_WATER" }, locked: false, sale: false };
    const slot = 0;
    const occupant = Object.values(s.pieces).find((p) => p.kind === "item")!;
    s = applyAction(s, { t: "buy", slot, place: { x: 2, y: 2, rot: 0 } });
    expect(s.pieces[occupant.uid]!.place).toBeNull();
  });
});

describe("new items in battle", () => {
  const foe = (species: string, level = 50) => team([mon(species, level, 3, 1)], "leon");

  it("Weakness Policy boosts after a super-effective hit", () => {
    const r = simulateBattle({ seed: "wp", teams: [team([mon("SNORLAX", 60, 3, 1), item("WEAKNESS_POLICY", 2, 1)]), foe("MACHAMP")] });
    const snorlax = r.initial.find((b) => b.species === "SNORLAX")!.id;
    const trigger = r.events.findIndex((e) => e.k === "item" && e.item === "WEAKNESS_POLICY" && e.src === snorlax);
    expect(trigger).toBeGreaterThan(-1);
    expect(r.events.slice(trigger).some((e) => e.k === "stage" && e.target === snorlax && e.stat === "atk" && e.delta === 2)).toBe(true);
  });

  it("an Air Balloon blocks the first Ground attack", () => {
    const r = simulateBattle({ seed: "balloon", teams: [team([mon("RAICHU", 50, 3, 1), item("AIR_BALLOON", 2, 1)]), foe("GARCHOMP")] });
    const raichu = r.initial.find((b) => b.species === "RAICHU")!.id;
    expect(r.events.some((e) => e.k === "item" && e.item === "AIR_BALLOON" && e.src === raichu)).toBe(true);
  });

  it("a resist berry is eaten on a super-effective hit of its type", () => {
    const charizard = { ...mon("CHARIZARD", 50, 3, 1), moves: ["FLAMETHROWER"] };
    const r = simulateBattle({ seed: "occa", teams: [team([mon("VENUSAUR", 50, 3, 1), item("OCCA_BERRY", 2, 1)]), team([charizard], "leon")] });
    expect(r.events.some((e) => e.k === "item" && e.item === "OCCA_BERRY")).toBe(true);
  });
});

describe("item catalog", () => {
  const bundle = (lang: string) =>
    JSON.parse(readFileSync(new URL(`../../../apps/client/public/locales/${lang}.json`, import.meta.url), "utf8")) as {
      items: Record<string, { name: string }>;
      game: { itemEffect: Record<string, string>; bag: Record<string, { name?: string; desc: string }> };
    };
  const icons = JSON.parse(readFileSync(new URL("../../../apps/client/public/assets/items-manifest.json", import.meta.url), "utf8")) as Record<string, unknown>;
  const templated = new Set(["TM", "TERA_SHARD"]);
  const familyText = (key: string) => {
    const d = ITEMS[key]!;
    if (d.family === "typeBoost") return "TYPE_BOOST";
    if (d.family === "zCrystal") return "Z_CRYSTAL";
    if (d.family === "evolution" && key !== "LINKING_CORD") return "EVOLUTION_STONE";
    if (d.mega) return "MEGA_STONE";
    if (d.family === "berry" && d.type && key !== "CHILAN_BERRY") return "RESIST_BERRY";
    return key;
  };

  for (const lang of ["ko", "en"]) {
    it(`every shop item has a ${lang} name and rules text`, () => {
      const b = bundle(lang);
      const missing: string[] = [];
      for (const d of Object.values(ITEMS)) {
        if (d.noShop) continue;
        if (!templated.has(d.key) && !b.items[d.key]?.name) missing.push(`${d.key}:name`);
        if (!b.game.itemEffect[familyText(d.key)]) missing.push(`${d.key}:effect`);
      }
      for (const [key, def] of Object.entries(BAGS)) {
        // Bags named after real items take the item's localized name.
        if (!(def.realItem ? b.items[key]?.name : b.game.bag[key]?.name)) missing.push(`${key}:bag`);
        if (!b.game.bag[key]?.desc) missing.push(`${key}:desc`);
      }
      expect(missing).toEqual([]);
    });
  }

  it("every shop item has an icon", () => {
    const missing = Object.values(ITEMS).filter((d) => !d.noShop && !["TM", "TERA_SHARD", "DYNAMAX_CANDY"].includes(d.key) && !icons[d.key]);
    expect(missing.map((d) => d.key)).toEqual([]);
    expect(Object.values(BAGS).filter((d) => d.realItem && !icons[d.key]).map((d) => d.key)).toEqual([]);
  });
});

describe("evolution comes first", () => {
  const result = { outcome: "win" as const, fainted: [], battleGold: 0, opponent: { name: "", champion: "red" as const, ghost: false } };

  it("grows into free space when it can, keeping the items", async () => {
    const { applyRoundResult, layoutIsValid } = await import("../src/index.ts");
    const charmander = mon("CHARMANDER", 15, 3, 2);
    const coal = item("CHARCOAL", 4, 2);
    const s = applyRoundResult(withPieces([charmander, coal]), result);
    expect((s.pieces[charmander.uid] as PokemonPiece).species).toBe("CHARMELEON");
    expect(s.pieces[coal.uid]!.place).toMatchObject({ x: 4, y: 2 });
    expect(layoutIsValid(s.pieces)).toBe(true);
  });

  it("otherwise grows over its spot and sends items in the way to the stash", async () => {
    const { applyRoundResult, layoutIsValid } = await import("../src/index.ts");
    const charmander = mon("CHARMANDER", 15, 3, 2);
    const coal = item("CHARCOAL", 4, 2);
    const around = [item("LEFTOVERS", 2, 2), item("MAGNET", 3, 1), item("MYSTIC_WATER", 3, 3)];
    const s = applyRoundResult(withPieces([charmander, coal, ...around]), result);
    for (const keep of around) expect(s.pieces[keep.uid]!.place).not.toBeNull();
    const evolved = s.pieces[charmander.uid] as PokemonPiece;
    expect(evolved.species).toBe("CHARMELEON");
    expect(evolved.place).toMatchObject({ x: 3, y: 2 });
    expect(s.pieces[coal.uid]!.place).toBeNull();
    expect(s.notices.some((n) => n.key === "notice.itemStashed")).toBe(true);
    expect(layoutIsValid(s.pieces)).toBe(true);
  });

  it("moves elsewhere instead of overlapping another Pokémon", async () => {
    const { applyRoundResult, layoutIsValid } = await import("../src/index.ts");
    const charmander = mon("CHARMANDER", 15, 5, 3); // right edge of the 5×3 bag
    const blockerLeft = mon("PIKACHU", 10, 4, 3);
    const s = applyRoundResult(withPieces([charmander, blockerLeft]), result);
    expect((s.pieces[charmander.uid] as PokemonPiece).species).toBe("CHARMELEON");
    expect(layoutIsValid(s.pieces)).toBe(true);
  });

  it("repairs a stored board where a Pokémon overlaps items", async () => {
    const { migrateRun, layoutIsValid } = await import("../src/index.ts");
    const s = withPieces([mon("CHARMELEON", 20, 3, 2), item("CHARCOAL", 4, 2), item("LEFTOVERS", 2, 2)]);
    expect(layoutIsValid(s.pieces)).toBe(false);
    const fixed = migrateRun(s);
    expect(layoutIsValid(fixed.pieces)).toBe(true);
    expect(Object.values(fixed.pieces).find((p) => p.kind === "item" && p.item === "CHARCOAL")!.place).toBeNull();
    expect(Object.values(fixed.pieces).find((p) => p.kind === "item" && p.item === "LEFTOVERS")!.place).not.toBeNull();
  });
});

describe("evolution with no room at all", () => {
  it("still evolves and moves the Pokémon to the stash", async () => {
    const { applyRoundResult, layoutIsValid } = await import("../src/index.ts");
    // A 1×2 pouch holds Charmander; everything around it is off-bag, so a 2×1 Charmeleon cannot fit.
    const s0 = createRun({ runId: "r", seed: "s", playerName: "p", champion: "red" });
    const pouch: Piece = { uid: "pouch", kind: "bag", place: { x: 0, y: 0, rot: 1 }, paid: 0, bag: "BAG_1X2" };
    const charmander = mon("CHARMANDER", 15, 0, 0);
    const pikachu = mon("PIKACHU", 10, 0, 1);
    s0.pieces = { [pouch.uid]: pouch, [charmander.uid]: charmander, [pikachu.uid]: pikachu };
    const s = applyRoundResult(s0, { outcome: "win", fainted: [], battleGold: 0, opponent: { name: "", champion: "red", ghost: false } });
    const evolved = s.pieces[charmander.uid] as PokemonPiece;
    expect(evolved.species).toBe("CHARMELEON");
    expect(evolved.place).toBeNull();
    expect(evolved.pendingEvolution).toBeNull();
    expect(s.notices.some((n) => n.key === "notice.evolvedToStash")).toBe(true);
    expect(layoutIsValid(s.pieces)).toBe(true);
  });
});

describe("rotating big items", () => {
  const board = (item: ItemPiece): RunState => {
    const base = createRun({ runId: "rot", seed: "rot", playerName: "t", champion: "red" });
    return {
      ...base,
      pieces: { bag: { uid: "bag", kind: "bag", place: { x: 6, y: 4, rot: 0 }, paid: 0, bag: "BAG_3X3" }, [item.uid]: item },
    };
  };

  it("turns around its centre and slides back onto the board at the edge", () => {
    // Upright 2×1 plate in the last column: turning it on the spot would stick out past x = 8.
    const plate: ItemPiece = { uid: "plate", kind: "item", place: { x: 8, y: 4, rot: 1 }, paid: 0, item: "FLAME_PLATE", age: 0 };
    const state = board(plate);
    expect(() => applyAction(state, { t: "move", uid: "plate", place: { x: 8, y: 4, rot: 2 } })).toThrow();
    const spot = rotationSpot(state, "plate");
    expect(spot).toMatchObject({ x: 7, rot: 2 });
    expect(() => applyAction(state, { t: "move", uid: "plate", place: spot! })).not.toThrow();
  });

  it("still finds a spot while something waits in the stash", () => {
    const plate: ItemPiece = { uid: "plate", kind: "item", place: { x: 8, y: 4, rot: 1 }, paid: 0, item: "FLAME_PLATE", age: 0 };
    const state = board(plate);
    state.pieces.stashed = { uid: "stashed", kind: "item", place: null, paid: 0, item: "LEFTOVERS", age: 0 };
    expect(rotationSpot(state, "plate")).toMatchObject({ x: 7, rot: 2 });
  });

  it("does not push other pieces aside to make room", () => {
    const plate: ItemPiece = { uid: "plate", kind: "item", place: { x: 8, y: 4, rot: 1 }, paid: 0, item: "FLAME_PLATE", age: 0 };
    const state = board(plate);
    const blockers = ["LEFTOVERS", "LIFE_ORB", "SHELL_BELL", "MUSCLE_BAND", "WISE_GLASSES", "EXPERT_BELT", "SCOPE_LENS"];
    const cells = [[6, 4], [7, 4], [6, 5], [7, 5], [6, 6], [7, 6], [8, 6]];
    cells.forEach(([x, y], i) => {
      state.pieces[`b${i}`] = { uid: `b${i}`, kind: "item", place: { x: x!, y: y!, rot: 0 }, paid: 0, item: blockers[i]!, age: 0 };
    });
    expect(rotationSpot(state, "plate")).toBeNull();
  });
});


describe("bags that work on the items lying on them", () => {
  // withPieces: the 5×3 bag covers x 1–5, y 1–3. These bags go under it at y 4.
  const bagAt = (key: string, x: number): Piece => ({ uid: `bag-${key}`, kind: "bag", place: { x, y: 4, rot: 0 }, paid: 0, bag: key });
  const legacyBag: Piece = { uid: "bag", kind: "bag", place: { x: 1, y: 1, rot: 0 }, paid: 0, bag: "BAG_START_LEGACY" };
  const result = { outcome: "win" as const, fainted: [], battleGold: 0, opponent: { name: "", champion: "red" as const, ghost: false } };

  it("a Berry Pouch marks the berries on it for the Pokémon they touch", async () => {
    const { buildSide } = await import("../src/battle/setup.ts");
    const snorlax = mon("SNORLAX", 50, 2, 2); // 2×2: x 2–3, y 2–3
    const onPouch = item("SITRUS_BERRY", 2, 4);
    const offPouch = item("SITRUS_BERRY", 1, 2);
    const { battlers } = buildSide(team([legacyBag, bagAt("BERRY_POUCH", 1), snorlax, onPouch, offPouch]), 0, 0);
    expect(battlers[0]!.items.uses.get("SITRUS_BERRY")).toBe(2);
    expect(battlers[0]!.items.pouched.get("SITRUS_BERRY")).toBe(1);
  });

  it("a berry on the Berry Pouch is sometimes eaten again; one off it never is", () => {
    const sitrusEaten = (pouch: boolean, seed: string) => {
      const pieces = [legacyBag, mon("SNORLAX", 60, 2, 2), item("SITRUS_BERRY", 2, 4)];
      if (pouch) pieces.push(bagAt("BERRY_POUCH", 1));
      const r = simulateBattle({ seed, teams: [team(pieces), team([mon("MACHAMP", 55, 3, 1)], "leon")] });
      return r.events.filter((e) => e.k === "item" && e.item === "SITRUS_BERRY").length;
    };
    const seeds = Array.from({ length: 12 }, (_, i) => `pouch${i}`);
    expect(Math.max(...seeds.map((s) => sitrusEaten(false, s)))).toBe(1);
    expect(Math.max(...seeds.map((s) => sitrusEaten(true, s)))).toBeGreaterThan(1);
  });

  it("a Candy Jar adds levels to the Rare Candy on it", async () => {
    const { prepareForBattle, CANDY_JAR_EXTRA_LEVELS, RARE_CANDY_LEVELS } = await import("../src/index.ts");
    const level = (jar: boolean) => {
      const pika = mon("PIKACHU", 20, 2, 3);
      const s = withPieces([pika, item("RARE_CANDY", 2, 4)]);
      s.pieces["jar"] = { ...bagAt(jar ? "CANDY_JAR" : "BAG_1X2", 2), uid: "jar" };
      return (prepareForBattle(s).pieces[pika.uid] as PokemonPiece).level;
    };
    expect(level(false)).toBe(20 + RARE_CANDY_LEVELS);
    expect(level(true)).toBe(20 + RARE_CANDY_LEVELS + CANDY_JAR_EXTRA_LEVELS);
  });

  it("a Coin Case raises the win gold of an Amulet Coin on it", async () => {
    const { buildSide } = await import("../src/battle/setup.ts");
    const coins = (bag: string) => {
      const pieces = [legacyBag, bagAt(bag, 2), mon("PIKACHU", 20, 2, 3), item("AMULET_COIN", 2, 4)];
      return buildSide(team(pieces), 0, 0).state.amuletCoins;
    };
    expect(coins("BAG_1X2")).toBe(1);
    expect(coins("COIN_CASE")).toBe(2);
  });

  it("a nugget on a Coin Case gains extra sell value each round", async () => {
    const { applyRoundResult, sellValue } = await import("../src/index.ts");
    const s = withPieces([mon("PIKACHU", 20, 2, 3)]);
    s.champion = "steven";
    const onCase: ItemPiece = { ...item("NUGGET", 2, 4), paid: 3 };
    const offCase: ItemPiece = { ...item("NUGGET", 4, 3), paid: 3 };
    s.pieces["case"] = { ...bagAt("COIN_CASE", 2), uid: "case" };
    s.pieces[onCase.uid] = onCase;
    s.pieces[offCase.uid] = offCase;
    const next = applyRoundResult(s, result);
    expect(sellValue(next, next.pieces[offCase.uid]!)).toBe(3 + 1);
    expect(sellValue(next, next.pieces[onCase.uid]!)).toBe(3 + 1 + 1);
  });

  it("old runs get their Berry Pouch item refunded, and one on offer becomes the bag", async () => {
    const { migrateRun } = await import("../src/index.ts");
    const s = withPieces([mon("PIKACHU", 20, 2, 3), { ...item("BERRY_POUCH", 3, 3), paid: 3 }]);
    (s as { v: number }).v = 4;
    s.gold = 5;
    s.shop[0] = { offer: { kind: "item", tier: 2, item: "BERRY_POUCH" }, locked: true, sale: false };
    const migrated = migrateRun(s);
    expect(Object.values(migrated.pieces).some((p) => p.kind === "item" && p.item === "BERRY_POUCH")).toBe(false);
    expect(migrated.gold).toBe(8);
    expect(migrated.shop[0]!.offer).toEqual({ kind: "bag", tier: 2, bag: "BERRY_POUCH" });
    expect(migrated.notices.some((n) => n.key === "notice.berryPouchRefund")).toBe(true);
  });
});
