import { timingSafeEqual } from "node:crypto";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import {
  buyChampion,
  buyPoolStage,
  chooseStarter,
  commitActions,
  CONTENT,
  GameError,
  keepStarterDraw,
  loadRun,
  META_RULES,
  migrateRun,
  newProfile,
  payStartItems,
  playRound,
  publicState,
  randomSeed,
  readStartItems,
  rngFor,
  runOptionsFor,
  settleRun,
  startRun,
  trainStarter,
  type Action,
  type Profile,
  type RunState,
} from "@pokebattles/game";
import {
  checkPassword,
  checkUsername,
  hashPassword,
  isPrivateAddress,
  LoginThrottle,
  newToken,
  newUserId,
  tokenHash,
  verifyPassword,
  WindowLimit,
} from "./auth.ts";
import { collectStats, statsMarkdown, type StatsFilter } from "./stats.ts";
import type { PgStore, UserRow } from "./store.ts";

export interface AppOptions {
  /** Enables GET /api/admin/stats for `Authorization: Bearer <token>`. */
  adminToken?: string;
  /** Origins allowed to call the API from another site (client hosted separately). */
  corsOrigins?: string[];
  /** New accounts per client address per hour (alt accounts feeding weak ghosts). 0 or absent: no limit. */
  registerPerHour?: number;
}

/**
 * The player's address. Behind a proxy on a private network (nginx in docker-compose) that is the
 * last X-Forwarded-For hop the proxy added; a connection from a public address is taken as is, so a
 * forged header only works from inside the private network.
 */
function clientAddress(c: Context): string {
  let addr = "";
  try {
    addr = getConnInfo(c).remote.address ?? "";
  } catch {
    /* not served by @hono/node-server (tests) */
  }
  if (!addr || isPrivateAddress(addr)) {
    const hop = c.req.header("x-forwarded-for")?.split(",").pop()?.trim();
    if (hop) return hop;
  }
  return addr || "unknown";
}

function summary(state: RunState) {
  return {
    runId: state.runId,
    champion: state.champion,
    round: state.round,
    wins: state.wins,
    losses: state.losses,
    lives: state.lives,
    phase: state.phase,
    playerName: state.playerName,
    ranked: !!state.ranked,
  };
}

function account(user: UserRow): { username: string; profile: Profile } {
  return { username: user.username, profile: user.profile };
}

