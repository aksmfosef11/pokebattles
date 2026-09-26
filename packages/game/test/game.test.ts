import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyAction,
  CHAMPION_KEYS,
  CONTENT,
  createRun,
  IMPLEMENTED_ABILITY_KEYS,
  MemoryStore,
  playRound,
  prepareForBattle,
  rngFor,
  rotateShape,
  simulateBattle,
  snapshotTeam,
  startRun,
  botTeam,
  migrateRun,
  newPokemon,
  rollTraits,
  partyCap,
  CHAMPION_RULES,
  BOARD_H,
  cellsOf,
  RUN_STATE_VERSION,
  type RunState,
} from "../src/index.ts";

function run(champion: (typeof CHAMPION_KEYS)[number] = "red", seed = "seed-1"): RunState {
  return createRun({ runId: "r1", seed, playerName: "tester", champion });
}

describe("rng", () => {
  it("is deterministic per seed and label", () => {
    const a = rngFor("s", "x");
    const b = rngFor("s", "x");
    const c = rngFor("s", "y");
    const seqA = [a.nextU32(), a.nextU32(), a.nextU32()];
    expect([b.nextU32(), b.nextU32(), b.nextU32()]).toEqual(seqA);
    expect(c.nextU32()).not.toBe(seqA[0]);
  });
});

describe("board", () => {
  it("rotates an L shape clockwise", () => {
    const L = [
      { x: 0, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
    ];
    expect(rotateShape(L, 1)).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
    ]);
    expect(rotateShape(L, 0)).toEqual(L);
  });
});

describe("run", () => {
  it("starts every champion with a placed starter and its item", () => {
    for (const champion of CHAMPION_KEYS) {
      const species = { red: "PIKACHU", leon: "CHARMANDER", alder: "NINCADA", lance: "DRATINI" } as Record<string, string>;
      if (!species[champion]) continue;
      const s = run(champion);
      const mons = Object.values(s.pieces).filter((p) => p.kind === "pokemon");
      expect(mons).toHaveLength(1);
      expect(mons[0]!.place).not.toBeNull();
      expect(Object.values(s.pieces).some((p) => p.kind === "item" && p.place)).toBe(true);
      expect(s.shop).toHaveLength(5);
    }
  });

  it("buys, moves, rerolls and sells", () => {
    let s = run();
    s = { ...s, gold: 50 };
    const slot = s.shop.findIndex((x) => x.offer && x.offer.kind !== "bag");
    s = applyAction(s, { t: "buy", slot });
    const bought = Object.values(s.pieces).find((p) => p.place === null)!;
    expect(bought).toBeDefined();
    s = applyAction(s, { t: "move", uid: bought.uid, place: { x: 3, y: 2, rot: 0 } });
    expect(s.pieces[bought.uid]!.place).toEqual({ x: 3, y: 2, rot: 0 });
    const before = s.shop.map((x) => JSON.stringify(x.offer));
    s = applyAction(s, { t: "reroll" });
    expect(s.shop.map((x) => JSON.stringify(x.offer))).not.toEqual(before);
    const gold = s.gold;
    s = applyAction(s, { t: "sell", uid: bought.uid });
    expect(s.gold).toBeGreaterThanOrEqual(gold);
    expect(s.pieces[bought.uid]).toBeUndefined();
  });

  it("rejects placing outside a bag", () => {
    const s = run();
    const mon = Object.values(s.pieces).find((p) => p.kind === "pokemon")!;
    expect(() => applyAction(s, { t: "move", uid: mon.uid, place: { x: 0, y: 0, rot: 0 } })).toThrow("no_bag");
  });
});

