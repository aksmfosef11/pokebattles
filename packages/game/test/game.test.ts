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
  applyActions,
  battleLog,
  loadRun,
  PREVIEW_BATTLES,
  publicState,
  offerKey,
  replayShop,
  slotPrice,
  shopSize,
  BIG_BAG_ROUND,
  BIG_BAGS,
  basePartyCap,
  rollShop,
  applyRoundResult,
  CHAMPIONS,
  championPool,
  getSpecies,
  TYPES,
  layoutIsValid,
  rotationSpot,
  type Action,
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

  it("moves bags linked by a Pokémon resting on both as one, whichever bag is grabbed", () => {
    const s = run("red");
    const [start, mon, item] = ["u1", "u2", "u3"];
    // Snorlax (3×2) spans the starting bag's right column and a 3×2 bag beside it.
    const big = newPokemon("big", "SNORLAX", 20, rollTraits("SNORLAX", rngFor("snorlax")), 3, 4);
    big.place = { x: 5, y: 3, rot: 0 };
    s.pieces = {
      ...s.pieces,
      side: { uid: "side", kind: "bag", place: { x: 6, y: 3, rot: 0 }, paid: 5, bag: "BAG_2X3" },
      far: { uid: "far", kind: "bag", place: { x: 0, y: 5, rot: 0 }, paid: 2, bag: "BAG_1X2" },
      big,
    };
    expect(layoutIsValid(s.pieces)).toBe(true);
    for (const grab of [start, "side"]) {
      const after = applyAction(s, { t: "move", uid: grab, place: { x: 0, y: 0, rot: 0 } });
      expect(after.pieces[start]!.place).toEqual({ x: 0, y: 0, rot: 0 });
      expect(after.pieces.side!.place).toEqual({ x: 3, y: 1, rot: 0 });
      expect(after.pieces.big!.place).toEqual({ x: 2, y: 1, rot: 0 });
      expect(after.pieces[mon]!.place).toEqual({ x: 1, y: 0, rot: 0 });
      expect(after.pieces[item]!.place).toEqual({ x: 1, y: 1, rot: 0 });
      expect(after.pieces.far!.place).toEqual({ x: 0, y: 5, rot: 0 });
      expect(layoutIsValid(after.pieces)).toBe(true);
    }
    // The joint footprint may not land on a bag outside the group.
    expect(() => applyAction(s, { t: "move", uid: start, place: { x: 0, y: 3, rot: 0 } })).toThrow("bag_overlap");
  });

  it("moves and turns a chain of three linked bags together", () => {
    let s = run("red");
    const lapras = (uid: string, x: number) => {
      const p = newPokemon(uid, "LAPRAS", 20, rollTraits("LAPRAS", rngFor(uid)), 3, 4);
      p.place = { x, y: 0, rot: 0 };
      return p;
    };
    const bag = (uid: string, x: number, key = "BAG_2X2") => ({ uid, kind: "bag" as const, place: { x, y: 0, rot: 0 as const }, paid: 4, bag: key });
    // a | b | c: one Lapras spans a–b and another b–c, so a and c are linked only through b.
    s.pieces = {
      ...s.pieces,
      a: bag("a", 0),
      b: bag("b", 2),
      c: bag("c", 4),
      d: bag("d", 7, "BAG_1X2"),
      l1: lapras("l1", 1),
      l2: lapras("l2", 3),
      u3: { ...s.pieces.u3!, place: { x: 0, y: 0, rot: 0 } },
    };
    expect(layoutIsValid(s.pieces)).toBe(true);
    const before = structuredClone(s.pieces);
    // Turning the 6×2 row clockwise stands it up as a 2×6 column: (x, y) → (1 − y, x).
    s = applyAction(s, { t: "move", uid: "b", place: { x: 0, y: 0, rot: 1 } });
    expect(s.pieces.a!.place).toEqual({ x: 0, y: 0, rot: 1 });
    expect(s.pieces.b!.place).toEqual({ x: 0, y: 2, rot: 1 });
    expect(s.pieces.c!.place).toEqual({ x: 0, y: 4, rot: 1 });
    expect(s.pieces.l1!.place).toEqual({ x: 0, y: 1, rot: 1 });
    expect(s.pieces.l2!.place).toEqual({ x: 0, y: 3, rot: 1 });
    expect(s.pieces.u3!.place).toEqual({ x: 1, y: 0, rot: 1 });
    // Bags that nothing links stay where they are, with what lies on them.
    for (const uid of ["d", "u1", "u2"]) expect(s.pieces[uid]!.place).toEqual(before[uid]!.place);
    expect(layoutIsValid(s.pieces)).toBe(true);
    // Turning in place (R) also turns the whole chain.
    const spot = rotationSpot(s, "a");
    expect(spot).not.toBeNull();
    s = applyAction(s, { t: "move", uid: "a", place: spot! });
    expect(new Set(["a", "b", "c", "l1", "l2", "u3"].map((uid) => s.pieces[uid]!.place!.rot))).toEqual(new Set([2]));
    expect(layoutIsValid(s.pieces)).toBe(true);
  });

  it("refuses to move a bag when a piece on it also hangs off the bags", () => {
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

  it("opens a sixth shop slot from round 9 and keeps a locked slot across it", () => {
    expect([1, 8, 9, 14, 18].map(shopSize)).toEqual([5, 5, 6, 6, 6]);
    const s = { ...run(), round: 8 };
    s.shop = rollShop(s, 0);
    expect(s.shop).toHaveLength(5);
    s.shop[4] = { ...s.shop[4]!, locked: true };
    const next = { ...s, round: 9 };
    next.shop = rollShop(next, 0);
    expect(next.shop).toHaveLength(6);
    expect(next.shop[4]).toEqual(s.shop[4]);
    expect(() => applyAction(next, { t: "lock", slot: 5 })).not.toThrow();
    expect(() => applyAction(s, { t: "lock", slot: 5 })).toThrow("invalid_slot");
    expect(() => applyAction(next, { t: "lock", slot: 6 })).toThrow("bad_action");
    const grown = applyRoundResult({ ...s, subclass: CHAMPIONS.red.subclasses[0]!, phase: "shop" }, {
      outcome: "win",
      fainted: [],
      battleGold: 0,
      opponent: { name: "", champion: "leon", ghost: false },
    });
    expect(grown.round).toBe(9);
    expect(grown.shop).toHaveLength(6);
    expect(grown.notices).toContainEqual({ key: "notice.shopGrew", params: { n: 6 } });
  });

  it("opens the round the party reaches 9 with a big bag, and says so", () => {
    expect(BIG_BAG_ROUND).toBe(11);
    expect(basePartyCap(BIG_BAG_ROUND)).toBe(9);
    const isBig = (slot: RunState["shop"][number]) => slot.offer?.kind === "bag" && BIG_BAGS.includes(slot.offer.bag);
    let rerollsWithout = 0;
    for (let i = 0; i < 20; i++) {
      const s = { ...run("red", `big-${i}`), round: BIG_BAG_ROUND };
      expect(rollShop(s, 0).some(isBig), `seed ${i}`).toBe(true);
      if (!rollShop(s, 1).some(isBig)) rerollsWithout++;
    }
    // Only the opening shop is guaranteed.
    expect(rerollsWithout).toBeGreaterThan(10);
    const before = { ...run("red", "big-notice"), round: BIG_BAG_ROUND - 1, subclass: CHAMPIONS.red.subclasses[0]!, phase: "shop" as const };
    const after = applyRoundResult(before, { outcome: "win", fainted: [], battleGold: 0, opponent: { name: "", champion: "leon", ghost: false } });
    expect(after.round).toBe(BIG_BAG_ROUND);
    expect(after.shop.some(isBig)).toBe(true);
    expect(after.notices).toContainEqual({ key: "notice.bigBagAppeared", params: { n: 9 } });
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
    // Every battle keeps the balance logs: the per-Pokémon summary and the shop phase before it.
    for (const b of store.battles) {
      expect(b.detail?.battlers.length).toBeGreaterThan(0);
      expect(b.shop?.goldStart).toBeGreaterThan(0);
    }
  });
});

