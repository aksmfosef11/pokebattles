import { describe, expect, it } from "vitest";
import {
  applyAction,
  BattleSim,
  CHOICE_BOOST,
  choicePicks,
  previewChoicePicks,
  createRun,
  findRecipe,
  newPokemon,
  rngFor,
  rollTraits,
  simulateBattle,
  SUDDEN_DEATH_TICK,
  TIMED_ITEMS,
  type BattleEvent,
  type ItemPiece,
  type Piece,
  type PokemonPiece,
  type RunState,
  type TeamSnapshot,
} from "../src/index.ts";

let uid = 0;
function mon(species: string, x: number, y: number, extra: Partial<PokemonPiece> = {}): PokemonPiece {
  const p = newPokemon(`m${uid++}`, species, 50, rollTraits(species, rngFor("bi", species, uid)), 0, 4);
  p.place = { x, y, rot: 0 };
  return { ...p, moves: ["GROWL"], ...extra };
}
function item(key: string, x: number, y: number): ItemPiece {
  return { uid: `i${uid++}`, kind: "item", place: { x, y, rot: 0 }, paid: 0, item: key, age: 0 };
}
function team(pieces: Piece[]): TeamSnapshot {
  return { name: "t", champion: "red", subclass: null, round: 10, wins: 0, losses: 0, streak: 0, ace: null, pieces };
}
/** A bulky opponent that never hurts anyone, so the fight runs until sudden death. */
const harmless = () => team([mon("BLISSEY", 3, 1, { ability: "NATURAL_CURE" })]);
const itemEvents = (events: BattleEvent[], key: string) => events.filter((e): e is Extract<BattleEvent, { k: "item" }> => e.k === "item" && e.item === key);

describe("battle items on a timer", () => {
  it("X items raise a stage of every Pokémon they touch on each cooldown, a set number of times", () => {
    const def = TIMED_ITEMS.X_ATTACK!;
    // Ids follow board order: holder 0, Contrary 1, Klutz 2, far away 3.
    const r = simulateBattle({
      seed: "x-attack",
      teams: [
        team([
          mon("PIKACHU", 3, 1),
          mon("PIKACHU", 2, 2, { ability: "CONTRARY" }),
          mon("PIKACHU", 4, 2, { ability: "KLUTZ" }),
          mon("PIKACHU", 7, 4),
          item("X_ATTACK", 3, 2),
        ]),
        team([mon("BLISSEY", 3, 1, { moves: ["POUND"] })]),
      ],
    });
    const boosts = r.events.filter((e) => e.k === "stage" && e.stat === "atk" && e.delta > 0);
    expect(boosts.map((e) => e.k === "stage" && e.target)).toEqual([0, 0]);
    const uses = itemEvents(r.events, "X_ATTACK");
    expect(uses.map((e) => [e.src, e.t])).toEqual(
      Array.from({ length: def.uses }, (_, i) => [0, (i + 1) * def.every * 10]),
    );
  });

  it("a Potion heals the most hurt Pokémon it touches", () => {
    const sim = new BattleSim({ seed: "potion", teams: [team([mon("PIKACHU", 3, 1), mon("PIKACHU", 3, 3), item("POTION", 3, 2)]), harmless()] }, {});
    const [a, b] = sim.battlers;
    a!.hp = Math.floor(a!.maxHp * 0.5);
    b!.hp = Math.floor(b!.maxHp * 0.75);
    const r = sim.run();
    const heals = r.events.filter((e) => e.k === "heal" && e.cause === "item");
    const every = TIMED_ITEMS.POTION!.every * 10;
    // 50% and 75%: the first goes to 80%, then the second (75%) is the most hurt, then the first again.
    expect(heals.map((e) => e.k === "heal" && [e.target, e.t])).toEqual([
      [0, every],
      [1, 2 * every],
      [0, 3 * every],
    ]);
  });

  it("a Potion waits for someone to be hurt", () => {
    const r = simulateBattle({ seed: "potion-wait", teams: [team([mon("PIKACHU", 3, 1), item("POTION", 3, 2)]), harmless()] });
    const first = itemEvents(r.events, "POTION")[0];
    expect(first).toBeDefined();
    expect(first!.t).toBeGreaterThanOrEqual(SUDDEN_DEATH_TICK);
  });

  it("two touching Potions make a Super Potion", () => {
    expect(findRecipe("POTION", "POTION")?.output).toBe("SUPER_POTION");
  });
});