describe("party and board", () => {
  it("caps the party at 6 on the board but lets extras wait in the stash", () => {
    for (const [champion, cap] of [["red", 6], ["alder", 6]] as const) {
      let s = run(champion, `cap-${champion}`);
      // A second 3×3 bag next to the starting one gives room for 8+ Pokémon.
      s = { ...s, nextUid: s.nextUid + 1, pieces: { ...s.pieces, extra: { uid: "extra", kind: "bag", place: { x: 6, y: 2, rot: 0 }, paid: 0, bag: "BAG_3X3" } } };
      const cells = [];
      for (let y = 2; y < 5; y++) for (let x = 3; x < 9; x++) cells.push({ x, y });
      let placed = 1;
      for (let i = 0; i < 12; i++) {
        const species = i % 2 === 0 ? "PIKACHU" : "EEVEE";
        const uid = `u${s.nextUid}`;
        s = {
          ...s,
          nextUid: s.nextUid + 1,
          pieces: { ...s.pieces, [uid]: { ...newPokemon(uid, species, 10, rollTraits(species, rngFor("x", i)), 3, 4) } },
        };
        const free = cells.find((c) => !Object.values(s.pieces).some((p) => p.place && p.place.x === c.x && p.place.y === c.y));
        if (!free) break;
        if (placed < cap) {
          s = applyAction(s, { t: "move", uid, place: { ...free, rot: 0 } });
          placed++;
        } else {
          expect(() => applyAction(s, { t: "move", uid, place: { ...free, rot: 0 } })).toThrow("party_full");
          break;
        }
      }
      expect(Object.values(s.pieces).filter((p) => p.kind === "pokemon" && p.place).length).toBe(cap);
    }
  });

  it("grows the party cap over the run (6 → 9)", () => {
    expect([1, 4, 5, 7, 8, 10, 11, 14].map((round) => partyCap({ champion: "red", round }))).toEqual([6, 6, 7, 7, 8, 8, 9, 9]);
    expect(partyCap({ champion: "alder", round: 11 })).toBe(9 + CHAMPION_RULES.alder.partyCapBonus);
  });

  it("keeps Alder's extra party slot (when the rules give one) for a 1×1 Pokémon", () => {
    const rules = CHAMPION_RULES.alder as { partyCapBonus: number };
    const saved = rules.partyCapBonus;
    rules.partyCapBonus = 1;
    const base = run("alder", "alder-big");
    const pieces: RunState["pieces"] = {};
    [[0, 0], [3, 0], [6, 0], [0, 3], [3, 3], [6, 3]].forEach(([x, y], i) => {
      pieces[`bag${i}`] = { uid: `bag${i}`, kind: "bag", place: { x: x!, y: y!, rot: 0 }, paid: 0, bag: "BAG_3X3" };
    });
    let s: RunState = { ...base, pieces, nextUid: 100 };
    const add = (species: string, x: number, y: number) => {
      const uid = `u${s.nextUid}`;
      s = { ...s, nextUid: s.nextUid + 1, pieces: { ...s.pieces, [uid]: newPokemon(uid, species, 10, rollTraits(species, rngFor("b", uid)), 3, 4) } };
      return () => applyAction(s, { t: "move", uid, place: { x, y, rot: 0 } });
    };
    // Six 2×1 Pokémon fill the normal party size.
    for (const [x, y] of [[0, 0], [2, 0], [4, 0], [6, 0], [0, 1], [2, 1]] as const) s = add("DRATINI", x, y)();
    expect(add("DRATINI", 4, 1)).toThrow("party_full_big");
    s = add("PIKACHU", 6, 1)();
    expect(add("PIKACHU", 7, 1)).toThrow("party_full");
    rules.partyCapBonus = saved;
  });

  it("migrates v1 runs: shifted onto the 9×6 board and given their old 5×3 starting bag", () => {
    const s = run();
    const v1 = structuredClone(s) as unknown as { v: number; pieces: Record<string, { kind: string; place: { x: number; y: number } | null }> };
    v1.v = 1;
    for (const [k, p] of Object.entries(v1.pieces)) {
      if (p.kind === "bag") delete v1.pieces[k];
      else if (p.place) p.place = { ...p.place, x: p.place.x - 1, y: p.place.y - 1 };
    }
    const migrated = migrateRun(v1 as unknown as RunState);
    expect(migrated.v).toBe(RUN_STATE_VERSION);
    const bags = Object.values(migrated.pieces).filter((p) => p.kind === "bag");
    expect(bags).toEqual([expect.objectContaining({ bag: "BAG_START_LEGACY", place: { x: 2, y: 2, rot: 0 } })]);
    for (const p of Object.values(s.pieces)) if (p.kind !== "bag") expect(migrated.pieces[p.uid]).toEqual(p);
  });

  it("migrates v3 runs onto the 9×6 board: up one row when the front row is empty", () => {
    const s = run();
    const v3 = structuredClone(s) as unknown as RunState;
    (v3 as { v: number }).v = 3;
    // A bag on the old 7th row (y = 6).
    v3.pieces.low = { uid: "low", kind: "bag", place: { x: 3, y: 6, rot: 0 }, paid: 0, bag: "BAG_1X2" };
    for (const p of Object.values(v3.pieces)) if (p.place && p.uid !== "low") p.place = { ...p.place, y: p.place.y + 1 };
    const migrated = migrateRun(v3);
    expect(migrated.v).toBe(RUN_STATE_VERSION);
    expect(migrated.pieces.low!.place).toEqual({ x: 3, y: 5, rot: 0 });
    for (const p of Object.values(s.pieces)) expect(migrated.pieces[p.uid]!.place).toEqual(p.place);
  });

  it("migrates v3 runs with a full front row by moving the bags on the lost row", () => {
    const s = run();
    const v3 = structuredClone(s) as unknown as RunState;
    (v3 as { v: number }).v = 3;
    v3.pieces.front = { uid: "front", kind: "bag", place: { x: 0, y: 0, rot: 0 }, paid: 0, bag: "BAG_1X3" };
    v3.pieces.low = { uid: "low", kind: "bag", place: { x: 0, y: 6, rot: 0 }, paid: 0, bag: "BAG_1X3" };
    const migrated = migrateRun(v3);
    const low = migrated.pieces.low!;
    expect(low.place).not.toBeNull();
    expect(cellsOf(low).every((c) => c.y < BOARD_H)).toBe(true);
  });

  it("moves and rotates the starting bag with everything on it", () => {
    let s = run("leon");
    const bag = Object.values(s.pieces).find((p) => p.kind === "bag")!;
    const mon = Object.values(s.pieces).find((p) => p.kind === "pokemon")!;
    const band = Object.values(s.pieces).find((p) => p.kind === "item")!;
    expect(bag.place).toEqual({ x: 3, y: 2, rot: 0 });
    expect(mon.place).toEqual({ x: 4, y: 2, rot: 0 });
    expect(band.place).toEqual({ x: 4, y: 3, rot: 0 });
    // Slide to the front-left corner.
    s = applyAction(s, { t: "move", uid: bag.uid, place: { x: 0, y: 0, rot: 0 } });
    expect(s.pieces[mon.uid]!.place).toEqual({ x: 1, y: 0, rot: 0 });
    expect(s.pieces[band.uid]!.place).toEqual({ x: 1, y: 1, rot: 0 });
    // Rotate a quarter turn clockwise in place: the top-middle cell goes to the right-middle.
    s = applyAction(s, { t: "move", uid: bag.uid, place: { x: 0, y: 0, rot: 1 } });
    expect(s.pieces[mon.uid]!.place).toMatchObject({ x: 2, y: 1 });
    expect(s.pieces[band.uid]!.place).toMatchObject({ x: 1, y: 1 });
    expect(() => applyAction(s, { t: "sell", uid: bag.uid })).toThrow("cannot_sell");
  });

  it("refuses to move a bag when a Pokémon also rests on another bag", () => {
    let s = run("red");
    const bag = Object.values(s.pieces).find((p) => p.kind === "bag")!;
    s = { ...s, pieces: { ...s.pieces, side: { uid: "side", kind: "bag", place: { x: 6, y: 2, rot: 0 }, paid: 2, bag: "BAG_1X2" } } };
    const big = newPokemon("big", "SNORLAX", 20, rollTraits("SNORLAX", rngFor("snorlax")), 3, 4);
    big.place = { x: 5, y: 3, rot: 0 };
    s.pieces = { ...s.pieces, [big.uid]: big, side2: { uid: "side2", kind: "bag", place: { x: 6, y: 3, rot: 0 }, paid: 2, bag: "BAG_1X2" } };
    expect(() => applyAction(s, { t: "move", uid: bag.uid, place: { x: 0, y: 0, rot: 0 } })).toThrow("bag_straddled");
  });

  it("offers a bag in the opening shop of the first rounds", () => {
    for (let i = 0; i < 20; i++) {
      const s = run("red", `bag-${i}`);
      expect(s.shop.some((slot) => slot.offer?.kind === "bag")).toBe(true);
    }
  });
});

