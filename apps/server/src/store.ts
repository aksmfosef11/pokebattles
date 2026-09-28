import {
  META_RULES,
  normalizeProfile,
  WINS_TO_CLEAR,
  type BattleRecord,
  type GameStore,
  type GhostRecord,
  type Piece,
  type Profile,
  type RatingRange,
  type RunRecord,
  type RunReward,
  type RunState,
} from "@pokebattles/game";
import { isUniqueViolation, type Db, type Queryable } from "./db.ts";
import { migrate } from "./schema.ts";

export interface UserRow {
  id: string;
  username: string;
  password: string;
  profile: Profile;
  createdAt: number;
}

/** How a run started, kept for balance statistics (runs.context, copied to run_results.context). */
export interface RunContext {
  /** Pool unlock stage of the champion (meta/progress.ts) and how many evolution lines it still hid. */
  poolStage: number;
  lockedLines: number;
  startItems: string[];
  /** Starter training the run started with: a kept nature / ability, and the IV bonus summed over the six stats. */
  starter: { nature: boolean; ability: boolean; ivBonus: number };
  /** Runs this player had finished before (all champions) and with this champion. */
  finishedRuns: number;
  championRuns: number;
  /** Ranked runs: the rating the run started at. */
  rating?: number;
}

export interface LeaderboardEntry {
  username: string;
  rating: number;
  rankedRuns: number;
}

/**
 * A trainer's finished runs with one champion (normal and ranked): battles won and 10-win trophies.
 * The number of runs stays private: with it anyone could work out the trainer's win rate.
 */
export interface ChampionWinsEntry {
  username: string;
  wins: number;
  trophies: number;
}

// BIGINT columns come back as strings from pg; everything numeric goes through Number().
type RunDbRow = { run_id: string; player_id: string; state: RunState; pending: RunRecord["pending"] | null; created_at: string | number; updated_at: string | number };
type UserDbRow = { id: string; username: string; password: string; profile: Partial<Profile> | null; created_at: string | number };
type GhostDbRow = {
  id: string;
  run_id: string;
  player_id: string;
  round: number;
  wins: number;
  losses: number;
  team: GhostRecord["team"];
  created_at: string | number;
  ranked: boolean;
  rating: number | null;
};

/** Species and item keys of placed pieces: what the balance statistics look at. */
function teamSummary(pieces: readonly Piece[]): { species: string[]; items: string[] } {
  const species: string[] = [];
  const items: string[] = [];
  for (const p of pieces) {
    if (p.kind === "pokemon") species.push(p.species);
    else if (p.kind === "item") items.push(p.item);
  }
  return { species, items };
}

/** JSON parameters go in as text and are cast with ::jsonb (pg would turn a JS array into a Postgres array). */
const json = (value: unknown) => JSON.stringify(value);

