import {
  buyChampion,
  buyPoolStage,
  chooseStarter,
  commitActions,
  GameError,
  keepStarterDraw,
  loadRun,
  MemoryStore,
  migrateRun,
  normalizeProfile,
  payStartItems,
  playRound,
  randomSeed,
  rngFor,
  runOptionsFor,
  settleRun,
  startRun,
  trainStarter,
  type Action,
  type ChampionKey,
  type GhostRecord,
  type Profile,
  type RunRecord,
  type RunState,
  type StartItem,
  type StarterTrainingKind,
  type TurnResponse,
} from "@pokebattles/game";

export interface RunSummary {
  runId: string;
  champion: ChampionKey;
  round: number;
  wins: number;
  losses: number;
  lives: number;
  phase: RunState["phase"];
  playerName: string;
  ranked: boolean;
}

export interface Account {
  /** null offline (no login there). */
  username: string | null;
  profile: Profile;
}

export interface LeaderboardEntry {
  username: string;
  rating: number;
  rankedRuns: number;
}

export interface Leaderboard {
  top: LeaderboardEntry[];
  me: (LeaderboardEntry & { rank: number }) | null;
  players: number;
}

export interface GameApi {
  mode: "online" | "offline";
  /** The logged-in account, or null when a login is needed (online only). */
  account(): Promise<Account | null>;
  register(username: string, password: string): Promise<Account>;
  login(username: string, password: string): Promise<Account>;
  logout(): Promise<void>;
  chooseStarter(champion: ChampionKey): Promise<Account>;
  buyChampion(champion: ChampionKey): Promise<Account>;
  /** Opens the next stage of an owned champion's shop pool for points. */
  buyPoolStage(champion: ChampionKey): Promise<Account>;
  /** A nature or ability draw, or +1 IV, for a champion's starter (the draw then waits for keepStarterDraw). */
  trainStarter(champion: ChampionKey, kind: StarterTrainingKind): Promise<Account>;
  keepStarterDraw(champion: ChampionKey, keep: boolean): Promise<Account>;
  leaderboard(): Promise<Leaderboard>;
  listRuns(): Promise<RunSummary[]>;
  /** Starts a run, paying for its start items; the account comes back with the points spent. */
  startRun(champion: ChampionKey, ranked: boolean, startItems?: StartItem[]): Promise<{ state: RunState; account: Account }>;
  getRun(runId: string): Promise<RunState>;
  /**
   * Commits this round's actions ending in one the client cannot resolve itself (a reroll, opening a
   * Poké Ball, choosing a subclass: the seed stays on the server). Returns the state after them.
   */
  act(runId: string, round: number, actions: Action[]): Promise<RunState>;
  /** Ends the round with the actions since the last commit. */
  playTurn(runId: string, round: number, actions: Action[]): Promise<TurnResponse>;
  /** Called when the server says the login is gone (expired or logged out elsewhere). */
  onUnauthorized: (() => void) | null;
}

function summary(s: RunState): RunSummary {
  return {
    runId: s.runId,
    champion: s.champion,
    round: s.round,
    wins: s.wins,
    losses: s.losses,
    lives: s.lives,
    phase: s.phase,
    playerName: s.playerName,
    ranked: !!s.ranked,
  };
}

function storage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

/** Where the API lives: same origin by default, or VITE_API_URL when the client is hosted apart from the server. */
const API_BASE = ((import.meta.env.VITE_API_URL as string | undefined) ?? "").replace(/\/+$/, "");
const TOKEN_KEY = "pokebattles.token";

class RemoteApi implements GameApi {
  mode = "online" as const;
  onUnauthorized: (() => void) | null = null;
  private token: string | null = storage()?.getItem(TOKEN_KEY) ?? null;