describe("opponent preview", () => {
  it("names 1–3 main types per champion, each one its shop pool has", () => {
    for (const key of CHAMPION_KEYS) {
      const { mainTypes } = CHAMPIONS[key];
      expect(mainTypes.length, key).toBeGreaterThan(0);
      expect(mainTypes.length, key).toBeLessThanOrEqual(3);
      const poolTypes = new Set([...championPool(key)].flatMap((s) => getSpecies(s).types));
      for (const t of mainTypes) {
        expect(TYPES, key).toContain(t);
        expect(poolTypes.has(t), `${key} ${t}`).toBe(true);
      }
    }
  });

  it("shows the coming opponents and keeps to them", async () => {
    const store = new MemoryStore();
    // Ghosts of rounds 1–3 from other players, so matchmaking has real opponents to preview.
    for (const [i, champion] of (["red", "lance", "cynthia", "alder"] as const).entries()) {
      for (const round of [1, 2, 3]) {
        await store.addGhost({ id: `g${i}:${round}`, runId: `g${i}`, playerId: `other${i}`, round, wins: 0, losses: round - 1, team: botTeam(`pv-${i}-${round}`, round, champion), createdAt: i });
      }
    }
    let state = await startRun(store, { playerId: "me", playerName: "me", champion: "steven" });
    expect(state.upcoming?.map((u) => u.round)).toEqual(Array.from({ length: PREVIEW_BATTLES }, (_, i) => i + 1));
    // The fixed opponent itself never reaches the player; its champion does.
    expect(state.matchup?.round).toBe(1);
    expect(publicState(state).matchup).toBeUndefined();
    expect(publicState(state).upcoming).toEqual(state.upcoming);
    for (let round = 1; round <= 3 && state.phase !== "ended"; round++) {
      const shown = state.upcoming!;
      // Reloading shows the same preview.
      expect((await loadRun(store, { playerId: "me", runId: state.runId })).upcoming).toEqual(shown);
      const turn = await playRound(store, { playerId: "me", runId: state.runId, round, actions: [] });
      expect(turn.battle.opponent.ghost).toBe(true);
      expect(turn.battle.opponent.champion).toBe(shown[0]!.champion);
      state = turn.state;
      // What was previewed for the next round is who that round brings.
      if (state.phase !== "ended") expect(state.upcoming![0]).toMatchObject({ round: round + 1, champion: shown[1]!.champion });
    }
  });

  it("falls back to a bot of the previewed champion", async () => {
    const store = new MemoryStore();
    const state = await startRun(store, { playerId: "solo", playerName: "solo", champion: "red" });
    const [first, second] = state.upcoming!;
    expect(state.matchup?.ghostId).toBeNull();
    const turn = await playRound(store, { playerId: "solo", runId: state.runId, round: 1, actions: [] });
    expect(turn.battle.opponent).toMatchObject({ ghost: false, champion: first!.champion });
    expect(turn.state.upcoming![0]!.champion).toBe(second!.champion);
  });
});

