import { afterAll, describe, expect, it } from "vitest";
import { BOT_RATINGS, championPool, lineBase, lockedLinesAt, META_RULES, rankedDelta, type Profile, type RunState } from "@pokebattles/game";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { PgStore } from "../src/store.ts";

// In-memory PGlite by default. TEST_DATABASE_URL runs the suite on a real PostgreSQL instead, inside
// a throwaway schema that is dropped afterwards.
const testUrl = process.env.TEST_DATABASE_URL;
const schema = testUrl ? `pb_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}` : null;
async function onServer(sql: string) {
  const admin = await openDb({ url: testUrl! });
  try {
    await admin.query(sql);
  } finally {
    await admin.close();
  }
}
if (schema) await onServer(`CREATE SCHEMA ${schema}`);
const store = await PgStore.open(await openDb(testUrl ? { url: testUrl, searchPath: schema! } : { memory: true }));
const app = createApp(store, { adminToken: "admin-secret" });
afterAll(async () => {
  await store.close();
  if (schema) await onServer(`DROP SCHEMA ${schema} CASCADE`);
});

function call(path: string, token: string | null, body?: unknown) {
  return app.request(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function json(path: string, token: string | null, body?: unknown) {
  return (await call(path, token, body)).json();
}

let n = 0;
/** A fresh account (with a starter champion unless `starter` is null); returns its token. */
async function player(starter: string | null = "red", name = `trainer${++n}`): Promise<string> {
  const res = await json("/api/auth/register", null, { username: name, password: "pass1234" });
  if (starter) await json("/api/me/starter", res.token, { champion: starter });
  return res.token;
}

/** Plays empty rounds until the run ends; returns the last turn. */
async function playOut(token: string, state: RunState) {
  let turn: { state: RunState; reward?: unknown } = { state };
  while (turn.state.phase !== "ended") {
    if (turn.state.phase === "subclass") {
      const sub = (await import("@pokebattles/game")).CHAMPIONS[turn.state.champion].subclasses[0];
      turn = await json(`/api/runs/${turn.state.runId}/turn`, token, { round: turn.state.round, actions: [{ t: "chooseSubclass", subclass: sub }] });
    } else {
      turn = await json(`/api/runs/${turn.state.runId}/turn`, token, { round: turn.state.round, actions: [] });
    }
  }
  return turn as { state: RunState; reward?: { points: number; totalPoints: number; rating: { before: number; after: number } | null; unlocked: string[] } };
}

describe("accounts", () => {
  it("registers with a 4+ character ID and password, nothing else", async () => {
    expect(await json("/api/auth/register", null, { username: "abc", password: "pass1234" })).toEqual({ error: "bad_username" });
    expect(await json("/api/auth/register", null, { username: "abcd", password: "123" })).toEqual({ error: "bad_password" });
    const ok = await json("/api/auth/register", null, { username: "한글아이디", password: "1234" });
    expect(ok.token).toBeTypeOf("string");
    expect(ok.account).toMatchObject({ username: "한글아이디", profile: { points: 0, champions: [], rating: META_RULES.startRating } });
    expect(await json("/api/auth/register", null, { username: "Alpha1", password: "pass1234" })).toHaveProperty("token");
    expect(await json("/api/auth/register", null, { username: "alpha1", password: "other" })).toEqual({ error: "username_taken" });
    expect(await json("/api/auth/register", null, { username: "ALPHA1", password: "other" })).toEqual({ error: "username_taken" });
    // The ID keeps the case it was registered with; logging in ignores case.
    expect((await json("/api/auth/login", null, { username: "ALPHA1", password: "pass1234" })).account.username).toBe("Alpha1");
  });

  it("logs in, rejects wrong passwords and forgets the session on logout", async () => {
    await json("/api/auth/register", null, { username: "loginer", password: "secret" });
    expect(await json("/api/auth/login", null, { username: "loginer", password: "wrong" })).toEqual({ error: "bad_login" });
    expect(await json("/api/auth/login", null, { username: "nobody", password: "secret" })).toEqual({ error: "bad_login" });
    const { token } = await json("/api/auth/login", null, { username: "LOGINER", password: "secret" });
    expect((await json("/api/me", token)).account.username).toBe("loginer");
    await call("/api/auth/logout", token, {});
    const after = await call("/api/me", token);
    expect(after.status).toBe(401);
    expect(await after.json()).toEqual({ error: "unauthorized" });
  });

  it("locks an ID after repeated wrong passwords", async () => {
    await json("/api/auth/register", null, { username: "guessme", password: "secret" });
    for (let i = 0; i < 10; i++) await call("/api/auth/login", null, { username: "guessme", password: `nope${i}` });
    expect(await json("/api/auth/login", null, { username: "guessme", password: "secret" })).toEqual({ error: "too_many_attempts" });
  });

  it("requires a login for runs", async () => {
    const res = await call("/api/runs", null);
    expect(res.status).toBe(401);
  });
});

describe("champions and unlocks", () => {
  it("starts with one free champion and buys the rest with points", async () => {
    const token = await player(null);
    expect(await json("/api/runs", token, { champion: "red" })).toEqual({ error: "champion_locked" });
    expect(await json("/api/me/champions", token, { champion: "lance" })).toEqual({ error: "starter_first" });
    const picked = await json("/api/me/starter", token, { champion: "cynthia" });
    expect(picked.account.profile.champions).toEqual(["cynthia"]);
    expect(await json("/api/me/starter", token, { champion: "red" })).toEqual({ error: "starter_chosen" });
    expect(await json("/api/runs", token, { champion: "red" })).toEqual({ error: "champion_locked" });
    expect(await json("/api/me/champions", token, { champion: "red" })).toEqual({ error: "not_enough_points" });

    const me = (await json("/api/me", token)).account;
    const user = (await store.userByName(me.username))!;
    await store.saveProfile(user.id, { ...user.profile, points: META_RULES.championPrice + 5 });
    const bought = await json("/api/me/champions", token, { champion: "red" });
    expect(bought.account.profile).toMatchObject({ points: 5, champions: ["cynthia", "red"] });
    expect(await json("/api/me/champions", token, { champion: "red" })).toEqual({ error: "champion_owned" });
    expect((await json("/api/runs", token, { champion: "red" })).state.champion).toBe("red");
  });

  it("opens the next stage of an owned champion's pool for points", async () => {
    const token = await player("red");
    expect(await json("/api/me/pool", token, { champion: "red" })).toEqual({ error: "not_enough_points" });
    const me = (await json("/api/me", token)).account;
    const user = (await store.userByName(me.username))!;
    await store.saveProfile(user.id, { ...user.profile, points: META_RULES.poolStagePrice + 5 });
    expect(await json("/api/me/pool", token, { champion: "lance" })).toEqual({ error: "champion_locked" });
    const bought = await json("/api/me/pool", token, { champion: "red" });
    expect(bought.account.profile).toMatchObject({ points: 5, poolBought: { red: 1 } });
    const { state } = (await json("/api/runs", token, { champion: "red" })) as { state: RunState };
    expect(state.lockedLines).toEqual(lockedLinesAt("red", 1));
  });

  it("trains a starter with server-drawn results and starts runs with it", async () => {
    const token = await player("red");
    expect(await json("/api/me/starter-train", token, { champion: "red", kind: "nature" })).toEqual({ error: "not_enough_points" });
    const me = (await json("/api/me", token)).account;
    const user = (await store.userByName(me.username))!;
    await store.saveProfile(user.id, { ...user.profile, points: 100 });
    expect(await json("/api/me/starter-train", token, { champion: "lance", kind: "nature" })).toEqual({ error: "champion_locked" });
    expect(await json("/api/me/starter-keep", token, { champion: "red", keep: true })).toEqual({ error: "no_draw" });
    const drawn = (await json("/api/me/starter-train", token, { champion: "red", kind: "nature" })).account.profile as Profile;
    expect(drawn.points).toBe(100 - META_RULES.natureDrawPrice);
    const nature = drawn.starters.red!.draw!.kind === "nature" ? drawn.starters.red!.draw!.nature : null;
    const kept = (await json("/api/me/starter-keep", token, { champion: "red", keep: true })).account.profile as Profile;
    expect(kept.starters.red).toEqual({ nature });
    const iv = (await json("/api/me/starter-train", token, { champion: "red", kind: "iv" })).account.profile as Profile;
    expect(Object.values(iv.starters.red!.ivBonus!)).toEqual([1]);
    const { state } = (await json("/api/runs", token, { champion: "red" })) as { state: RunState };
    const pikachu = Object.values(state.pieces).find((p) => p.kind === "pokemon");
    expect(pikachu?.kind === "pokemon" && pikachu.nature).toBe(nature);
  });

  it("sells looks: shinies, arenas and nicknames reach the run and its ghosts", async () => {
    const token = await player("red");
    const me = (await json("/api/me", token)).account;
    const user = (await store.userByName(me.username))!;
    await store.saveProfile(user.id, { ...user.profile, points: 1000 });
    const shiny = (await json("/api/me/shiny", token, { champion: "red" })).account.profile as Profile;
    expect(shiny.shinyLines).toHaveLength(1);
    expect(await json("/api/me/arena", token, { arena: "moon" })).toEqual({ error: "bad_action" });
    expect((await json("/api/me/arena", token, { arena: "sea" })).account.profile).toMatchObject({ arenas: ["sea"], homeArena: "sea" });
    expect(await json("/api/me/home-arena", token, { arena: "cave" })).toEqual({ error: "arena_locked" });
    const named = (await json("/api/me/nickname", token, { champion: "red", nickname: "Sparky" })).account.profile as Profile;
    expect(named.points).toBe(1000 - META_RULES.shinyDrawPrice - META_RULES.arenaPrice - META_RULES.nicknamePrice);
    const { state } = (await json("/api/runs", token, { champion: "red" })) as { state: RunState };
    expect(state.cosmetics).toEqual({ shinyLines: shiny.shinyLines, arena: "sea" });
    const pikachu = Object.values(state.pieces).find((p) => p.kind === "pokemon");
    expect(pikachu?.kind === "pokemon" && pikachu.nickname).toBe("Sparky");
  });

  it("changes the ID for points, keeping it unique", async () => {
    const token = await player("red", "renamer1");
    await player("red", "takenname");
    expect(await json("/api/me/rename", token, { username: "newname1" })).toEqual({ error: "not_enough_points" });
    const user = (await store.userByName("renamer1"))!;
    await store.saveProfile(user.id, { ...user.profile, points: META_RULES.renamePrice + 7 });
    expect(await json("/api/me/rename", token, { username: "ab" })).toEqual({ error: "bad_username" });
    expect(await json("/api/me/rename", token, { username: "renamer1" })).toEqual({ error: "same_name" });
    expect(await json("/api/me/rename", token, { username: "TakenName" })).toEqual({ error: "username_taken" });
    // A refused rename costs nothing.
    expect((await json("/api/me", token)).account.profile.points).toBe(META_RULES.renamePrice + 7);
    const renamed = (await json("/api/me/rename", token, { username: "newname1" })).account;
    expect(renamed).toMatchObject({ username: "newname1", profile: { points: 7 } });
    expect((await json("/api/me", token)).account.username).toBe("newname1");
    expect(await json("/api/auth/login", null, { username: "renamer1", password: "pass1234" })).toEqual({ error: "bad_login" });
    expect((await json("/api/auth/login", null, { username: "newname1", password: "pass1234" })).account.username).toBe("newname1");
  });

  it("charges start items when a run starts and resolves Bottle Caps on the server", async () => {
    const token = await player("red");
    expect(await json("/api/runs", token, { champion: "red", startItems: ["MINT"] })).toEqual({ error: "not_enough_points" });
    expect(await json("/api/runs", token, { champion: "red", startItems: ["MINT", "MINT"] })).toEqual({ error: "bad_action" });
    const me = (await json("/api/me", token)).account;
    const user = (await store.userByName(me.username))!;
    await store.saveProfile(user.id, { ...user.profile, points: 2 * META_RULES.startItemPrice + 1 });
    const started = (await json("/api/runs", token, { champion: "red", startItems: ["MINT", "BOTTLE_CAP"] })) as { state: RunState; account: { profile: Profile } };
    expect(started.account.profile.points).toBe(1);
    expect((await json("/api/me", token)).account.profile.points).toBe(1);
    const items = Object.values(started.state.pieces).filter((p) => p.kind === "item" && p.place === null);
    expect(items.map((p) => p.kind === "item" && p.item).sort()).toEqual(["BOTTLE_CAP", "MINT"]);
    const cap = items.find((p) => p.kind === "item" && p.item === "BOTTLE_CAP")!;
    const mon = Object.values(started.state.pieces).find((p) => p.kind === "pokemon")!;
    const after = (await json(`/api/runs/${started.state.runId}/act`, token, { round: 1, actions: [{ t: "use", uid: cap.uid, target: mon.uid }] })) as { state: RunState };
    expect(after.state.pieces[cap.uid]).toBeUndefined();
    expect(after.state.seed).toBe("");
  });

  it("gives a new player's run only the starting part of the champion's pool", async () => {
    const token = await player("red");
    const { state } = (await json("/api/runs", token, { champion: "red" })) as { state: RunState };
    expect(state.lockedLines?.length).toBeGreaterThan(0);
    const locked = new Set(state.lockedLines);
    for (const slot of state.shop) {
      if (slot.offer?.kind === "pokemon") expect(locked.has(lineBase(slot.offer.species)), slot.offer.species).toBe(false);
    }
    expect(championPool(state).size).toBeLessThan(championPool("red").size);
  });

  it("pays points for a finished run once and opens more species after enough runs", async () => {
    const token = await player("kukui");
    const username = (await json("/api/me", token)).account.username;
    const first = await playOut(token, (await json("/api/runs", token, { champion: "kukui" })).state);
    const r = first.reward!;
    const s = first.state;
    expect(r.points).toBe(s.log.length * META_RULES.pointsPerBattle + s.wins * META_RULES.pointsPerWin + (s.wins >= 10 ? META_RULES.clearBonus : 0));
    expect(r.rating).toBeNull();
    expect(r.unlocked).toEqual([]);
    // Reading the ended run again does not pay twice.
    await json(`/api/runs/${s.runId}`, token);
    expect((await json("/api/me", token)).account.profile.points).toBe(r.points);

    const second = await playOut(token, (await json("/api/runs", token, { champion: "kukui" })).state);
    expect(second.reward!.unlocked.length).toBeGreaterThan(0);
    const profile: Profile = (await json("/api/me", token)).account.profile;
    expect(profile.runs.kukui).toBe(2);
    const next = (await json("/api/runs", token, { champion: "kukui" })).state as RunState;
    expect(next.lockedLines!.length).toBeLessThan(first.state.lockedLines!.length);
    expect((await store.userByName(username))!.profile.points).toBe(r.points + second.reward!.points);
  });

  it("pays a run once even when two requests settle it at the same moment", async () => {
    const token = await player("red");
    const username = (await json("/api/me", token)).account.username;
    const user = (await store.userByName(username))!;
    const { state } = (await json("/api/runs", token, { champion: "red" })) as { state: RunState };
    const ended: RunState = { ...state, phase: "ended" };
    const settle = (p: Profile) => ({
      profile: { ...p, points: p.points + 7 },
      reward: { points: 7, totalPoints: p.points + 7, rating: null, unlocked: [], championRuns: 1 },
    });
    const results = await Promise.all([store.settleRun(user.id, ended, settle), store.settleRun(user.id, ended, settle), store.settleRun(user.id, ended, settle)]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect((await store.userByName(username))!.profile.points).toBe(user.profile.points + 7);
    const rows = await store.db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM run_results WHERE run_id = $1", [state.runId]);
    expect(rows[0]!.n).toBe(1);
  });
});

describe("matchmaking", () => {
  it("runs a round against a bot, then matches the next player against that ghost", async () => {
    const a = await player("red", "alphaGhost");
    const b = await player("geeta", "betaGhost");
    const runA = await json("/api/runs", a, { champion: "red" });
    const t1 = await json(`/api/runs/${runA.state.runId}/turn`, a, { round: 1, actions: [] });
    expect(t1.state.round).toBe(2);

    const runB = await json("/api/runs", b, { champion: "geeta" });
    const t2 = await json(`/api/runs/${runB.state.runId}/turn`, b, { round: 1, actions: [] });
    // Earlier tests left round-1 ghosts too; any of them is another player's board.
    expect(t2.battle.opponent.ghost).toBe(true);
    expect(t2.battle.opponent.name).not.toBe("betaGhost");

    const list = await json("/api/runs", a);
    expect(list.runs.map((r: { runId: string }) => r.runId)).toContain(runA.state.runId);
  });

  it("keeps ranked and normal ghosts apart", async () => {
    const a = await player("lance", "rankedA");
    const b = await player("lance", "rankedB");
    const normal = await json("/api/runs", a, { champion: "lance" });
    await json(`/api/runs/${normal.state.runId}/turn`, a, { round: 1, actions: [] });
    const ranked = await json("/api/runs", b, { champion: "lance", ranked: true });
    expect(ranked.state.ranked).toBe(true);
    // Only normal ghosts exist for round 1 from other players, so the ranked run meets a bot.
    const t = await json(`/api/runs/${ranked.state.runId}/turn`, b, { round: 1, actions: [] });
    expect(t.battle.opponent.ghost).toBe(false);
  });

  it("refuses another player's run and replays of an old round", async () => {
    const a = await player("lance");
    const other = await player("lance");
    const run = await json("/api/runs", a, { champion: "lance" });
    expect((await call(`/api/runs/${run.state.runId}`, other)).status).toBe(400);
    await call(`/api/runs/${run.state.runId}/turn`, a, { round: 1, actions: [] });
    expect(await json(`/api/runs/${run.state.runId}/turn`, a, { round: 1, actions: [] })).toEqual({ error: "round_mismatch" });
  });

  it("rejects illegal actions server-side", async () => {
    const a = await player("red");
    const run = await json("/api/runs", a, { champion: "red" });
    const rerolls = Array.from({ length: 11 }, () => ({ t: "reroll" }));
    expect(await json(`/api/runs/${run.state.runId}/turn`, a, { round: 1, actions: rerolls })).toEqual({ error: "not_enough_gold" });
  });
});

describe("ranked", () => {
  it("allows one ranked run at a time, settles the rating and fills the leaderboard", async () => {
    const token = await player("steven", "climber");
    const run = await json("/api/runs", token, { champion: "steven", ranked: true });
    expect(await json("/api/runs", token, { champion: "steven", ranked: true })).toEqual({ error: "ranked_in_progress" });
    expect((await json("/api/runs", token, { champion: "steven" })).state.ranked).toBeUndefined();

    const end = await playOut(token, run.state);
    const rating = end.reward!.rating!;
    expect(rating.before).toBe(META_RULES.startRating);
    // Every battle is an Elo game against a rating: the ghost owner's, or the bot's measured strength.
    expect(end.state.log.every((l) => typeof l.opponent.rating === "number")).toBe(true);
    expect(rating.after).toBe(Math.max(0, rating.before + rankedDelta(rating.before, end.state.log)));
    expect((await json("/api/me", token)).account.profile).toMatchObject({ rating: rating.after, rankedRuns: 1 });

    const board = await json("/api/leaderboard", token);
    expect(board.top.map((e: { username: string }) => e.username)).toContain("climber");
    expect(board.me).toMatchObject({ username: "climber", rating: rating.after, rankedRuns: 1 });
    expect(board.me.rank).toBeGreaterThanOrEqual(1);
    // A new ranked run is allowed once the last one ended.
    expect((await json("/api/runs", token, { champion: "steven", ranked: true })).state.ranked).toBe(true);
  });

  it("meets ranked ghosts only within the rating window, else a bot of about that rating", async () => {
    const firstOpponent = async (token: string) => {
      const run = await json("/api/runs", token, { champion: "red", ranked: true });
      return (await json(`/api/runs/${run.state.runId}/turn`, token, { round: 1, actions: [] })).battle.opponent;
    };
    // A round-1 ranked ghost at the start rating.
    await firstOpponent(await player("red", "windowghost"));
    const far = await player("red", "windowfar");
    const user = (await store.userByName("windowfar"))!;
    await store.updateProfile(user.id, (p) => ({ ...p, rating: META_RULES.startRating + META_RULES.ratingWindow + 100 }));
    expect(await firstOpponent(far)).toMatchObject({ ghost: false, rating: Math.max(...Object.values(BOT_RATINGS)) });
    expect(await firstOpponent(await player("red", "windownear"))).toMatchObject({ ghost: true, rating: META_RULES.startRating });
  });
});

describe("balance statistics", () => {
  it("is admin-only", async () => {
    expect((await call("/api/admin/stats", null)).status).toBe(401);
    expect((await call("/api/admin/stats", "wrong")).status).toBe(401);
    const off = createApp(store);
    expect((await off.request("/api/admin/stats", { headers: { authorization: "Bearer admin-secret" } })).status).toBe(404);
  });

  it("reports finished runs, battles, species and items", async () => {
    const report = await json("/api/admin/stats", "admin-secret");
    const runs = (await store.db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM run_results"))[0]!.n;
    expect(runs).toBeGreaterThan(0);
    expect(report.totals.runs).toBe(runs);
    expect(report.totals.battles).toBeGreaterThan(0);
    const kukui = report.champions.find((c: { champion: string }) => c.champion === "kukui");
    expect(kukui.runs).toBeGreaterThanOrEqual(2);
    expect(kukui.winsHistogram.reduce((a: number, b: number) => a + b, 0)).toBe(kukui.runs);
    expect(report.species.length).toBeGreaterThan(0);
    expect(report.items.length).toBeGreaterThan(0);
    expect(Object.keys(report.matchups).length).toBeGreaterThan(0);

    const ranked = await json("/api/admin/stats?ranked=true", "admin-secret");
    expect(ranked.totals.runs).toBeLessThan(report.totals.runs);
    const md = await (await call("/api/admin/stats?format=md&minSample=1", "admin-secret")).text();
    expect(md).toContain("## Champions");
    expect(md).toContain("| kukui |");
  });

  it("keeps battle detail, shop logs and run context", async () => {
    const report = await json("/api/admin/stats", "admin-secret");
    expect(report.performance.battles).toBeGreaterThan(0);
    expect(report.performance.species.length).toBeGreaterThan(0);
    expect(report.offers.some((o: { offered: number }) => o.offered > 0)).toBe(true);
    expect(report.economy.length).toBeGreaterThan(0);
    expect(report.roundCurve.length).toBeGreaterThan(0);
    expect(report.players.list.length).toBe(report.totals.players);
    expect(report.experience.reduce((a: number, g: { runs: number }) => a + g.runs, 0)).toBe(report.totals.runs);
    // This test store has no build id, so everything sits under "-".
    expect(report.builds.map((b: { build: string }) => b.build)).toEqual(["-"]);
    expect((await json("/api/admin/stats?build=-", "admin-secret")).totals.runs).toBe(report.totals.runs);
    expect((await json("/api/admin/stats?build=nope", "admin-secret")).totals.runs).toBe(0);

    const [row] = await store.db.query<{ context: { poolStage: number; startItems: string[]; finishedRuns: number } | null }>(
      "SELECT context FROM run_results WHERE context IS NOT NULL LIMIT 1",
    );
    expect(row?.context).toMatchObject({ poolStage: expect.any(Number), startItems: expect.any(Array), finishedRuns: expect.any(Number) });

    const md = await (await call("/api/admin/stats?format=md&minSample=1", "admin-secret")).text();
    for (const heading of ["## Builds", "## Battle win rate by round", "## Economy", "## Players", "## In battle", "## Shop pick rate"]) expect(md).toContain(heading);
  });

  it("exports raw rows to the admin only", async () => {
    expect((await call("/api/admin/export", null)).status).toBe(401);
    const rows = await json("/api/admin/export?limit=5", "admin-secret");
    expect(rows.runs.length).toBeGreaterThan(0);
    expect(rows.battles).toHaveLength(5);
    expect(rows.battles[0].detail.battlers.length).toBeGreaterThan(0);
    expect(rows.battles[0].shop.offered.length).toBeGreaterThan(0);
  });
});

describe("tampered clients", () => {
  it("never see the seed", async () => {
    const token = await player("red");
    const created = await json("/api/runs", token, { champion: "red" });
    expect(created.state.seed).toBe("");
    const secret = (await store.getRun(created.state.runId))!.state.seed;
    expect(secret).not.toBe("");
    expect((await json(`/api/runs/${created.state.runId}`, token)).state.seed).toBe("");
    const acted = await json(`/api/runs/${created.state.runId}/act`, token, { round: 1, actions: [{ t: "reroll" }] });
    expect(acted.state.seed).toBe("");
    const turn = await json(`/api/runs/${created.state.runId}/turn`, token, { round: 1, actions: [] });
    expect(turn.state.seed).toBe("");
    expect(turn.battle.seed).not.toContain(secret);
  });

  it("commit rerolls on the server, for good", async () => {
    const token = await player("red");
    const { state } = (await json("/api/runs", token, { champion: "red" })) as { state: RunState };
    const acted = (await json(`/api/runs/${state.runId}/act`, token, { round: 1, actions: [{ t: "reroll" }] })).state as RunState;
    expect(acted.gold).toBe(state.gold - 1);
    expect(acted.shop).not.toEqual(state.shop);
    // A reload shows the rerolled shop, and a turn that leaves the reroll out still pays for it.
    expect((await json(`/api/runs/${state.runId}`, token)).state.shop).toEqual(acted.shop);
    const turn = await json(`/api/runs/${state.runId}/turn`, token, { round: 1, actions: [] });
    expect(turn.state.gold).toBe(state.gold - 1 + turn.state.log[0].goldEarned);
  });

  it("cannot sell or move Object.prototype, and the server keeps running", async () => {
    const token = await player("red");
    const { state } = await json("/api/runs", token, { champion: "red" });
    for (const actions of [[{ t: "sell", uid: "__proto__" }, { t: "reroll" }], [{ t: "move", uid: "__proto__", place: null }], [{ t: "sell", uid: "constructor" }]]) {
      expect(await json(`/api/runs/${state.runId}/turn`, token, { round: 1, actions })).toEqual({ error: "not_found" });
    }
    expect(Object.prototype).not.toHaveProperty("place");
    expect((await json("/api/health", null)).ok).toBe(true);
  });

  it("cannot stack bags between cells or stall the server with huge rotations", async () => {
    const token = await player("red");
    const { state } = (await json("/api/runs", token, { champion: "red" })) as { state: RunState };
    const slot = state.shop.findIndex((s) => s.offer?.kind === "bag");
    const start = Object.values(state.pieces).find((p) => p.kind === "bag")!.place!;
    expect(await json(`/api/runs/${state.runId}/turn`, token, { round: 1, actions: [{ t: "buy", slot, place: { ...start, x: start.x + 0.5 } }] })).toEqual({
      error: "bad_action",
    });
    const mon = Object.values(state.pieces).find((p) => p.kind === "pokemon")!;
    const t0 = Date.now();
    const res = await json(`/api/runs/${state.runId}/turn`, token, { round: 1, actions: [{ t: "move", uid: mon.uid, place: { ...mon.place!, rot: 1e9 } }] });
    expect(res).toEqual({ error: "bad_action" });
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("gets no free wins from empty boards left by alt accounts", async () => {
    for (let i = 0; i < 5; i++) {
      const alt = await player("red");
      const { state } = (await json("/api/runs", alt, { champion: "red", ranked: true })) as { state: RunState };
      const mon = Object.values(state.pieces).find((p) => p.kind === "pokemon")!;
      await json(`/api/runs/${state.runId}/turn`, alt, { round: 1, actions: [{ t: "sell", uid: mon.uid }] });
    }
    const main = await player("red");
    const { state } = await json("/api/runs", main, { champion: "red", ranked: true });
    const turn = await json(`/api/runs/${state.runId}/turn`, main, { round: 1, actions: [] });
    const opponents = turn.battle.teams[1].pieces.filter((p: { kind: string }) => p.kind === "pokemon");
    expect(opponents.length).toBeGreaterThan(0);
  });

  it("limits sign-ups per address", async () => {
    const limited = createApp(store, { registerPerHour: 2 });
    const register = async (name: string, ip: string) =>
      (
        await limited.request("/api/auth/register", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": ip },
          body: JSON.stringify({ username: name, password: "pass" }),
        })
      ).json();
    expect(await register("limitA1", "203.0.113.7")).toHaveProperty("token");
    expect(await register("limitA2", "203.0.113.7")).toHaveProperty("token");
    expect(await register("limitA3", "203.0.113.7")).toEqual({ error: "too_many_accounts" });
    expect(await register("limitB1", "198.51.100.2")).toHaveProperty("token");
  });
});