  private setToken(token: string | null) {
    this.token = token;
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* private mode: the login lasts until the tab closes */
    }
  }

  private async call<T>(path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${API_BASE}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new GameError("network");
    }
    const data = (await res.json().catch(() => ({}))) as { error?: string } & T;
    if (!res.ok) {
      if (res.status === 401 && this.token) {
        this.setToken(null);
        this.onUnauthorized?.();
      }
      throw new GameError(data.error ?? "internal");
    }
    return data;
  }

  async account() {
    if (!this.token) return null;
    try {
      return (await this.call<{ account: Account }>("/api/me")).account;
    } catch (e) {
      if (e instanceof GameError && e.code === "unauthorized") return null;
      throw e;
    }
  }
  async register(username: string, password: string) {
    const r = await this.call<{ token: string; account: Account }>("/api/auth/register", { username, password });
    this.setToken(r.token);
    return r.account;
  }
  async login(username: string, password: string) {
    const r = await this.call<{ token: string; account: Account }>("/api/auth/login", { username, password });
    this.setToken(r.token);
    return r.account;
  }
  async logout() {
    await this.call("/api/auth/logout", {}).catch(() => undefined);
    this.setToken(null);
  }
  async chooseStarter(champion: ChampionKey) {
    return (await this.call<{ account: Account }>("/api/me/starter", { champion })).account;
  }
  async buyChampion(champion: ChampionKey) {
    return (await this.call<{ account: Account }>("/api/me/champions", { champion })).account;
  }
  async buyPoolStage(champion: ChampionKey) {
    return (await this.call<{ account: Account }>("/api/me/pool", { champion })).account;
  }
  async trainStarter(champion: ChampionKey, kind: StarterTrainingKind) {
    return (await this.call<{ account: Account }>("/api/me/starter-train", { champion, kind })).account;
  }
  async keepStarterDraw(champion: ChampionKey, keep: boolean) {
    return (await this.call<{ account: Account }>("/api/me/starter-keep", { champion, keep })).account;
  }
  async leaderboard() {
    return this.call<Leaderboard>("/api/leaderboard");
  }
  async listRuns() {
    return (await this.call<{ runs: RunSummary[] }>("/api/runs")).runs;
  }
  async startRun(champion: ChampionKey, ranked: boolean, startItems: StartItem[] = []) {
    return this.call<{ state: RunState; account: Account }>("/api/runs", { champion, ranked, startItems });
  }
  async getRun(runId: string) {
    return migrateRun((await this.call<{ state: RunState }>(`/api/runs/${runId}`)).state);
  }
  async act(runId: string, round: number, actions: Action[]) {
    return (await this.call<{ state: RunState }>(`/api/runs/${runId}/act`, { round, actions })).state;
  }
  async playTurn(runId: string, round: number, actions: Action[]) {
    return this.call<TurnResponse>(`/api/runs/${runId}/turn`, { round, actions });
  }
}

const OFFLINE_KEY = "pokebattles.offline.v1";
const OFFLINE_PROFILE_KEY = "pokebattles.offline.profile.v1";

/**
 * Offline play runs the exact server logic in the browser. Each run uses its own player id so
 * ghosts of your earlier runs can become opponents; otherwise bots fill in. Progression (points,
 * champions, unlocks) follows the same rules with a profile kept in this browser; ranked needs the server.
 */
class LocalApi implements GameApi {
  mode = "offline" as const;
  onUnauthorized: (() => void) | null = null;
  private readonly store = new MemoryStore();
  private profile: Profile;

  constructor() {
    try {
      const raw = localStorage.getItem(OFFLINE_KEY);
      if (raw) {
        const data = JSON.parse(raw) as { runs: RunRecord[]; ghosts: GhostRecord[] };
        for (const r of data.runs) this.store.runs.set(r.runId, r);
        this.store.ghosts = data.ghosts;
      }
    } catch {
      /* corrupted or unavailable storage: start fresh */
    }
    let stored: Partial<Profile> | null = null;
    try {
      stored = JSON.parse(localStorage.getItem(OFFLINE_PROFILE_KEY) ?? "null");
    } catch {
      /* start fresh */
    }
    this.profile = normalizeProfile(stored);
  }