describe("balance logs", () => {
  it("sums a battle up per Pokémon", () => {
    for (const round of [3, 8, 14]) {
      const teams = [botTeam(`log-a-${round}`, round), botTeam(`log-b-${round}`, round)] as const;
      const result = simulateBattle({ seed: `log-${round}`, teams: [teams[0], teams[1]] });
      const log = battleLog(result, teams);
      expect(log.battlers).toHaveLength(result.initial.length);
      expect(log.winner).toBe(result.winner);
      expect(log.battlers.map((b) => b.species)).toEqual(result.initial.map((b) => b.species));
      for (const side of [0, 1] as const) {
        const mine = log.battlers.filter((b) => b.side === side);
        const theirs = log.battlers.filter((b) => b.side !== side);
        // A KO is credited only to a blow that made an enemy faint.
        expect(mine.reduce((a, b) => a + b.kos, 0)).toBeLessThanOrEqual(theirs.filter((b) => b.fainted).length);
        expect(mine.reduce((a, b) => a + b.dealt, 0)).toBeLessThanOrEqual(theirs.reduce((a, b) => a + b.taken, 0));
        expect(log.hpLeft[side]).toBeGreaterThanOrEqual(0);
        expect(log.hpLeft[side]).toBeLessThanOrEqual(1);
      }
      if (result.winner !== null) {
        const loser = result.winner === 0 ? 1 : 0;
        expect(log.battlers.filter((b) => b.side === loser).every((b) => b.fainted)).toBe(true);
        expect(log.hpLeft[result.winner]).toBeGreaterThan(0);
      }
      expect(log.battlers.some((b) => b.dealt > 0 && b.moves > 0)).toBe(true);
    }
  });

  it("logs the shop phase while replaying it", () => {
    const start = createRun({ runId: "r", seed: "shop-log", playerName: "", champion: "red" });
    const slot = start.shop.findIndex((s) => s.offer && slotPrice(s, start) <= start.gold);
    const bought = start.shop[slot]!.offer!;
    const actions: Action[] = [{ t: "buy", slot }, { t: "reroll" }];
    const { state, log } = replayShop(start, actions);
    expect(state).toEqual(applyActions(start, actions));
    expect(log.bought).toEqual([offerKey(bought)]);
    expect(log.rerolls).toBe(1);
    const shown = (r: RunState) => r.shop.filter((s) => s.offer).length;
    expect(log.offered).toHaveLength(shown(start) + shown(state));
    expect(log.goldStart - log.spent - log.rerollGold + log.sellGold).toBe(log.goldEnd);
    expect(log.goldEnd).toBe(state.gold);
    // Illegal actions still throw, exactly like applyActions.
    const bad: Action[] = [{ t: "reroll" }, { t: "sell", uid: "nobody" }];
    const expected = (() => {
      try {
        applyActions(start, bad);
      } catch (e) {
        return (e as Error).message;
      }
      return "no error";
    })();
    expect(() => replayShop(start, bad)).toThrow(expected);
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
