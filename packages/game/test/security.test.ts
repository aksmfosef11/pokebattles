import { describe, expect, it } from "vitest";
import {
  applyAction,
  BOT_LUCK,
  BOT_RATINGS,
  botTeam,
  commitActions,
  createRun,
  loadRun,
  luckyBotTeam,
  META_RULES,
  MemoryStore,
  playRound,
  publicState,
  rankedBot,
  readAction,
  startRun,
  type Action,
  type ItemPiece,
  type RunState,
} from "../src/index.ts";

const run = (seed = "sec") => createRun({ runId: seed, seed, playerName: "t", champion: "red" });

describe("actions from an untrusted client", () => {
  it("never reach Object.prototype through piece ids", () => {
    const s = run();
    for (const uid of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      for (const a of [
        { t: "sell", uid },
        { t: "move", uid, place: null },
        { t: "use", uid },
        { t: "setAce", uid },
      ] as Action[]) {
        expect(() => applyAction(s, a), `${a.t} ${uid}`).toThrow("not_found");
      }
    }
    const tm: ItemPiece = { uid: "tm", kind: "item", place: null, paid: 0, item: "TM", param: "THUNDERBOLT", age: 0 };
    expect(() => applyAction({ ...s, pieces: { ...s.pieces, tm } }, { t: "use", uid: "tm", target: "__proto__" })).toThrow("not_found");
    expect(Object.prototype).not.toHaveProperty("place");
    expect(Number.isFinite(s.gold)).toBe(true);
  });

  it("only place pieces on whole cells with one of four rotations", () => {
    const s = run();
    const mon = Object.values(s.pieces).find((p) => p.kind === "pokemon")!;
    const at = mon.place!;
    for (const place of [
      { ...at, x: at.x + 0.5 },
      { ...at, y: "2" },
      { ...at, x: "0" },
      { ...at, rot: 4 },
      { ...at, rot: 3_000_000 },
      { ...at, rot: -1 },
      { x: at.x, y: at.y },
      "3,2",
    ]) {
      expect(() => applyAction(s, { t: "move", uid: mon.uid, place } as never), JSON.stringify(place)).toThrow("bad_action");
    }
    expect(() => applyAction(s, { t: "move", uid: mon.uid, place: { ...at, x: -1 } })).toThrow("out_of_board");
    expect(() => applyAction(s, { t: "move", uid: mon.uid, place: { ...at, y: 99 } })).toThrow("out_of_board");
    for (const slot of [-1, 1.5, 6, "0", null]) expect(() => applyAction(s, { t: "buy", slot } as never), String(slot)).toThrow("bad_action");
    // The sixth slot only exists from round 9.
    expect(() => applyAction(s, { t: "buy", slot: 5 })).toThrow("invalid_slot");
    expect(() => applyAction(s, { t: "fly" } as never)).toThrow("bad_action");
    expect(() => applyAction(s, null as never)).toThrow("bad_action");
  });

  it("keep only known fields", () => {
    expect(readAction({ t: "move", uid: "u1", place: { x: 1, y: 2, rot: 1, junk: "x".repeat(10) }, extra: 1 })).toEqual({
      t: "move",
      uid: "u1",
      place: { x: 1, y: 2, rot: 1 },
    });
    const s = run("bags");
    const slot = s.shop.findIndex((o) => o.offer?.kind === "bag");
    const after = applyAction(s, { t: "buy", slot, place: { x: 0, y: 0, rot: 0, junk: 1 } as never });
    const bag = Object.values(after.pieces).find((p) => p.kind === "bag" && p.uid !== "u1")!;
    expect(bag.place).toEqual({ x: 0, y: 0, rot: 0 });
  });
});

