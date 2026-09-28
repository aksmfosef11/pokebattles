import { describe, expect, it } from "vitest";
import {
  abilityOptions,
  applyAction,
  BOT_RATINGS,
  botShop,
  buyChampion,
  buyPoolStage,
  CHAMPION_KEYS,
  CHAMPIONS,
  championPool,
  chooseStarter,
  createRun,
  getSpecies,
  keepStarterDraw,
  lineBase,
  lockedLinesAt,
  MAX_IV,
  META_RULES,
  natureEffect,
  NATURES,
  newProfile,
  nextPoolUnlock,
  normalizeProfile,
  payStartItems,
  POOL_UNLOCK_RUNS,
  poolUnlockStages,
  publicState,
  rankedDelta,
  rankTier,
  readStartItems,
  rngFor,
  rollShop,
  runOptionsFor,
  settleRun,
  speciesOfStage,
  START_ITEMS,
  STAT_KEYS,
  trainStarter,
  type BattleOutcome,
  type ItemPiece,
  type PokemonPiece,
  type Profile,
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

  it("sells the next pool stage for points, and later runs keep opening stages on top of it", () => {
    const p = chooseStarter(newProfile(), "geeta");
    expect(() => buyPoolStage(p, "geeta")).toThrow("not_enough_points");
    expect(() => buyPoolStage({ ...p, points: 999 }, "red")).toThrow("champion_locked");
    expect(() => buyPoolStage({ ...p, points: 999 }, "nobody")).toThrow("invalid_champion");
    const upcoming = nextPoolUnlock(p, "geeta")!;
    let bought = buyPoolStage({ ...p, points: META_RULES.poolStagePrice + 5 }, "geeta");
    expect(bought).toMatchObject({ points: 5, poolBought: { geeta: 1 } });
    expect(runOptionsFor(bought, "geeta").lockedLines).toEqual(lockedLinesAt("geeta", 1));
    // The next stage still needs the runs of the first one.
    expect(nextPoolUnlock(bought, "geeta")).toEqual({ runsLeft: POOL_UNLOCK_RUNS[1]!, species: speciesOfStage("geeta", 2) });
    expect(upcoming.species).toEqual(speciesOfStage("geeta", 1));

    const ended = { ...createRun({ runId: "b", seed: "b", playerName: "t", champion: "geeta" }), phase: "ended" as const };
    const unlockedAt: number[] = [];
    for (let run = 1; run <= POOL_UNLOCK_RUNS[last]!; run++) {
      const { profile, reward } = settleRun(bought, ended);
      if (reward.unlocked.length > 0) unlockedAt.push(run);
      bought = profile;
    }
    // One stage ahead: the runs that would open stages 1 and 2 open stages 2 and 3.
    expect(unlockedAt).toEqual(POOL_UNLOCK_RUNS.slice(1, last));
    expect(nextPoolUnlock(bought, "geeta")).toBeNull();
    expect(() => buyPoolStage({ ...bought, points: 999 }, "geeta")).toThrow("pool_full");

    let rich = { ...p, points: 999 };
    for (let s = 1; s <= last; s++) rich = buyPoolStage(rich, "geeta");
    expect(rich.points).toBe(999 - last * META_RULES.poolStagePrice);
    expect(runOptionsFor(rich, "geeta").lockedLines).toEqual([]);
    expect(() => buyPoolStage(rich, "geeta")).toThrow("pool_full");
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

  it("trains a champion's starter: nature and ability draws to keep or drop, and +1 IV on a random stat", () => {
    const rng = rngFor("train");
    let p: Profile = { ...chooseStarter(newProfile(), "lance"), points: 1000 };
    expect(() => trainStarter(p, "red", "nature", rng)).toThrow("champion_locked");
    expect(() => trainStarter(p, "lance", "shiny", rng)).toThrow("bad_action");
    expect(() => trainStarter({ ...p, points: 5 }, "lance", "nature", rng)).toThrow("not_enough_points");
    expect(() => keepStarterDraw(p, "lance", true)).toThrow("no_draw");

    p = trainStarter(p, "lance", "nature", rng);
    expect(p.points).toBe(1000 - META_RULES.natureDrawPrice);
    const drawn = p.starters.lance!.draw!;
    expect(drawn.kind).toBe("nature");
    // Dropping a draw keeps what was there (nothing: rolled every run).
    expect(keepStarterDraw(p, "lance", false).starters.lance).toEqual({});
    p = keepStarterDraw(p, "lance", true);
    const nature = p.starters.lance!.nature!;
    expect(drawn).toEqual({ kind: "nature", nature });
    // The next draws never repeat the kept nature.
    for (let i = 0; i < 30; i++) {
      const again = trainStarter(p, "lance", "nature", rngFor("again", i)).starters.lance!.draw;
      expect(again?.kind === "nature" && again.nature).not.toBe(nature);
    }

    const options = abilityOptions(CHAMPIONS.lance.starter.species);
    expect(options.length).toBeGreaterThan(1);
    for (let i = 0; i < options.length; i++) {
      p = trainStarter(p, "lance", "ability", rngFor("ability", i));
      p = keepStarterDraw(p, "lance", true);
    }
    expect(p.points).toBe(1000 - META_RULES.natureDrawPrice - options.length * META_RULES.abilityDrawPrice);
    const kept = p.starters.lance!.ability!;
    expect(options).toContainEqual(kept);

    let iv = trainStarter(p, "lance", "iv", rng);
    const bonus = iv.starters.lance!.ivBonus!;
    expect(Object.values(bonus)).toEqual([1]);
    for (let i = 1; i < 6 * MAX_IV; i++) iv = trainStarter({ ...iv, points: 100 }, "lance", "iv", rngFor("iv", i));
    for (const k of STAT_KEYS) expect(iv.starters.lance!.ivBonus![k]).toBe(MAX_IV);
    expect(() => trainStarter({ ...iv, points: 100 }, "lance", "iv", rng)).toThrow("iv_maxed");

    // Runs start with the kept nature and ability, and the rolled IVs raised by the bonus.
    const options2 = runOptionsFor(iv, "lance");
    expect(options2.starter).toEqual({ nature, ability: kept, ivBonus: iv.starters.lance!.ivBonus });
    const plain = createRun({ runId: "s", seed: "s", playerName: "t", champion: "lance" });
    const trained = createRun({ runId: "s", seed: "s", playerName: "t", champion: "lance", starter: { ivBonus: { atk: 5 } } });
    const mon = (s: RunState) => Object.values(s.pieces).find((x): x is PokemonPiece => x.kind === "pokemon")!;
    expect(mon(trained).ivs.atk).toBe(Math.min(MAX_IV, mon(plain).ivs.atk + 5));
    expect(mon(trained).ivs.hp).toBe(mon(plain).ivs.hp);
    const full = mon(createRun({ runId: "s", seed: "s", playerName: "t", champion: "lance", starter: options2.starter }));
    expect(full).toMatchObject({ nature, ability: kept.ability, hiddenAbility: kept.hidden });
    for (const k of STAT_KEYS) expect(full.ivs[k]).toBe(MAX_IV);
    // A kept ability the species cannot have (after a roster change) is ignored.
    expect(mon(createRun({ runId: "s", seed: "s", playerName: "t", champion: "lance", starter: { ability: { ability: "WONDER_GUARD", hidden: false } } })).ability).toBe(
      mon(plain).ability,
    );
  });

  it("sells start items: a Mint of a random raising nature and a Bottle Cap that rerolls IVs on the server", () => {
    expect(readStartItems(undefined)).toEqual([]);
    expect(readStartItems(["BOTTLE_CAP", "MINT"])).toEqual(["BOTTLE_CAP", "MINT"]);
    expect(() => readStartItems(["MINT", "MINT"])).toThrow("bad_action");
    expect(() => readStartItems(["MASTER_BALL"])).toThrow("bad_action");
    expect(() => readStartItems("MINT")).toThrow("bad_action");
    const p: Profile = { ...chooseStarter(newProfile(), "red"), points: 2 * META_RULES.startItemPrice };
    expect(payStartItems(p, [...START_ITEMS]).points).toBe(0);
    expect(() => payStartItems({ ...p, points: 1 }, ["MINT"])).toThrow("not_enough_points");

    for (let i = 0; i < 20; i++) {
      const run = createRun({ runId: `m${i}`, seed: `m${i}`, playerName: "t", champion: "red", startItems: [...START_ITEMS] });
      const items = Object.values(run.pieces).filter((x): x is ItemPiece => x.kind === "item" && x.place === null);
      const mint = items.find((x) => x.item === "MINT")!;
      expect(items.map((x) => x.item).sort()).toEqual(["BOTTLE_CAP", "MINT"]);
      expect(NATURES).toContain(mint.param);
      expect(natureEffect(mint.param as never).up).not.toBeNull();
    }

    const run = createRun({ runId: "use", seed: "use", playerName: "t", champion: "red", startItems: [...START_ITEMS] });
    const pikachu = Object.values(run.pieces).find((x): x is PokemonPiece => x.kind === "pokemon")!;
    const mint = Object.values(run.pieces).find((x): x is ItemPiece => x.kind === "item" && x.item === "MINT")!;
    const cap = Object.values(run.pieces).find((x): x is ItemPiece => x.kind === "item" && x.item === "BOTTLE_CAP")!;
    expect(() => applyAction(run, { t: "use", uid: mint.uid })).toThrow("not_found");
    expect(() => applyAction(run, { t: "use", uid: mint.uid, target: cap.uid })).toThrow("invalid_target");
    const same = { ...run, pieces: { ...run.pieces, [pikachu.uid]: { ...pikachu, nature: mint.param as never } } };
    expect(() => applyAction(same, { t: "use", uid: mint.uid, target: pikachu.uid })).toThrow("same_nature");
    const minted = applyAction(run, { t: "use", uid: mint.uid, target: pikachu.uid });
    expect((minted.pieces[pikachu.uid] as PokemonPiece).nature).toBe(mint.param);
    expect(minted.pieces[mint.uid]).toBeUndefined();
    expect(minted.notices[0]?.key).toBe("notice.mint");

    // The Mint is resolved by the client; the Bottle Cap draws on the hidden seed, so only the server can.
    expect(() => applyAction(publicState(run), { t: "use", uid: cap.uid, target: pikachu.uid })).toThrow("needs_server");
    const capped = applyAction(run, { t: "use", uid: cap.uid, target: pikachu.uid });
    expect((capped.pieces[pikachu.uid] as PokemonPiece).ivs).not.toEqual(pikachu.ivs);
    expect(capped.pieces[cap.uid]).toBeUndefined();
    expect(applyAction(run, { t: "use", uid: cap.uid, target: pikachu.uid })).toEqual(capped);
  });

  it("has bots use their start items on a finished Pokémon they suit", () => {
    const run = createRun({ runId: "bot", seed: "bot", playerName: "", champion: "red", startItems: [...START_ITEMS] });
    const starter = Object.values(run.pieces).find((x): x is PokemonPiece => x.kind === "pokemon")!;
    const mint = Object.values(run.pieces).find((x): x is ItemPiece => x.kind === "item" && x.item === "MINT")!;
    // A Raichu with a nature that lowers its Attack and poor IVs, and an Adamant Mint.
    const raichu: PokemonPiece = { ...starter, species: "RAICHU", nature: "MODEST", ivs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 } };
    const state: RunState = { ...run, gold: 0, pieces: { ...run.pieces, [starter.uid]: raichu, [mint.uid]: { ...mint, param: "ADAMANT" } } };
    const after = botShop(state, rngFor("bot-shop"));
    const mon = after.pieces[starter.uid] as PokemonPiece;
    expect(mon.nature).toBe("ADAMANT");
    expect(Object.values(mon.ivs).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    expect(Object.values(after.pieces).some((x) => x.kind === "item" && (x.item === "MINT" || x.item === "BOTTLE_CAP"))).toBe(false);
  });

  it("repairs stored profiles", () => {
    expect(normalizeProfile(null)).toEqual(newProfile());
    expect(
      normalizeProfile({
        points: -5,
        champions: ["red", "red", "bogus" as never],
        runs: { red: 2.7 },
        poolBought: { red: 99, lance: -1, geeta: 1.5 },
        starters: {
          red: { nature: "ADAMANT", ivBonus: { atk: 40, def: -2, spe: 3.5 }, draw: { kind: "nature", nature: "BOGUS" as never } },
          lance: { nature: "BOGUS" as never },
          leon: { ability: { ability: "BLAZE", hidden: false }, draw: { kind: "ability", ability: "SOLAR_POWER", hidden: true } },
        },
      }),
    ).toMatchObject({
      points: 0,
      champions: ["red"],
      runs: { red: 2 },
      poolBought: { red: last, geeta: 1 },
      starters: {
        red: { nature: "ADAMANT", ivBonus: { atk: MAX_IV, spe: 3 } },
        leon: { ability: { ability: "BLAZE", hidden: false }, draw: { kind: "ability", ability: "SOLAR_POWER", hidden: true } },
      },
      rating: META_RULES.startRating,
    });
  });
});
