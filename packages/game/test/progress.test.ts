import { describe, expect, it } from "vitest";
import {
  applyAction,
  BOT_RATINGS,
  buyChampion,
  CHAMPION_KEYS,
  CHAMPIONS,
  championPool,
  chooseStarter,
  createRun,
  getSpecies,
  lineBase,
  lockedLinesAt,
  META_RULES,
  newProfile,
  nextPoolUnlock,
  normalizeProfile,
  POOL_UNLOCK_RUNS,
  poolUnlockStages,
  rankedDelta,
  rankTier,
  rollShop,
  runOptionsFor,
  settleRun,
  speciesOfStage,
  type BattleOutcome,
  type ItemPiece,
  type RoundLog,
  type RunState,
} from "../src/index.ts";

const last = POOL_UNLOCK_RUNS.length - 1;

describe("champion pool unlock stages", () => {
  it("split the full pool into disjoint stages", () => {
    for (const c of CHAMPION_KEYS) {
      const stages = poolUnlockStages(c);
      expect(stages).toHaveLength(POOL_UNLOCK_RUNS.length);
      const lines = stages.flat();
      expect(new Set(lines).size, c).toBe(lines.length);
      expect(new Set(lines), c).toEqual(new Set([...championPool(c)].map(lineBase)));
      expect(lockedLinesAt(c, last)).toEqual([]);
      expect(championPool({ champion: c, lockedLines: lockedLinesAt(c, last) })).toBe(championPool(c));
      for (let s = 1; s <= last; s++) expect(stages[s]!.length, `${c} stage ${s}`).toBeGreaterThan(0);
    }
  });

  it("start with the champion's real squad and starter, and no legendaries", () => {
    for (const c of CHAMPION_KEYS) {
      const first = new Set(poolUnlockStages(c)[0]);
      const def = CHAMPIONS[c];
      for (const key of [def.starter.species, ...def.squad]) expect(first.has(lineBase(key)), `${c} ${key}`).toBe(true);
      for (const key of championPool({ champion: c, lockedLines: lockedLinesAt(c, 0) })) {
        const s = getSpecies(key);
        expect(s.legendary || s.mythical || s.subLegendary, `${c} ${key}`).toBe(false);
      }
      expect(championPool({ champion: c, lockedLines: lockedLinesAt(c, 0) }).size, c).toBeGreaterThanOrEqual(15);
    }
  });

  it("keep locked lines out of the shop, Poké Balls and Vouchers", () => {
    for (const c of ["red", "cynthia", "alder"] as const) {
      const lockedLines = lockedLinesAt(c, 0);
      const locked = new Set(lockedLines);
      const base = createRun({ runId: `lock-${c}`, seed: `lock-${c}`, playerName: "t", champion: c, lockedLines });
      expect(base.lockedLines).toEqual(lockedLines);
      for (const round of [1, 6, 12, 17]) {
        for (let i = 0; i < 20; i++) {
          for (const slot of rollShop({ ...base, round }, i)) {
            if (slot.offer?.kind === "pokemon") expect(locked.has(lineBase(slot.offer.species)), `${c} ${slot.offer.species}`).toBe(false);
          }
        }
      }
      for (const item of ["POKE_BALL", "ULTRA_BALL", "VOUCHER"]) {
        for (let i = 0; i < 10; i++) {
          const ball: ItemPiece = { uid: "ball", kind: "item", place: null, paid: 0, item, age: 0 };
          const state: RunState = { ...base, round: 12, seed: `${item}-${i}`, pieces: { ...base.pieces, ball } };
          const after = applyAction(state, { t: "use", uid: "ball" });
          const fresh = Object.values(after.pieces).find((p) => p.kind === "pokemon" && !base.pieces[p.uid]);
          expect(fresh?.kind === "pokemon" && !locked.has(lineBase(fresh.species)), `${c} ${item}`).toBe(true);
        }
      }
    }
  });
});