describe("battle", () => {
  const a = snapshotTeam(prepareForBattle(run("red", "a")));
  const b = snapshotTeam(prepareForBattle(run("leon", "b")));

  it("is deterministic and ends", () => {
    const r1 = simulateBattle({ seed: "battle", teams: [a, b] }, { recordFrames: true });
    const r2 = simulateBattle({ seed: "battle", teams: [a, b] }, { recordFrames: true });
    expect(r1.events).toEqual(r2.events);
    expect(r1.events.at(-1)!.k).toBe("end");
    expect(r1.frames.length).toBe(r1.ticks + 1);
    for (const f of r1.frames) for (const hp of f.hp) expect(Number.isFinite(hp)).toBe(true);
  });

  it("fights bot teams from late rounds without errors", () => {
    for (let i = 0; i < 6; i++) {
      const x = botTeam(`x${i}`, 4 + i * 2);
      const y = botTeam(`y${i}`, 4 + i * 2);
      const r = simulateBattle({ seed: `late${i}`, teams: [x, y] });
      expect(r.events.at(-1)!.k).toBe("end");
    }
  });
});

describe("server logic", () => {
  it("plays rounds against bots and then against stored ghosts", async () => {
    const store = new MemoryStore();
    let s1 = await startRun(store, { playerId: "p1", playerName: "one", champion: "red" });
    const t1 = await playRound(store, { playerId: "p1", runId: s1.runId, round: 1, actions: [] });
    expect(t1.battle.opponent.ghost).toBe(false);
    expect(t1.state.round).toBe(2);
    s1 = t1.state;
    const s2 = await startRun(store, { playerId: "p2", playerName: "two", champion: "leon" });
    const t2 = await playRound(store, { playerId: "p2", runId: s2.runId, round: 1, actions: [] });
    expect(t2.battle.opponent.ghost).toBe(true);
    expect(t2.battle.opponent.name).toBe("one");
    // The client replays the same battle for playback.
    const replay = simulateBattle({ seed: t2.battle.seed, teams: t2.battle.teams });
    const expected = replay.winner === 0 ? "win" : replay.winner === 1 ? "loss" : "draw";
    expect(expected).toBe(t2.battle.outcome);
    await expect(playRound(store, { playerId: "p2", runId: s1.runId, round: 2, actions: [] })).rejects.toThrow("run_not_found");
  });
});

describe("content", () => {
  it("references every implemented ability in the simulator", () => {
    const sim = ["sim.ts", "setup.ts"].map((f) => readFileSync(new URL(`../src/battle/${f}`, import.meta.url), "utf8")).join("\n");
    const missing = IMPLEMENTED_ABILITY_KEYS.filter((k) => !sim.includes(`"${k}"`) && !sim.includes(`${k}:`));
    expect(missing).toEqual([]);
  });

  it("only uses move keys that exist", () => {
    for (const s of Object.values(CONTENT.species)) {
      for (const [, m] of s.learnset) expect(CONTENT.moves[m], `${s.key} ${m}`).toBeDefined();
    }
  });
});