describe("status orbs", () => {
  it("only work on a Pokémon that gains from the status, leaving its neighbours alone", () => {
    const r = simulateBattle({
      seed: "flame-orb",
      teams: [team([mon("PIKACHU", 3, 1, { ability: "GUTS" }), mon("PIKACHU", 3, 3, { ability: "STATIC" }), item("FLAME_ORB", 3, 2)]), harmless()],
    });
    expect(r.events.filter((e) => e.k === "status").map((e) => e.k === "status" && [e.target, e.status])).toEqual([[0, "brn"]]);
    expect(itemEvents(r.events, "FLAME_ORB").map((e) => e.src)).toEqual([0]);
  });

  it("Toxic Orb gives plain poison, and steps in when the Flame Orb cannot burn", () => {
    const r = simulateBattle({
      seed: "toxic-orb",
      teams: [team([mon("FLAREON", 3, 1, { ability: "GUTS" }), item("FLAME_ORB", 3, 2), item("TOXIC_ORB", 2, 1)]), harmless()],
    });
    const statuses = r.events.filter((e) => e.k === "status");
    expect(statuses[0]).toMatchObject({ target: 0, status: "psn", stacks: 1 });
    expect(statuses.some((e) => e.k === "status" && e.status === "tox")).toBe(false);
    expect(itemEvents(r.events, "FLAME_ORB")).toHaveLength(0);
    expect(itemEvents(r.events, "TOXIC_ORB")).toHaveLength(1);
  });
});