describe("profile", () => {
  it("gets one free starter, then buys champions with points", () => {
    const p = chooseStarter(newProfile(), "leon");
    expect(p.champions).toEqual(["leon"]);
    expect(() => chooseStarter(p, "red")).toThrow("starter_chosen");
    expect(() => buyChampion(p, "red")).toThrow("not_enough_points");
    expect(() => buyChampion(p, "leon")).toThrow("champion_owned");
    expect(() => buyChampion(p, "nobody")).toThrow("invalid_champion");
    const rich = buyChampion({ ...p, points: META_RULES.championPrice }, "red");
    expect(rich).toMatchObject({ points: 0, champions: ["leon", "red"] });
    expect(() => runOptionsFor(p, "red")).toThrow("champion_locked");
    expect(runOptionsFor(rich, "red").lockedLines).toEqual(lockedLinesAt("red", 0));
  });

  it("opens a champion's pool by finished runs with them", () => {
    let p = chooseStarter(newProfile(), "geeta");
    const ended = { ...createRun({ runId: "e", seed: "e", playerName: "t", champion: "geeta" }), phase: "ended" as const };
    const unlockedAt: number[] = [];
    for (let run = 1; run <= POOL_UNLOCK_RUNS[last]! + 1; run++) {
      const upcoming = nextPoolUnlock(p, "geeta");
      const { profile, reward } = settleRun(p, ended);
      if (reward.unlocked.length > 0) {
        unlockedAt.push(run);
        expect(reward.unlocked).toEqual(upcoming!.species);
      }
      p = profile;
    }
    expect(unlockedAt).toEqual(POOL_UNLOCK_RUNS.slice(1));
    expect(nextPoolUnlock(p, "geeta")).toBeNull();
    expect(runOptionsFor(p, "geeta").lockedLines).toEqual([]);
    expect(speciesOfStage("geeta", 1).length).toBeGreaterThan(0);
  });

  it("pays points for battles, wins and the trophy, and moves the rating only for ranked runs", () => {
    const run = createRun({ runId: "p", seed: "p", playerName: "t", champion: "red" });
    const log = (n: number) => Array.from({ length: n }, (_, i) => ({ round: i + 1, outcome: "win" as const, opponent: { name: "", champion: "red" as const, ghost: false }, goldEarned: 0 }));
    const cleared: RunState = { ...run, phase: "ended", wins: 10, losses: 2, log: log(12) };
    const p = chooseStarter(newProfile(), "red");
    const normal = settleRun(p, cleared);
    expect(normal.reward.points).toBe(12 * META_RULES.pointsPerBattle + 10 * META_RULES.pointsPerWin + META_RULES.clearBonus);
    expect(normal.reward.rating).toBeNull();
    expect(normal.profile.rating).toBe(p.rating);
    const ranked = settleRun(p, { ...cleared, ranked: true });
    expect(ranked.reward.rating).toEqual({ before: p.rating, after: p.rating + rankedDelta(p.rating, cleared.log) });
    expect(ranked.reward.rating!.after).toBeGreaterThan(p.rating);
    expect(ranked.profile.rankedRuns).toBe(1);
    expect(() => settleRun(p, run)).toThrow("run_not_ended");
  });

  it("rates each ranked battle against the opponent's rating (Elo)", () => {
    const at = META_RULES.startRating;
    const battle = (outcome: BattleOutcome, rating?: number): RoundLog => ({
      round: 1,
      outcome,
      opponent: { name: "", champion: "red", ghost: false, ...(rating !== undefined ? { rating } : {}) },
      goldEarned: 0,
    });
    const k = META_RULES.ratingK;
    expect(rankedDelta(at, [battle("win", at)])).toBe(k / 2);
    expect(rankedDelta(at, [battle("loss", at)])).toBe(-k / 2);
    expect(rankedDelta(at, [battle("draw", at)])).toBe(0);
    // No rating logged (a run from before ratings were logged): an even game.
    expect(rankedDelta(at, [battle("win")])).toBe(k / 2);
    expect(rankedDelta(at, [battle("win", at - 200)])).toBeLessThan(rankedDelta(at, [battle("win", at + 200)]));
    expect(rankedDelta(at, [battle("loss", at - 200)])).toBeLessThan(rankedDelta(at, [battle("loss", at + 200)]));
    // Far above the strongest bot, a whole run of wins over it is worth almost nothing, and one loss costs nearly K.
    const top = Math.max(...Object.values(BOT_RATINGS));
    expect(rankedDelta(top + 800, Array.from({ length: 10 }, () => battle("win", top)))).toBeLessThanOrEqual(2);
    expect(rankedDelta(top + 800, [battle("loss", top)])).toBeLessThanOrEqual(-k + 1);
    expect(rankTier(0)).toBe("POKE_BALL");
    expect(rankTier(5000)).toBe("MASTER_BALL");
  });

  it("repairs stored profiles", () => {
    expect(normalizeProfile(null)).toEqual(newProfile());
    expect(normalizeProfile({ points: -5, champions: ["red", "red", "bogus" as never], runs: { red: 2.7 } })).toMatchObject({
      points: 0,
      champions: ["red"],
      runs: { red: 2 },
      rating: META_RULES.startRating,
    });
  });
});