describe("the hidden seed", () => {
  it("is not in what players see, and seedless states refuse random actions", () => {
    const s = publicState(run());
    expect(s.seed).toBe("");
    expect(() => applyAction(s, { t: "reroll" })).toThrow("needs_server");
    const ball: ItemPiece = { uid: "ball", kind: "item", place: null, paid: 0, item: "POKE_BALL", age: 0 };
    expect(() => applyAction({ ...s, pieces: { ...s.pieces, ball } }, { t: "use", uid: "ball" })).toThrow("needs_server");
    expect(() => applyAction({ ...s, phase: "subclass" }, { t: "chooseSubclass", subclass: "red_kanto" })).toThrow("needs_server");
    // Everything without chance still works on the client.
    const mon = Object.values(s.pieces).find((p) => p.kind === "pokemon")!;
    expect(applyAction(s, { t: "move", uid: mon.uid, place: null }).pieces[mon.uid]!.place).toBeNull();
  });

  it("commits random actions for good and replays them before the turn", async () => {
    const store = new MemoryStore();
    const start = await startRun(store, { playerId: "p", playerName: "t", champion: "red" });
    const mon = Object.values(start.pieces).find((p) => p.kind === "pokemon")!;
    const before: Action = { t: "move", uid: mon.uid, place: null };
    const rolled = await commitActions(store, { playerId: "p", runId: start.runId, round: 1, actions: [before, { t: "reroll" }] });
    expect(rolled.gold).toBe(start.gold - 1);
    expect(rolled.pieces[mon.uid]!.place).toBeNull();
    // Reloading shows the committed state; the next commit builds on it instead of starting over.
    expect((await loadRun(store, { playerId: "p", runId: start.runId })).shop).toEqual(rolled.shop);
    const twice = await commitActions(store, { playerId: "p", runId: start.runId, round: 1, actions: [{ t: "reroll" }] });
    expect(twice.gold).toBe(start.gold - 2);
    // The turn applies the committed actions first: leaving them out does not undo them.
    const turn = await playRound(store, { playerId: "p", runId: start.runId, round: 1, actions: [] });
    expect(turn.state.log[0]!.goldEarned + start.gold - 2).toBe(turn.state.gold);
    expect((await store.getRun(start.runId))!.pending).toEqual([]);
    expect(turn.battle.seed).not.toContain(start.seed);
    await expect(commitActions(store, { playerId: "q", runId: start.runId, round: 2, actions: [] })).rejects.toThrow("run_not_found");
  });
});

describe("ghosts", () => {
  it("count once per player and never as an empty board", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < 3; i++) {
      const s = await startRun(store, { playerId: "farmer", playerName: "f", champion: "red" });
      await playRound(store, { playerId: "farmer", runId: s.runId, round: 1, actions: [] });
    }
    const empty = await startRun(store, { playerId: "empty", playerName: "e", champion: "red" });
    const mon = Object.values(empty.pieces).find((p) => p.kind === "pokemon")!;
    await playRound(store, { playerId: "empty", runId: empty.runId, round: 1, actions: [{ t: "sell", uid: mon.uid }] });
    const found = await store.findGhosts(1, "someone", 30, false);
    expect(found.map((g) => g.playerId)).toEqual(["farmer"]);
    expect(store.ghosts.some((g) => g.playerId === "empty")).toBe(false);
  });
});

describe("ranked matching", () => {
  async function rankedGhost(store: MemoryStore, playerId: string, rating: number) {
    const s = await startRun(store, { playerId, playerName: playerId, champion: "red", ranked: true });
    await playRound(store, { playerId, runId: s.runId, round: 1, actions: [], rating });
  }
  async function firstOpponent(store: MemoryStore, rating: number) {
    const s = await startRun(store, { playerId: "me", playerName: "me", champion: "red", ranked: true });
    return (await playRound(store, { playerId: "me", runId: s.runId, round: 1, actions: [], rating })).battle.opponent;
  }

  it("meets only ghosts within the rating window, scored against the owner's rating", async () => {
    const store = new MemoryStore();
    const start = META_RULES.startRating;
    await rankedGhost(store, "far", start + META_RULES.ratingWindow + 1);
    expect(await firstOpponent(store, start)).toMatchObject({ ghost: false, rating: BOT_RATINGS.plain });
    await rankedGhost(store, "near", start + 200);
    expect(await firstOpponent(store, start)).toMatchObject({ ghost: true, name: "near", rating: start + 200 });
  });

  it("gives bots no more than a somewhat lucky ordinary run, however high the rating", () => {
    const top = BOT_LUCK[BOT_LUCK.length - 1]!;
    const bot = rankedBot("s:5", 5, 5000);
    expect(bot.rating).toBe(Math.max(...Object.values(BOT_RATINGS)));
    expect(bot.team).toEqual(luckyBotTeam("s:5", 5, top));
    // The team is one of the ordinary runs it was picked from.
    const runs = Array.from({ length: top.runs }, (_, i) => botTeam(`s:5~${i}`, 5, bot.team.champion));
    expect(runs).toContainEqual(bot.team);
    // At the start rating a ranked bot is the plain bot normal runs meet.
    expect(rankedBot("s:5", 5, META_RULES.startRating).team).toEqual(botTeam("s:5", 5));
  });
});

describe("a seedless run", () => {
  it("still plays every non-random action the same as with its seed", () => {
    const s: RunState = run("same");
    const mon = Object.values(s.pieces).find((p) => p.kind === "pokemon")!;
    const actions: Action[] = [{ t: "move", uid: mon.uid, place: null }, { t: "buy", slot: 0 }];
    let a = s;
    let b = publicState(s);
    for (const x of actions) {
      try {
        a = applyAction(a, x);
        b = applyAction(b, x);
      } catch {
        /* an illegal buy fails on both */
      }
    }
    expect({ ...b, seed: s.seed }).toEqual(a);
  });
});