describe("Choice items", () => {
  // The band touches both: Pikachu above its right cell, Machamp to its right.
  const board = () => {
    const pikachu = mon("PIKACHU", 3, 1, { moves: ["THUNDER_WAVE", "THUNDERBOLT", "QUICK_ATTACK", "IRON_TAIL"] });
    const machamp = mon("MACHAMP", 4, 2, { moves: ["GROWL", "TACKLE", "CLOSE_COMBAT", "EARTHQUAKE"] });
    return { pikachu, machamp, band: item("CHOICE_BAND", 2, 2) };
  };

  it("power the strongest Pokémon they touch, locked into its strongest STAB attack, unless the player picks", () => {
    const { pikachu, machamp, band } = board();
    const pieces = Object.fromEntries([pikachu, machamp, band].map((p) => [p.uid, p]));
    let picks = choicePicks(pieces);
    expect(picks.holder.get(band.uid)).toBe(machamp.uid);
    expect(picks.lock.get(machamp.uid)).toBe("CLOSE_COMBAT");
    picks = choicePicks({ ...pieces, [band.uid]: { ...band, choiceFor: pikachu.uid }, [pikachu.uid]: { ...pikachu, choiceMove: "QUICK_ATTACK" } });
    expect(picks.holder.get(band.uid)).toBe(pikachu.uid);
    expect(picks.lock.get(pikachu.uid)).toBe("QUICK_ATTACK");
    // A pick that no longer fits (a move it forgot, or a special move under a Band) falls back to the default.
    for (const move of ["SURF", "THUNDERBOLT"]) {
      picks = choicePicks({ ...pieces, [band.uid]: { ...band, choiceFor: pikachu.uid }, [pikachu.uid]: { ...pikachu, choiceMove: move } });
      expect(picks.lock.get(pikachu.uid)).toBe("IRON_TAIL");
    }
  });

  it("stay idle when nothing they touch has an attack of their kind", () => {
    const { machamp } = board();
    const specs = item("CHOICE_SPECS", 2, 2);
    const sim = new BattleSim({ seed: "idle", teams: [team([{ ...machamp, moves: ["CLOSE_COMBAT", "TACKLE"] }, specs]), harmless()] }, {});
    expect(sim.battlers[0]!.choiceLock).toBeNull();
    expect(sim.battlers[0]!.items.counts.has("CHOICE_SPECS")).toBe(false);
  });

  it("boost only that Pokémon, which keeps to its move (even into an immune target) until the PP runs out", () => {
    const { pikachu, machamp, band } = board();
    // A Ghost that only growls: Close Combat cannot touch it, so the fight lasts.
    const ghost = () => team([mon("GENGAR", 3, 1, { ability: "NATURAL_CURE" })]);
    const plain = new BattleSim({ seed: "cb", teams: [team([pikachu, machamp]), ghost()] }, {});
    const sim = new BattleSim({ seed: "cb", teams: [team([pikachu, machamp, band]), ghost()] }, {});
    expect(sim.battlers[1]!.stats.atk).toBeCloseTo(plain.battlers[1]!.stats.atk * CHOICE_BOOST, 5);
    expect(sim.battlers[0]!.stats.atk).toBeCloseTo(plain.battlers[0]!.stats.atk, 5);
    expect(sim.battlers[0]!.choiceLock).toBeNull();
    const used = sim.run().events.filter((e) => e.k === "move" && e.src === 1).map((e) => e.k === "move" && e.move);
    const pp = 5;
    expect(used.slice(0, pp)).toEqual(Array(pp).fill("CLOSE_COMBAT"));
    expect(used.length).toBeGreaterThan(pp);
    expect(used.slice(pp)).not.toContain("CLOSE_COMBAT");
  });

  it("can be set against a previewed champion's main types", () => {
    const { pikachu, machamp, band } = board();
    const picksAgainst = (champion: "red" | "diantha") => {
      const t = previewChoicePicks(team([pikachu, machamp, band]), champion);
      return choicePicks(Object.fromEntries(t.pieces.map((p) => [p.uid, p])));
    };
    // Close Combat hits Red's Normal types; against Diantha's Fairy and Psychic, Earthquake is the better lock.
    expect(picksAgainst("red").lock.get(machamp.uid)).toBe("CLOSE_COMBAT");
    expect(picksAgainst("diantha").holder.get(band.uid)).toBe(machamp.uid);
    expect(picksAgainst("diantha").lock.get(machamp.uid)).toBe("EARTHQUAKE");
  });

  it("take the pick of a touching Pokémon and one of its attacks", () => {
    const { pikachu, machamp, band } = board();
    const far = mon("PIKACHU", 1, 3, { moves: ["THUNDERBOLT"] });
    const s = createRun({ runId: "choice", seed: "choice", playerName: "t", champion: "red" });
    const bag: Piece = { uid: "bag", kind: "bag", place: { x: 1, y: 1, rot: 0 }, paid: 0, bag: "BAG_START_LEGACY" };
    const state: RunState = { ...s, pieces: Object.fromEntries([bag, pikachu, machamp, band, far].map((p) => [p.uid, p])) };
    const next = applyAction(state, { t: "choice", uid: band.uid, target: pikachu.uid, move: "IRON_TAIL" });
    expect(choicePicks(next.pieces).holder.get(band.uid)).toBe(pikachu.uid);
    expect(choicePicks(next.pieces).lock.get(pikachu.uid)).toBe("IRON_TAIL");
    for (const move of ["THUNDER_WAVE", "THUNDERBOLT"]) {
      expect(() => applyAction(state, { t: "choice", uid: band.uid, target: pikachu.uid, move })).toThrow("invalid_move");
    }
    expect(() => applyAction(state, { t: "choice", uid: band.uid, target: far.uid, move: "THUNDERBOLT" })).toThrow("invalid_target");
    expect(() => applyAction(state, { t: "choice", uid: pikachu.uid, target: machamp.uid, move: "TACKLE" })).toThrow("not_choice");
  });
});