  private save() {
    try {
      const runs = [...this.store.runs.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10);
      localStorage.setItem(OFFLINE_KEY, JSON.stringify({ runs, ghosts: this.store.ghosts.slice(-150) }));
      localStorage.setItem(OFFLINE_PROFILE_KEY, JSON.stringify(this.profile));
    } catch {
      /* quota exceeded: keep going in memory */
    }
  }

  private me(): Account {
    return { username: null, profile: structuredClone(this.profile) };
  }

  async account() {
    return this.me();
  }
  async register(): Promise<Account> {
    throw new GameError("network");
  }
  async login(): Promise<Account> {
    throw new GameError("network");
  }
  async logout() {}
  async chooseStarter(champion: ChampionKey) {
    this.profile = chooseStarter(this.profile, champion);
    this.save();
    return this.me();
  }
  async buyChampion(champion: ChampionKey) {
    this.profile = buyChampion(this.profile, champion);
    this.save();
    return this.me();
  }
  async buyPoolStage(champion: ChampionKey) {
    this.profile = buyPoolStage(this.profile, champion);
    this.save();
    return this.me();
  }
  async trainStarter(champion: ChampionKey, kind: StarterTrainingKind) {
    this.profile = trainStarter(this.profile, champion, kind, rngFor(randomSeed(), "train"));
    this.save();
    return this.me();
  }
  async keepStarterDraw(champion: ChampionKey, keep: boolean) {
    this.profile = keepStarterDraw(this.profile, champion, keep);
    this.save();
    return this.me();
  }
  async leaderboard(): Promise<Leaderboard> {
    throw new GameError("ranked_offline");
  }
  async listRuns() {
    return [...this.store.runs.values()].sort((a, b) => b.updatedAt - a.updatedAt).map((r) => summary(r.state));
  }
  async startRun(champion: ChampionKey, ranked: boolean, startItems: StartItem[] = []) {
    if (ranked) throw new GameError("ranked_offline");
    const { lockedLines, starter } = runOptionsFor(this.profile, champion);
    const paid = payStartItems(this.profile, startItems);
    const state = await startRun(this.store, { playerId: "offline", playerName: "Trainer", champion, lockedLines, starter, startItems });
    this.profile = paid;
    const rec = this.store.runs.get(state.runId)!;
    rec.playerId = `offline-${state.runId}`;
    this.save();
    return { state, account: this.me() };
  }
  async getRun(runId: string) {
    const rec = this.store.runs.get(runId);
    if (!rec) throw new GameError("run_not_found");
    return loadRun(this.store, { playerId: rec.playerId, runId });
  }
  /** Offline states keep their seed, so the client resolves everything itself; this is only a fallback. */
  async act(runId: string, round: number, actions: Action[]) {
    const rec = this.store.runs.get(runId);
    if (!rec) throw new GameError("run_not_found");
    const state = await commitActions(this.store, { playerId: rec.playerId, runId, round, actions });
    this.save();
    return state;
  }
  async playTurn(runId: string, round: number, actions: Action[]) {
    const rec = this.store.runs.get(runId);
    if (!rec) throw new GameError("run_not_found");
    const out = await playRound(this.store, { playerId: rec.playerId, runId, round, actions });
    // A run ends in exactly one turn (later turns throw run_ended), so this settles it once.
    if (out.state.phase === "ended") {
      const settled = settleRun(this.profile, out.state);
      this.profile = settled.profile;
      out.reward = settled.reward;
    }
    this.save();
    return out;
  }
}

export async function createApi(): Promise<GameApi> {
  try {
    // The first request through a tunnel to a home server can take a few seconds (new TLS connection, far edge).
    // A server that is down answers at once (the tunnel's error page), so a long wait only covers slow answers.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`${API_BASE}/api/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (res.ok && (await res.json()).ok) return new RemoteApi();
  } catch {
    /* fall through */
  }
  return new LocalApi();
}
