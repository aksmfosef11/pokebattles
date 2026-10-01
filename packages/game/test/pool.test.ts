import { describe, expect, it } from "vitest";
import {
  applyAction,
  CHAMPION_KEYS,
  CHAMPIONS,
  championPool,
  championReach,
  championSpeciesByTier,
  CONTENT,
  createRun,
  getSpecies,
  itemEvolutions,
  ITEMS,
  lineBase,
  rollShop,
  type ItemPiece,
  type PokemonPiece,
  type RunState,
} from "../src/index.ts";

describe("champion shop pools", () => {
  it("contain the champion's generation and their whole real squad", () => {
    for (const c of CHAMPION_KEYS) {
      const def = CHAMPIONS[c];
      const pool = championPool(c);
      for (const key of def.squad) {
        expect(CONTENT.species[key], `${c} ${key}`).toBeDefined();
        for (let cur: string | null = key; cur; cur = getSpecies(cur).prevo) expect(pool.has(cur), `${c} ${cur}`).toBe(true);
      }
      for (const key of pool) {
        const s = getSpecies(key);
        const inSquadLine = def.squad.some((sq) => {
          for (let cur: string | null = sq; cur; cur = getSpecies(cur).prevo) if (cur === key) return true;
          return false;
        });
        expect(s.generation === def.generation || inSquadLine, `${c} ${key}`).toBe(true);
      }
      const byTier = championSpeciesByTier(c);
      for (const tier of [1, 2, 3, 5] as const) expect(byTier[tier].length, `${c} tier ${tier}`).toBeGreaterThan(0);
    }
  });

  it("only offers pool Pokémon in the shop", () => {
    for (const c of CHAMPION_KEYS) {
      const pool = championPool(c);
      const base = createRun({ runId: `pool-${c}`, seed: `pool-${c}`, playerName: "t", champion: c });
      for (const round of [1, 5, 9, 13, 17]) {
        const state: RunState = { ...base, round };
        for (let i = 0; i < 12; i++) {
          for (const slot of rollShop(state, i)) {
            if (slot.offer?.kind === "pokemon") expect(pool.has(slot.offer.species), `${c} r${round} ${slot.offer.species}`).toBe(true);
          }
        }
      }
    }
  });

  it("opens Poké Balls into the champion's pool", () => {
    const run = createRun({ runId: "ball", seed: "ball", playerName: "t", champion: "alder" });
    const pool = championPool("alder");
    for (let i = 0; i < 20; i++) {
      const ball: ItemPiece = { uid: `ball${i}`, kind: "item", place: null, paid: 0, item: "POKE_BALL", age: 0 };
      const state: RunState = { ...run, seed: `ball-${i}`, pieces: { ...run.pieces, [ball.uid]: ball } };
      const after = applyAction(state, { t: "use", uid: ball.uid });
      const fresh = Object.values(after.pieces).find((p) => p.kind === "pokemon" && !run.pieces[p.uid]);
      expect(fresh && fresh.kind === "pokemon" && pool.has(fresh.species)).toBe(true);
    }
  });

  it("offers lines you already own less often", () => {
    const base = createRun({ runId: "damp", seed: "damp", playerName: "t", champion: "cynthia" });
    const gibleOffers = (state: RunState) => {
      let n = 0;
      for (let i = 0; i < 400; i++) for (const slot of rollShop({ ...state, round: 5 }, i)) if (slot.offer?.kind === "pokemon" && lineBase(slot.offer.species) === "GIBLE") n++;
      return n;
    };
    const withGarchomps: RunState = { ...base, pieces: { ...base.pieces } };
    for (let i = 0; i < 2; i++) {
      const uid = `g${i}`;
      withGarchomps.pieces[uid] = { ...Object.values(base.pieces).find((p) => p.kind === "pokemon")!, uid, species: "GARCHOMP" } as never;
    }
    expect(gibleOffers(withGarchomps)).toBeLessThan(gibleOffers(base) * 0.6);
  });

  it("offers Booster Energy only to runs that own a paradox Pokémon", () => {
    const boosterOffers = (champion: "red" | "geeta", species: string[]) => {
      const base = createRun({ runId: `be-${champion}`, seed: `be-${champion}`, playerName: "t", champion });
      const starter = Object.values(base.pieces).find((p) => p.kind === "pokemon")!;
      const pieces = Object.fromEntries(species.map((s, i) => [`p${i}`, { ...starter, uid: `p${i}`, species: s, ability: getSpecies(s).abilities[0]! }]));
      const state: RunState = { ...base, round: 9, pieces: pieces as RunState["pieces"] };
      let n = 0;
      for (let i = 0; i < 600; i++) for (const slot of rollShop(state, i)) if (slot.offer?.kind === "item" && slot.offer.item === "BOOSTER_ENERGY") n++;
      return n;
    };
    expect(boosterOffers("red", ["PIKACHU"])).toBe(0);
    expect(boosterOffers("geeta", ["GREAT_TUSK"])).toBeGreaterThan(5);
  });

  it("offers weather rocks only to runs with a Pokémon that brings the weather (Steven keeps them as stones)", () => {
    const rockOffers = (champion: "red" | "steven", extra: Partial<PokemonPiece>) => {
      const base = createRun({ runId: "rock", seed: "rock", playerName: "t", champion });
      const starter = Object.values(base.pieces).find((p) => p.kind === "pokemon")!;
      const state: RunState = { ...base, round: 6, pieces: { p0: { ...starter, uid: "p0", species: "TORKOAL", ...extra } } as RunState["pieces"] };
      let n = 0;
      for (let i = 0; i < 300; i++) for (const slot of rollShop(state, i)) if (slot.offer?.kind === "item" && slot.offer.item === "HEAT_ROCK") n++;
      return n;
    };
    const drought = rockOffers("red", { ability: "DROUGHT" });
    expect(drought).toBeGreaterThan(20);
    expect(rockOffers("red", { ability: "WHITE_SMOKE", moves: ["EMBER"] })).toBeLessThan(drought / 10);
    expect(rockOffers("red", { ability: "WHITE_SMOKE", moves: ["EMBER", "SUNNY_DAY"] })).toBeGreaterThan(20);
    expect(rockOffers("steven", { ability: "WHITE_SMOKE", moves: ["EMBER"] })).toBeGreaterThan(0);
  });

  it("offers Flame and Toxic Orbs by the ability an owned Pokémon really has", () => {
    const orbOffers = (ability: string) => {
      const base = createRun({ runId: "orb", seed: "orb", playerName: "t", champion: "red" });
      const starter = Object.values(base.pieces).find((p) => p.kind === "pokemon")!;
      // Flareon has Guts only as its hidden ability.
      const state: RunState = { ...base, round: 6, pieces: { p0: { ...starter, uid: "p0", species: "FLAREON", ability } } as RunState["pieces"] };
      let n = 0;
      for (let i = 0; i < 300; i++) {
        for (const slot of rollShop(state, i)) if (slot.offer?.kind === "item" && (slot.offer.item === "FLAME_ORB" || slot.offer.item === "TOXIC_ORB")) n++;
      }
      return n;
    };
    const withGuts = orbOffers("GUTS");
    expect(withGuts).toBeGreaterThan(20);
    expect(orbOffers("FLASH_FIRE")).toBeLessThan(withGuts / 10);
  });

  it("offers owned lines less often even in a tier with a single species", () => {
    expect(championSpeciesByTier("cynthia")[4]).toEqual(["GARCHOMP"]);
    const base = createRun({ runId: "solo", seed: "solo", playerName: "t", champion: "cynthia" });
    const starter = Object.values(base.pieces).find((p) => p.kind === "pokemon")!;
    const withSpecies = (species: string[]): RunState => ({
      ...base,
      round: 13,
      pieces: Object.fromEntries(species.map((s, i) => [`p${i}`, { ...starter, uid: `p${i}`, species: s }])) as RunState["pieces"],
    });
    const garchompOffers = (state: RunState) => {
      let n = 0;
      for (let i = 0; i < 600; i++) for (const slot of rollShop(state, i)) if (slot.offer?.kind === "pokemon" && slot.offer.species === "GARCHOMP") n++;
      return n;
    };
    const none = garchompOffers(withSpecies(["SHINX"]));
    expect(none).toBeGreaterThan(50);
    expect(garchompOffers(withSpecies(["SHINX", "GARCHOMP", "GARCHOMP"]))).toBeLessThan(none * 0.4);
  });

  it("reaches evolutions outside the champion's generation", () => {
    const red = championReach("red");
    for (const key of championPool("red")) expect(red.has(key), key).toBe(true);
    // Magnemite is gen 1, Magnezone gen 4; Eevee's gen 4 evolutions come from a gen 1 Eevee.
    expect(red.has("MAGNEZONE")).toBe(true);
    expect(red.has("LEAFEON")).toBe(true);
    expect(championReach("leon").has("SCOVILLAIN")).toBe(false);
  });

  it("lists which Pokémon each evolution item evolves", () => {
    expect(itemEvolutions("THUNDER_STONE")).toContainEqual({ from: "PIKACHU", to: "RAICHU" });
    expect(itemEvolutions("LINKING_CORD")).toContainEqual({ from: "KADABRA", to: "ALAKAZAM" });
    expect(itemEvolutions("LEFTOVERS")).toEqual([]);
    for (const { from, to } of itemEvolutions("FIRE_STONE")) {
      expect(getSpecies(from).evolutions.some((e) => e.to === to && e.item === "FIRE_STONE")).toBe(true);
    }
  });

  it("never offers evolution items that evolve nothing this champion can get (Steven keeps stones)", () => {
    const offered = (c: (typeof CHAMPION_KEYS)[number]) => {
      const base = createRun({ runId: `evo-${c}`, seed: `evo-${c}`, playerName: "t", champion: c });
      const seen = new Set<string>();
      for (const round of [1, 4, 8]) {
        for (let i = 0; i < 150; i++) {
          for (const slot of rollShop({ ...base, round }, i)) {
            if (slot.offer?.kind === "item" && ITEMS[slot.offer.item]?.family === "evolution") seen.add(slot.offer.item);
          }
        }
      }
      return seen;
    };
    for (const c of CHAMPION_KEYS) {
      if (c === "steven") continue;
      const reach = championReach(c);
      for (const item of offered(c)) expect(itemEvolutions(item).some((e) => reach.has(e.from)), `${c} ${item}`).toBe(true);
    }
    expect(offered("leon")).toEqual(new Set(["DUSK_STONE"]));
    expect(offered("steven").has("MOON_STONE")).toBe(true);
    expect(offered("steven").has("LINKING_CORD")).toBe(false);
  });
});