async function body<T>(c: Context): Promise<Partial<T>> {
  const b = (await c.req.json().catch(() => ({}))) as unknown;
  return b && typeof b === "object" ? (b as Partial<T>) : {};
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** `since` as a date (2026-09-01) or milliseconds. */
function statsFilter(q: (k: string) => string | undefined): StatsFilter {
  const f: StatsFilter = {};
  const since = q("since");
  if (since) {
    const t = /^\d+$/.test(since) ? Number(since) : Date.parse(since);
    if (!Number.isNaN(t)) f.since = t;
  }
  const ranked = q("ranked");
  if (ranked === "true" || ranked === "1") f.ranked = true;
  if (ranked === "false" || ranked === "0") f.ranked = false;
  const minRound = Number(q("minRound"));
  if (Number.isFinite(minRound) && minRound > 0) f.minRound = minRound;
  const minSample = Number(q("minSample"));
  if (Number.isFinite(minSample) && minSample > 0) f.minSample = minSample;
  return f;
}

export function createApp(store: PgStore, opts: AppOptions = {}): Hono {
  const app = new Hono();
  const throttle = new LoginThrottle();
  const signups = opts.registerPerHour ? new WindowLimit(opts.registerPerHour, 60 * 60 * 1000) : null;

  app.onError((err, c) => {
    if (err instanceof GameError) return c.json({ error: err.code }, err.code === "unauthorized" ? 401 : 400);
    console.error(err);
    return c.json({ error: "internal" }, 500);
  });

  if (opts.corsOrigins && opts.corsOrigins.length > 0) {
    app.use("/api/*", cors({ origin: opts.corsOrigins, allowHeaders: ["Content-Type", "Authorization"], allowMethods: ["GET", "POST", "OPTIONS"] }));
  }
  app.use("/api/*", bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ error: "too_large" }, 413) }));

  const bearer = (c: Context) => /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1] ?? "";

  async function requireUser(c: Context): Promise<UserRow> {
    const token = bearer(c);
    const user = token ? await store.sessionUser(tokenHash(token)) : null;
    if (!user) throw new GameError("unauthorized");
    return user;
  }

  /** Points, rating and unlocks for a run that just ended; null if it is still going or was settled before. */
  async function settleIfEnded(user: UserRow, state: RunState) {
    return state.phase === "ended" ? store.settleRun(user.id, state, (p) => settleRun(p, state)) : null;
  }

  async function login(c: Context, user: UserRow) {
    const token = newToken();
    await store.addSession(tokenHash(token), user.id);
    return c.json({ token, account: account(user) });
  }

  app.get("/api/health", async (c) => {
    try {
      await store.ping();
    } catch (e) {
      console.error("health: database unreachable", e);
      return c.json({ ok: false, error: "db_unavailable" }, 503);
    }
    return c.json({ ok: true, content: CONTENT.version });
  });

  // ───────────────────────────── accounts

  app.post("/api/auth/register", async (c) => {
    const b = await body<{ username: string; password: string }>(c);
    const username = checkUsername(b.username);
    const password = checkPassword(b.password);
    if (signups && !signups.take(clientAddress(c))) throw new GameError("too_many_accounts");
    const user: UserRow = { id: newUserId(), username, password: await hashPassword(password), profile: newProfile(), createdAt: Date.now() };
    if (!(await store.createUser(user))) throw new GameError("username_taken");
    return login(c, user);
  });

  app.post("/api/auth/login", async (c) => {
    const b = await body<{ username: string; password: string }>(c);
    const username = typeof b.username === "string" ? b.username.normalize("NFC").trim() : "";
    const password = typeof b.password === "string" ? b.password : "";
    throttle.check(username);
    const user = username ? await store.userByName(username) : null;
    if (!user || !(await verifyPassword(password, user.password))) {
      throttle.fail(username);
      throw new GameError("bad_login");
    }
    throttle.clear(username);
    return login(c, user);
  });

  app.post("/api/auth/logout", async (c) => {
    const token = bearer(c);
    if (token) await store.deleteSession(tokenHash(token));
    return c.json({ ok: true });
  });

  app.get("/api/me", async (c) => c.json({ account: account(await requireUser(c)) }));

  app.post("/api/me/starter", async (c) => {
    const user = await requireUser(c);
    const { champion } = await body<{ champion: string }>(c);
    const profile = await store.updateProfile(user.id, (p) => chooseStarter(p, champion));
    return c.json({ account: { username: user.username, profile } });
  });

  app.post("/api/me/champions", async (c) => {
    const user = await requireUser(c);
    const { champion } = await body<{ champion: string }>(c);
    const profile = await store.updateProfile(user.id, (p) => buyChampion(p, champion));
    return c.json({ account: { username: user.username, profile } });
  });

  app.post("/api/me/pool", async (c) => {
    const user = await requireUser(c);
    const { champion } = await body<{ champion: string }>(c);
    const profile = await store.updateProfile(user.id, (p) => buyPoolStage(p, champion));
    return c.json({ account: { username: user.username, profile } });
  });

  // Starter training draws with fresh server randomness, so a client cannot see or steer the result.
  app.post("/api/me/starter-train", async (c) => {
    const user = await requireUser(c);
    const { champion, kind } = await body<{ champion: string; kind: string }>(c);
    const profile = await store.updateProfile(user.id, (p) => trainStarter(p, champion, kind, rngFor(randomSeed(), "train")));
    return c.json({ account: { username: user.username, profile } });
  });

  app.post("/api/me/starter-keep", async (c) => {
    const user = await requireUser(c);
    const { champion, keep } = await body<{ champion: string; keep: boolean }>(c);
    const profile = await store.updateProfile(user.id, (p) => keepStarterDraw(p, champion, keep));
    return c.json({ account: { username: user.username, profile } });
  });

  app.get("/api/leaderboard", async (c) => {
    const token = bearer(c);
    const user = token ? await store.sessionUser(tokenHash(token)) : null;
    const me =
      user && user.profile.rankedRuns > 0
        ? { username: user.username, rating: user.profile.rating, rankedRuns: user.profile.rankedRuns, rank: await store.rankOf(user.profile.rating) }
        : null;
    return c.json({ top: await store.leaderboard(50), me, players: await store.rankedPlayers() });
  });

  // ───────────────────────────── runs

  app.get("/api/runs", async (c) => {
    const user = await requireUser(c);
    return c.json({ runs: (await store.listRuns(user.id)).map((r) => summary(migrateRun(r.state))) });
  });

  app.post("/api/runs", async (c) => {
    const user = await requireUser(c);
    const b = await body<{ champion: string; ranked: boolean; startItems?: unknown }>(c);
    const { champion, lockedLines, starter } = runOptionsFor(user.profile, b.champion);
    const startItems = readStartItems(b.startItems);
    const ranked = b.ranked === true;
    // One ranked run at a time, so a bad start cannot simply be left behind.
    if (ranked && (await store.activeRankedRun(user.id))) throw new GameError("ranked_in_progress");
    // Pay first (the transaction checks the points), and give them back if the run cannot be created.
    const profile = startItems.length > 0 ? await store.updateProfile(user.id, (p) => payStartItems(p, startItems)) : user.profile;
    let state: RunState;
    try {
      state = await startRun(store, { playerId: user.id, playerName: user.username, champion, lockedLines, ranked, starter, startItems });
    } catch (e) {
      if (startItems.length > 0) await store.updateProfile(user.id, (p) => ({ ...p, points: p.points + startItems.length * META_RULES.startItemPrice }));
      throw e;
    }
    return c.json({ state: publicState(state), account: { username: user.username, profile } });
  });

  app.get("/api/runs/:runId", async (c) => {
    const user = await requireUser(c);
    const state = await loadRun(store, { playerId: user.id, runId: c.req.param("runId") });
    await settleIfEnded(user, state);
    return c.json({ state: publicState(state) });
  });

  // Actions up to one that needs the hidden seed (reroll, opening a Poké Ball, choosing a subclass):
  // applied and committed for good, then the resulting shop/stash is returned.
  app.post("/api/runs/:runId/act", async (c) => {
    const user = await requireUser(c);
    const b = await body<{ round: number; actions: Action[] }>(c);
    if (typeof b.round !== "number" || !Array.isArray(b.actions)) throw new GameError("bad_request");
    const state = await commitActions(store, { playerId: user.id, runId: c.req.param("runId"), round: b.round, actions: b.actions });
    return c.json({ state: publicState(state) });
  });

  app.post("/api/runs/:runId/turn", async (c) => {
    const user = await requireUser(c);
    const b = await body<{ round: number; actions: Action[] }>(c);
    if (typeof b.round !== "number" || !Array.isArray(b.actions)) throw new GameError("bad_request");
    const turn = await playRound(store, {
      playerId: user.id,
      runId: c.req.param("runId"),
      round: b.round,
      actions: b.actions,
      rating: user.profile.rating,
    });
    const reward = await settleIfEnded(user, turn.state);
    return c.json({ ...turn, state: publicState(turn.state), ...(reward ? { reward } : {}) });
  });

  // ───────────────────────────── balance statistics

  app.get("/api/admin/stats", async (c) => {
    if (!opts.adminToken) return c.json({ error: "not_found" }, 404);
    if (!sameSecret(c.req.header("authorization") ?? "", `Bearer ${opts.adminToken}`)) return c.json({ error: "unauthorized" }, 401);
    const filter = statsFilter((k) => c.req.query(k));
    const report = await collectStats(store.db, filter);
    return c.req.query("format") === "md" ? c.text(statsMarkdown(report, filter)) : c.json(report);
  });

  return app;
}
