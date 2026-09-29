import { describe, expect, it } from "vitest";
import {
  applyAction,
  applyRoundResult,
  CHAMPION_KEYS,
  CHAMPION_RULES,
  championSpeciesByTier,
  createRun,
  cynthiaBonusScale,
  LEGEND_AURA,
  LEGEND_KO_BOOSTS,
  LEGEND_LEVEL_PER_ROUND,
  legendUnlockRound,
  lockedLinesAt,
  newPokemon,
  offerLevel,
  rngFor,
  rollShop,
  rollTraits,
  simulateBattle,
  STARTER_LEGENDS,
  TIER_LEVEL,
  TIER_UNLOCK,
  tierOdds,
  type ChampionKey,
  type Piece,
  type PokemonPiece,
  type RunState,
  type TeamSnapshot,
} from "../src/index.ts";

let uid = 0;
function mon(species: string, level: number, x: number, y: number): PokemonPiece {
  const p = newPokemon(`m${uid++}`, species, level, rollTraits(species, rngFor("t", species, uid)), 0, 4);
  p.place = { x, y, rot: 0 };
  return p;
}
function team(champion: ChampionKey, pieces: Piece[]): TeamSnapshot {
  return { name: champion, champion, subclass: null, round: 12, wins: 0, losses: 0, streak: 0, ace: null, pieces };
}
const legendOffers = (shop: RunState["shop"]) => shop.filter((s) => s.offer?.kind === "pokemon" && s.offer.tier === 5);

describe("legendaries", () => {
  it("open at round 10 (Cynthia earlier), with no weight before that", () => {
    expect(legendUnlockRound("red")).toBe(TIER_UNLOCK[5]);
    expect(legendUnlockRound("cynthia")).toBe(CHAMPION_RULES.cynthia.legendaryUnlockRound);
    expect(legendUnlockRound("cynthia")).toBeLessThan(TIER_UNLOCK[5]);
    for (const champion of ["red", "cynthia"] as const) {
      const at = legendUnlockRound(champion);
      expect(tierOdds({ champion, round: at - 1 })[4]).toBe(0);
      expect(tierOdds({ champion, round: at })[4]).toBeGreaterThan(0);
    }
  });

  it("always show one in the opening shop of round 10, from the run's own pool", () => {
    for (const champion of ["red", "lance", "cynthia", "geeta"] as const) {
      const base = createRun({ runId: `l-${champion}`, seed: `l-${champion}`, playerName: "t", champion });
      for (let i = 0; i < 20; i++) {
        const state: RunState = { ...base, seed: `${champion}-${i}`, round: TIER_UNLOCK[5] };
        const legends = legendOffers(rollShop(state, 0));
        expect(legends.length, `${champion} ${i}`).toBeGreaterThanOrEqual(1);
        for (const s of legends) expect(championSpeciesByTier(champion)[5]).toContain(s.offer!.kind === "pokemon" && s.offer!.species);
      }
    }
    // A new player (stage 0 pool) gets the champion's starter legendary.
    for (const champion of CHAMPION_KEYS) {
      const fresh = createRun({ runId: `l-new-${champion}`, seed: `l-new-${champion}`, playerName: "t", champion, lockedLines: lockedLinesAt(champion, 0) });
      const legends = legendOffers(rollShop({ ...fresh, round: TIER_UNLOCK[5] }, 0));
      expect(legends.length, champion).toBeGreaterThanOrEqual(1);
      for (const s of legends) expect(s.offer!.kind === "pokemon" && s.offer!.species, champion).toBe(STARTER_LEGENDS[champion]);
    }
  });

  it("keeps a locked slot and announces the guaranteed one", () => {
    let state = createRun({ runId: "l-lock", seed: "l-lock", playerName: "t", champion: "red" });
    state = applyAction(state, { t: "lock", slot: 0 });
    const locked = state.shop[0]!;
    state = { ...state, round: 9 };
    state = applyRoundResult(state, { outcome: "win", fainted: [], battleGold: 0, opponent: { name: "", champion: "red", ghost: false } });
    expect(state.round).toBe(10);
    expect(state.shop[0]).toEqual(locked);
    expect(legendOffers(state.shop)).toHaveLength(1);
    expect(state.notices.some((n) => n.key === "notice.legendAppeared")).toBe(true);
  });

  it("join at a level that grows with the round", () => {
    expect(offerLevel(5, TIER_UNLOCK[5])).toBe(TIER_LEVEL[5]);
    expect(offerLevel(5, TIER_UNLOCK[5] + 2)).toBe(TIER_LEVEL[5] + 2 * LEGEND_LEVEL_PER_ROUND);
    expect(offerLevel(4, TIER_UNLOCK[4] + 2)).toBe(TIER_LEVEL[4] + 2);
  });

  it("raise their better attacking stat on a knockout, a few times per battle", () => {
    const foes = team("red", [0, 1, 2, 3, 4, 5].map((x) => mon("MAGIKARP", 5, x, 0)));
    const r = simulateBattle({ seed: "aura", teams: [team("red", [mon("MEWTWO", 90, 2, 2)]), foes] });
    const mewtwo = r.initial.find((b) => b.side === 0)!;
    const auras = r.events.filter((e) => e.k === "ability" && e.ability === LEGEND_AURA);
    expect(auras).toHaveLength(LEGEND_KO_BOOSTS);
    expect(auras.every((e) => e.k === "ability" && e.src === mewtwo.id)).toBe(true);
    // Mewtwo's Sp. Atk is higher than its Attack.
    expect(r.events.some((e) => e.k === "stage" && e.target === mewtwo.id && e.stat === "spa" && e.delta > 0)).toBe(true);
    // Not for other Pokémon.
    const other = simulateBattle({ seed: "aura", teams: [team("red", [mon("DRAGONITE", 90, 2, 2)]), foes] });
    expect(other.events.some((e) => e.k === "ability" && e.ability === LEGEND_AURA)).toBe(false);
  });

  it("fades Cynthia's stat bonuses from round 10, once legendaries come for everyone", () => {
    const r = CHAMPION_RULES.cynthia;
    for (let round = 1; round <= r.bonusFadeAfter; round++) expect(cynthiaBonusScale(round), `round ${round}`).toBe(1);
    expect(cynthiaBonusScale(10)).toBeLessThan(1);
    expect(cynthiaBonusScale(11)).toBeLessThan(cynthiaBonusScale(10));
    expect(cynthiaBonusScale(14)).toBe(r.bonusFadeFloor);
    // In battle: HP against Leon (no bonus at streak 0) shows the bonus of six different types shrinking.
    const types = ["PIKACHU", "GEODUDE", "BULBASAUR", "SQUIRTLE", "CHARMANDER", "GASTLY"];
    const hp = (champion: ChampionKey, round: number) => {
      const t = { ...team(champion, types.map((s, i) => mon(s, 50, i, 0))), round };
      return simulateBattle({ seed: "fade", teams: [t, team("red", [mon("SNORLAX", 50, 2, 1)])] }).initial.filter((b) => b.side === 0).reduce((a, b) => a + b.maxHp, 0);
    };
    const at = (round: number) => hp("cynthia", round) / hp("leon", round);
    expect(at(9)).toBeGreaterThan(1.02);
    expect(at(14)).toBeGreaterThan(1);
    expect(at(14)).toBeLessThan(at(9));
  });
});