function runFromRow(row: RunDbRow): RunRecord {
  return {
    runId: row.run_id,
    playerId: row.player_id,
    state: row.state,
    ...(row.pending ? { pending: row.pending } : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function ghostFromRow(r: GhostDbRow): GhostRecord {
  return {
    id: r.id,
    runId: r.run_id,
    playerId: r.player_id,
    round: Number(r.round),
    wins: Number(r.wins),
    losses: Number(r.losses),
    team: r.team,
    createdAt: Number(r.created_at),
    ranked: r.ranked,
    rating: r.rating === null ? null : Number(r.rating),
  };
}

function userFromRow(row: UserDbRow): UserRow {
  return { id: row.id, username: row.username, password: row.password, profile: normalizeProfile(row.profile), createdAt: Number(row.created_at) };
}

/** Recent ghosts of a round looked at when matching (then narrowed to one per player). */
const GHOST_SCAN = 2000;

/** Thrown inside a transaction to roll it back quietly. */
class Rollback extends Error {}

/** PostgreSQL persistence for accounts, runs, ghosts (async-PvP opponents), battle history and run results. */
export class PgStore implements GameStore {
  private constructor(
    readonly db: Db,
    /** Server build written into battles and run results, so statistics can be split by deploy. */
    readonly build: string | null,
  ) {}

  /** Opens the store on `db`, bringing its schema up to date first. */
  static async open(db: Db, opts: { build?: string } = {}): Promise<PgStore> {
    await migrate(db);
    return new PgStore(db, opts.build ?? null);
  }

  /** Throws when the database cannot be reached (health check). */
  async ping(): Promise<void> {
    await this.db.query("SELECT 1");
  }

  // ───────────────────────────── accounts

  async createUser(user: UserRow): Promise<boolean> {
    try {
      await this.db.query(
        `INSERT INTO users (id, username, password, profile, rating, ranked_runs, created_at) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
        [user.id, user.username, user.password, json(user.profile), user.profile.rating, user.profile.rankedRuns, user.createdAt],
      );
      return true;
    } catch (e) {
      if (isUniqueViolation(e)) return false;
      throw e;
    }
  }

  async userByName(username: string): Promise<UserRow | null> {
    const [row] = await this.db.query<UserDbRow>("SELECT * FROM users WHERE lower(username) = lower($1)", [username]);
    return row ? userFromRow(row) : null;
  }

  async userById(id: string, q: Queryable = this.db): Promise<UserRow | null> {
    const [row] = await q.query<UserDbRow>("SELECT * FROM users WHERE id = $1", [id]);
    return row ? userFromRow(row) : null;
  }

  async saveProfile(userId: string, profile: Profile, q: Queryable = this.db): Promise<void> {
    await q.query("UPDATE users SET profile = $1::jsonb, rating = $2, ranked_runs = $3 WHERE id = $4", [json(profile), profile.rating, profile.rankedRuns, userId]);
  }

  /** The user row, locked until the transaction ends: concurrent changes to one profile take turns. */
  private async lockUser(q: Queryable, userId: string): Promise<UserRow | null> {
    const [row] = await q.query<UserDbRow>("SELECT * FROM users WHERE id = $1 FOR UPDATE", [userId]);
    return row ? userFromRow(row) : null;
  }

  /** Reads, changes and saves a profile in one transaction (buying a champion, picking the starter). */
  updateProfile(userId: string, change: (p: Profile) => Profile): Promise<Profile> {
    return this.db.tx(async (q) => {
      const user = await this.lockUser(q, userId);
      if (!user) throw new Error("user vanished");
      const next = change(user.profile);
      await this.saveProfile(userId, next, q);
      return next;
    });
  }

  /**
   * Changes a user's ID and profile in one transaction (an ID change paid with points). Null when the
   * ID is taken; nothing changes then.
   */
  async renameUser(userId: string, username: string, change: (p: Profile) => Profile): Promise<Profile | null> {
    try {
      return await this.db.tx(async (q) => {
        const user = await this.lockUser(q, userId);
        if (!user) throw new Error("user vanished");
        const next = change(user.profile);
        await q.query("UPDATE users SET username = $1, profile = $2::jsonb WHERE id = $3", [username, json(next), userId]);
        return next;
      });
    } catch (e) {
      if (isUniqueViolation(e)) return null;
      throw e;
    }
  }

  async addSession(tokenHash: string, userId: string): Promise<void> {
    await this.db.query("INSERT INTO sessions (token_hash, user_id, created_at) VALUES ($1, $2, $3)", [tokenHash, userId, Date.now()]);
  }

  async sessionUser(tokenHash: string): Promise<UserRow | null> {
    const [row] = await this.db.query<UserDbRow>("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1", [tokenHash]);
    return row ? userFromRow(row) : null;
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.db.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash]);
  }

  async leaderboard(limit: number): Promise<LeaderboardEntry[]> {
    const rows = await this.db.query<{ username: string; rating: number; ranked_runs: number }>(
      "SELECT username, rating, ranked_runs FROM users WHERE ranked_runs > 0 ORDER BY rating DESC, ranked_runs ASC, created_at ASC LIMIT $1",
      [limit],
    );
    return rows.map((r) => ({ username: r.username, rating: Number(r.rating), rankedRuns: Number(r.ranked_runs) }));
  }

  /** 1-based place among ranked players (ties share the better place). */
  async rankOf(rating: number): Promise<number> {
    const [row] = await this.db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM users WHERE ranked_runs > 0 AND rating > $1", [rating]);
    return Number(row!.n) + 1;
  }

  async rankedPlayers(): Promise<number> {
    const [row] = await this.db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM users WHERE ranked_runs > 0");
    return Number(row!.n);
  }

  /**
   * Trainers by battles won with `champion` over all their finished runs, for trainers with at least
   * one win: the top `limit`, the given user's own entry and place (ties share the better place), and
   * how many trainers are ranked.
   */
  async championWins(
    champion: string,
    limit: number,
    userId: string | null,
  ): Promise<{ top: ChampionWinsEntry[]; me: (ChampionWinsEntry & { rank: number }) | null; players: number }> {
    const totals = `SELECT user_id, SUM(wins)::int AS wins, COUNT(*) FILTER (WHERE wins >= $2)::int AS trophies
      FROM run_results WHERE champion = $1 GROUP BY user_id HAVING SUM(wins) > 0`;
    type Row = { username: string; wins: number; trophies: number };
    const entry = (r: Row): ChampionWinsEntry => ({ username: r.username, wins: Number(r.wins), trophies: Number(r.trophies) });
    // Not ordered by runs either: fewer runs for the same wins would give the win rate away.
    const rows = await this.db.query<Row>(
      `SELECT u.username, t.wins, t.trophies FROM (${totals}) t JOIN users u ON u.id = t.user_id
       ORDER BY t.wins DESC, t.trophies DESC, u.created_at ASC LIMIT $3`,
      [champion, WINS_TO_CLEAR, limit],
    );
    const [stats] = await this.db.query<Row & { rank: number | null; players: number }>(
      `WITH t AS (${totals})
       SELECT u.username, m.wins, m.trophies, (SELECT COUNT(*)::int FROM t WHERE t.wins > m.wins) + 1 AS rank, (SELECT COUNT(*)::int FROM t) AS players
       FROM (SELECT 1) one LEFT JOIN t m ON m.user_id = $3 LEFT JOIN users u ON u.id = m.user_id`,
      [champion, WINS_TO_CLEAR, userId],
    );
    const me = stats?.username ? { ...entry(stats), rank: Number(stats.rank) } : null;
    return { top: rows.map(entry), me, players: Number(stats?.players ?? 0) };
  }

  /**
   * Settles a finished run once: applies `settle` to the owner's profile and records the result for
   * statistics. Returns null when the run was already settled. The owner's row stays locked while
   * this runs, so two requests that both see the run ended cannot both pay out.
   */
  async settleRun(userId: string, state: RunState, settle: (p: Profile) => { profile: Profile; reward: RunReward }): Promise<RunReward | null> {
    try {
      return await this.db.tx(async (q) => {
        const user = await this.lockUser(q, userId);
        if (!user) return null;
        const [done] = await q.query("SELECT 1 FROM run_results WHERE run_id = $1", [state.runId]);
        if (done) return null;
        const { profile, reward } = settle(user.profile);
        const team = teamSummary(Object.values(state.pieces).filter((p) => p.place !== null));
        const inserted = await q.query(
          `INSERT INTO run_results (run_id, user_id, champion, subclass, ranked, wins, losses, rounds, points, rating_before, rating_after, species, items, ended_at,
             build, context)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14, $15, (SELECT context FROM runs WHERE run_id = $1))
           ON CONFLICT (run_id) DO NOTHING RETURNING run_id`,
          [
            state.runId,
            userId,
            state.champion,
            state.subclass ?? null,
            !!state.ranked,
            state.wins,
            state.losses,
            state.log.length,
            reward.points,
            reward.rating?.before ?? null,
            reward.rating?.after ?? null,
            json(team.species),
            json(team.items),
            Date.now(),
            this.build,
          ],
        );
        // Settled by someone who did not hold the owner's lock (cannot happen today): pay nothing.
        if (inserted.length === 0) throw new Rollback();
        await this.saveProfile(userId, profile, q);
        return reward;
      });
    } catch (e) {
      if (e instanceof Rollback) return null;
      throw e;
    }
  }

  // ───────────────────────────── runs, ghosts, battles (GameStore)

  async getRun(runId: string): Promise<RunRecord | null> {
    const [row] = await this.db.query<RunDbRow>("SELECT * FROM runs WHERE run_id = $1", [runId]);
    return row ? runFromRow(row) : null;
  }

  async putRun(r: RunRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO runs (run_id, player_id, state, created_at, updated_at, ranked, phase, pending) VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8::jsonb)
       ON CONFLICT (run_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at, phase = excluded.phase, pending = excluded.pending`,
      [r.runId, r.playerId, json(r.state), r.createdAt, r.updatedAt, !!r.state.ranked, r.state.phase, r.pending?.length ? json(r.pending) : null],
    );
  }

  async setRunContext(runId: string, context: RunContext): Promise<void> {
    await this.db.query("UPDATE runs SET context = $2::jsonb WHERE run_id = $1", [runId, json(context)]);
  }

  /** The player's unfinished ranked run, if any (only one at a time). */
  async activeRankedRun(playerId: string): Promise<string | null> {
    const [row] = await this.db.query<{ run_id: string }>("SELECT run_id FROM runs WHERE player_id = $1 AND ranked AND phase <> 'ended' LIMIT 1", [playerId]);
    return row?.run_id ?? null;
  }

  async addGhost(g: GhostRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO ghosts (id, run_id, player_id, round, wins, losses, team, created_at, ranked, rating)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)
       ON CONFLICT (id) DO UPDATE SET run_id = excluded.run_id, player_id = excluded.player_id, round = excluded.round, wins = excluded.wins,
         losses = excluded.losses, team = excluded.team, created_at = excluded.created_at, ranked = excluded.ranked, rating = excluded.rating`,
      [g.id, g.runId, g.playerId, g.round, g.wins, g.losses, json(g.team), g.createdAt, !!g.ranked, g.rating ?? null],
    );
  }

  async getGhost(id: string): Promise<GhostRecord | null> {
    const [r] = await this.db.query<GhostDbRow>("SELECT * FROM ghosts WHERE id = $1", [id]);
    return r ? ghostFromRow(r) : null;
  }

  async findGhosts(round: number, playerId: string, limit: number, ranked: boolean, ratings?: RatingRange): Promise<GhostRecord[]> {
    // Each player's latest ghost among the round's most recent ones (in the rating range, if any): many
    // runs (or a flood of empty runs) from one account still count as one opponent.
    const rows = await this.db.query<GhostDbRow>(
      `SELECT * FROM (
         SELECT g.*, ROW_NUMBER() OVER (PARTITION BY player_id ORDER BY created_at DESC) AS nth
         FROM (SELECT * FROM ghosts WHERE round = $1 AND ranked = $2 AND player_id <> $3
                 AND ($6::integer IS NULL OR COALESCE(rating, $8::integer) BETWEEN $6::integer AND $7::integer)
               ORDER BY created_at DESC LIMIT $4) g
       ) latest WHERE nth = 1 ORDER BY created_at DESC LIMIT $5`,
      [round, ranked, playerId, GHOST_SCAN, limit, ratings?.min ?? null, ratings?.max ?? null, META_RULES.startRating],
    );
    // Oldest first so the matchmaker's weighted pick is stable for a given pool.
    return rows.reverse().map(ghostFromRow);
  }

  async addBattle(b: BattleRecord): Promise<void> {
    const [you, opp] = b.teams;
    const mine = teamSummary(you.pieces);
    const theirs = teamSummary(opp.pieces);
    await this.db.query(
      `INSERT INTO battles (id, run_id, round, seed, ghost_id, outcome, created_at, player_id, ranked, ghost, champion, subclass, wins, losses,
         species, items, opp_champion, opp_subclass, opp_species, opp_items, detail, shop, build)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16::jsonb, $17, $18, $19::jsonb, $20::jsonb,
         $21::jsonb, $22::jsonb, $23)
       ON CONFLICT (id) DO UPDATE SET run_id = excluded.run_id, round = excluded.round, seed = excluded.seed, ghost_id = excluded.ghost_id,
         outcome = excluded.outcome, created_at = excluded.created_at, player_id = excluded.player_id, ranked = excluded.ranked, ghost = excluded.ghost,
         champion = excluded.champion, subclass = excluded.subclass, wins = excluded.wins, losses = excluded.losses, species = excluded.species,
         items = excluded.items, opp_champion = excluded.opp_champion, opp_subclass = excluded.opp_subclass, opp_species = excluded.opp_species,
         opp_items = excluded.opp_items, detail = excluded.detail, shop = excluded.shop, build = excluded.build`,
      [
        b.id,
        b.runId,
        b.round,
        b.seed,
        b.ghostId ?? null,
        b.outcome,
        b.createdAt,
        b.playerId,
        b.ranked,
        !!b.ghostId,
        you.champion,
        you.subclass ?? null,
        you.wins,
        you.losses,
        json(mine.species),
        json(mine.items),
        opp.champion,
        opp.subclass ?? null,
        json(theirs.species),
        json(theirs.items),
        b.detail ? json(b.detail) : null,
        b.shop ? json(b.shop) : null,
        this.build,
      ],
    );
  }

  /**
   * Everything about one run for replaying it elsewhere (admin only): the stored state with its seed,
   * how it started, its result, its battles and the boards of the ghosts it met, and the owner's starter
   * training now (the run itself only keeps the traits it rolled).
   */
  async inspectRun(runId: string): Promise<Record<string, unknown> | null> {
    const [run] = await this.db.query<RunDbRow & { context: RunContext | null }>("SELECT * FROM runs WHERE run_id = $1", [runId]);
    if (!run) return null;
    const [user] = await this.db.query<UserDbRow>("SELECT * FROM users WHERE id = $1", [run.player_id]);
    const [result] = await this.db.query("SELECT * FROM run_results WHERE run_id = $1", [runId]);
    const battles = await this.db.query<{ ghost_id: string | null }>("SELECT * FROM battles WHERE run_id = $1 ORDER BY round", [runId]);
    const ids = battles.flatMap((b) => (b.ghost_id ? [b.ghost_id] : []));
    const ghosts = ids.length ? await this.db.query<GhostDbRow>(`SELECT * FROM ghosts WHERE id IN (${ids.map((_, i) => `$${i + 1}`).join(", ")})`, ids) : [];
    const record = runFromRow(run);
    const owner = user ? userFromRow(user) : null;
    return {
      run: { ...record, context: run.context ?? null },
      username: owner?.username ?? null,
      starter: owner ? (owner.profile.starters[record.state.champion] ?? {}) : null,
      result: result ?? null,
      battles,
      ghosts: Object.fromEntries(ghosts.map((g) => [g.id, { team: g.team, rating: g.rating === null ? null : Number(g.rating), wins: Number(g.wins), losses: Number(g.losses) }])),
    };
  }

  /** Unfinished runs first (the title screen continues them), then the latest finished ones. */
  async listRuns(playerId: string): Promise<RunRecord[]> {
    const rows = await this.db.query<RunDbRow>("SELECT * FROM runs WHERE player_id = $1 ORDER BY phase = 'ended', updated_at DESC LIMIT 20", [playerId]);
    return rows.map(runFromRow);
  }

  close(): Promise<void> {
    return this.db.close();
  }
}
