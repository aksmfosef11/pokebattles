import { describe, expect, it } from "vitest";
import {
  BattleSim,
  newPokemon,
  rollTraits,
  rngFor,
  simulateBattle,
  type BattleEvent,
  type ChampionKey,
  type ItemPiece,
  type Piece,
  type PokemonPiece,
  type TeamSnapshot,
} from "../src/index.ts";

let uid = 0;
function mon(species: string, level: number, x: number, y: number, extra: Partial<PokemonPiece> = {}): PokemonPiece {
  const p = newPokemon(`m${uid++}`, species, level, rollTraits(species, rngFor("a", species, uid)), 0, 4);
  p.place = { x, y, rot: 0 };
  return { ...p, ...extra };
}
function item(key: string, x: number, y: number): ItemPiece {
  return { uid: `i${uid++}`, kind: "item", place: { x, y, rot: 0 }, paid: 0, item: key, age: 0 };
}
function team(pieces: Piece[], champion: ChampionKey = "red"): TeamSnapshot {
  return { name: champion, champion, subclass: null, round: 10, wins: 0, losses: 0, streak: 0, ace: null, pieces };
}
/** A slow, bulky target that only uses a weak contact move. */
const dummy = (x = 3, extra: Partial<PokemonPiece> = {}) => mon("BLISSEY", 60, x, 1, { moves: ["POUND"], ability: "NATURAL_CURE", ...extra });
const abilityEvents = (events: BattleEvent[], ability: string) => events.filter((e) => e.k === "ability" && e.ability === ability);

describe("abilities added with the 300-species roster", () => {
  it("Disguise blocks the first hit and busts Mimikyu's disguise", () => {
    const r = simulateBattle({
      seed: "disguise",
      teams: [team([mon("MIMIKYU", 50, 3, 1, { ability: "DISGUISE" })]), team([mon("MACHAMP", 60, 3, 1, { moves: ["FLAMETHROWER"] })])],
    });
    const form = r.events.find((e) => e.k === "form" && e.form === "disguise");
    expect(form).toMatchObject({ formKey: "busted" });
    expect(abilityEvents(r.events, "DISGUISE")).toHaveLength(1);
  });

  it("Multitype turns Arceus into the type of an adjacent plate", () => {
    const sim = new BattleSim({ seed: "arceus", teams: [team([mon("ARCEUS", 60, 3, 1), item("FLAME_PLATE", 3, 3)]), team([dummy()])] }, {});
    const arceus = sim.battlers[0]!;
    expect(arceus.types).toEqual(["fire"]);
    expect(arceus.formKey).toBe("fire");
  });

  it("Klutz ignores held items but keeps a stat bonus", () => {
    const lopunny = mon("LOPUNNY", 50, 3, 1);
    const orb = item("LIFE_ORB", 3, 2);
    const withKlutz = new BattleSim({ seed: "k", teams: [team([{ ...lopunny, ability: "KLUTZ" }, orb]), team([dummy()])] }, {});
    const without = new BattleSim({ seed: "k", teams: [team([{ ...lopunny, ability: "CUTE_CHARM" }, orb]), team([dummy()])] }, {});
    const a = withKlutz.battlers[0]!;
    const b = without.battlers[0]!;
    expect(a.items.counts.size).toBe(0);
    expect(b.items.counts.get("LIFE_ORB")).toBe(1);
    expect(a.stats.atk).toBeCloseTo(b.stats.atk * 1.15, 5);
  });

  it("Frisk knocks away a berry of the enemy in front at battle start", () => {
    const r = simulateBattle({
      seed: "frisk",
      teams: [team([mon("GRIMMSNARL", 50, 3, 1, { ability: "FRISK", moves: ["POUND"] })]), team([dummy(3), item("SITRUS_BERRY", 3, 2)])],
    });
    expect(abilityEvents(r.events, "FRISK")[0]).toMatchObject({ t: 0 });
    expect(r.events.find((e) => e.k === "item" && e.item === "SITRUS_BERRY")).toMatchObject({ t: 0, src: 1 });
    // The berry is gone, so it never heals.
    expect(r.events.some((e) => e.k === "heal" && e.cause === "berry")).toBe(false);
  });

  it("Damp stops self-destructing moves", () => {
    const r = simulateBattle({
      seed: "damp",
      teams: [team([mon("GOLEM", 50, 3, 1, { moves: ["EXPLOSION"], ability: "STURDY" })]), team([mon("SWAMPERT", 50, 3, 1, { ability: "DAMP", moves: ["POUND"] })])],
    });
    expect(abilityEvents(r.events, "DAMP").length).toBeGreaterThan(0);
    expect(r.events.some((e) => e.k === "damage" && e.cause === "selfFaint")).toBe(false);
  });

  it("Telepathy avoids an ally's spread move", () => {
    const r = simulateBattle({
      seed: "telepathy",
      teams: [
        team([mon("GARCHOMP", 60, 2, 1, { moves: ["EARTHQUAKE"] }), mon("GARDEVOIR", 50, 4, 1, { ability: "TELEPATHY", moves: ["POUND"] })]),
        team([dummy(3)]),
      ],
    });
    expect(abilityEvents(r.events, "TELEPATHY").length).toBeGreaterThan(0);
    expect(r.events.some((e) => e.k === "damage" && e.target === 1 && e.src === 0)).toBe(false);
  });

  it("Desolate Land keeps the sun up and evaporates Water moves", () => {
    const r = simulateBattle({
      seed: "primal",
      teams: [team([mon("GROUDON", 70, 3, 1, { ability: "DESOLATE_LAND", moves: ["POUND"] })]), team([mon("SWAMPERT", 50, 3, 1, { moves: ["SURF"] })])],
    });
    expect(r.events.find((e) => e.k === "weather")).toMatchObject({ t: 0, weather: "sun" });
    expect(r.events.some((e) => e.k === "damage" && e.src === 1)).toBe(false);
    expect(r.events.filter((e) => e.k === "weather" && e.weather === null && e.t < r.ticks)).toHaveLength(0);
  });

  it("Opportunist copies the enemy's stat boosts", () => {
    const r = simulateBattle({
      seed: "opportunist",
      teams: [team([mon("ESPATHRA", 50, 3, 1, { ability: "OPPORTUNIST", moves: ["POUND"] })]), team([mon("GARCHOMP", 50, 3, 1, { moves: ["SWORDS_DANCE"] })])],
    });
    const boost = r.events.find((e) => e.k === "stage" && e.target === 1 && e.stat === "atk");
    expect(boost).toBeDefined();
    expect(r.events.some((e) => e.k === "stage" && e.target === 0 && e.stat === "atk" && e.delta === 2 && e.t === boost!.t)).toBe(true);
  });

  it("Gooey slows contact attackers", () => {
    const r = simulateBattle({
      seed: "gooey",
      teams: [team([mon("GOODRA", 50, 3, 1, { ability: "GOOEY", moves: ["POUND"] })]), team([mon("MACHAMP", 50, 3, 1, { moves: ["TACKLE"] })])],
    });
    expect(r.events.some((e) => e.k === "stage" && e.target === 1 && e.stat === "spe" && e.delta < 0)).toBe(true);
  });

  it("Cursed Body seals the move that hit it for a while", () => {
    const sealed = [0, 1, 2, 3, 4, 5].some((k) => {
      const r = simulateBattle({
        seed: `cursed${k}`,
        teams: [team([mon("GENGAR", 50, 3, 1, { ability: "CURSED_BODY", moves: ["POUND"] })]), team([mon("SNORLAX", 60, 3, 1, { moves: ["CRUNCH", "BODY_SLAM"] })])],
      });
      const trigger = abilityEvents(r.events, "CURSED_BODY")[0];
      if (!trigger) return false;
      const hit = [...r.events].reverse().find((e) => e.k === "move" && e.src === 1 && e.t <= trigger.t);
      const next = r.events.find((e) => e.k === "move" && e.src === 1 && e.t > trigger.t && e.t < trigger.t + 40);
      return !!hit && hit.k === "move" && (!next || (next.k === "move" && next.move !== hit.move));
    });
    expect(sealed).toBe(true);
  });

  it("Pickpocket takes a berry from a contact attacker once", () => {
    const r = simulateBattle({
      seed: "pickpocket",
      teams: [team([mon("WEAVILE", 50, 3, 1, { ability: "PICKPOCKET", moves: ["POUND"] })]), team([mon("MACHAMP", 50, 3, 1, { moves: ["TACKLE"] }), item("LUM_BERRY", 3, 2)])],
    });
    expect(abilityEvents(r.events, "PICKPOCKET")).toHaveLength(1);
    expect(r.events.find((e) => e.k === "item" && e.item === "LUM_BERRY")).toMatchObject({ src: 1 });
  });

  it("Magician takes a berry from the Pokémon it hits once", () => {
    const r = simulateBattle({
      seed: "magician",
      teams: [team([mon("DELPHOX", 50, 3, 1, { ability: "MAGICIAN", moves: ["FLAMETHROWER"] })]), team([dummy(3), item("LUM_BERRY", 3, 2)])],
    });
    expect(abilityEvents(r.events, "MAGICIAN")).toHaveLength(1);
    expect(r.events.find((e) => e.k === "item" && e.item === "LUM_BERRY")).toMatchObject({ src: 1 });
  });

  it("Suction Cups never loses gauge to flinching", () => {
    const r = simulateBattle({
      seed: "cups",
      teams: [team([mon("CRADILY", 50, 3, 1, { ability: "SUCTION_CUPS", moves: ["POUND"] })]), team([mon("TOGEKISS", 60, 3, 1, { ability: "SERENE_GRACE", moves: ["AIR_SLASH"] })])],
    });
    expect(abilityEvents(r.events, "SUCTION_CUPS").length).toBeGreaterThan(0);
    expect(r.events.some((e) => e.k === "flinch" && e.target === 0)).toBe(false);
  });

  it("Corrosion poisons Steel types", () => {
    const r = simulateBattle({
      seed: "corrosion",
      teams: [team([mon("SALAZZLE", 50, 3, 1, { ability: "CORROSION", moves: ["TOXIC"] })]), team([mon("AGGRON", 50, 3, 1, { ability: "STURDY", moves: ["POUND"] })])],
    });
    expect(r.events.some((e) => e.k === "status" && e.target === 1 && (e.status === "tox" || e.status === "psn"))).toBe(true);
  });

  it("Klutz still mega evolves with its stone", () => {
    const sim = new BattleSim(
      { seed: "klutz-mega", teams: [team([mon("LOPUNNY", 50, 3, 1, { ability: "KLUTZ" }), item("LOPUNNITE", 3, 2), item("MEGA_BRACELET", 5, 1)], "diantha"), team([dummy()])] },
      {},
    );
    expect(sim.battlers[0]!.items.megaForm).toBe("mega");
    expect(sim.battlers[0]!.items.counts.has("LOPUNNITE")).toBe(true);
  });

  it("Plus and Minus boost each other's special attacks when adjacent", () => {
    const amph = mon("AMPHAROS", 50, 1, 1, { ability: "PLUS" });
    const manectric = mon("MANECTRIC", 50, 3, 1, { ability: "MINUS" });
    const foe = dummy(3);
    const pair = (x2: number) =>
      new BattleSim({ seed: "plus", teams: [team([amph, { ...manectric, place: { x: x2, y: 1, rot: 0 } }]), team([foe])] }, {});
    const hit = (sim: BattleSim) => {
      const [amph, , foe] = sim.battlers;
      const move = sim.resolveMove(amph!, "THUNDERBOLT");
      return sim.computeDamage(amph!, foe!, move, "electric", false, { spread: false, crit: false, eff: 1, roll: 100, estimate: true });
    };
    expect(hit(pair(3)) / hit(pair(6))).toBeGreaterThan(1.4);
  });
});

describe("abilities added with the 420-species roster", () => {
  /** Damage of one move with a fixed roll, from the first battler to the last. */
  const hitWith = (attacker: PokemonPiece, target: PokemonPiece, move: string, type: Parameters<BattleSim["computeDamage"]>[3]) => {
    const sim = new BattleSim({ seed: "hit", teams: [team([attacker]), team([target])] }, {});
    const [att, def] = sim.battlers;
    return sim.computeDamage(att!, def!, sim.resolveMove(att!, move), type, false, { spread: false, crit: false, eff: 1, roll: 100, estimate: true });
  };

  it("Booster Energy powers Protosynthesis without sun, once", () => {
    const tusk = mon("GREAT_TUSK", 60, 3, 1, { ability: "PROTOSYNTHESIS", moves: ["POUND"] });
    const boosted = simulateBattle({ seed: "tusk", teams: [team([tusk, item("BOOSTER_ENERGY", 3, 3)]), team([dummy()])] });
    expect(abilityEvents(boosted.events, "PROTOSYNTHESIS")[0]).toMatchObject({ t: 0, src: 0 });
    expect(boosted.events.filter((e) => e.k === "item" && e.item === "BOOSTER_ENERGY")).toHaveLength(1);
    const plain = simulateBattle({ seed: "tusk", teams: [team([tusk]), team([dummy()])] });
    expect(abilityEvents(plain.events, "PROTOSYNTHESIS")).toHaveLength(0);
  });

  it("Quark Drive raises the highest stat in Electric Terrain and keeps Booster Energy for later", () => {
    // Neutral nature and even IVs: Speed (base 136) is its highest stat.
    const ivs = { hp: 20, atk: 20, def: 20, spa: 20, spd: 20, spe: 20 };
    const bundle = mon("IRON_BUNDLE", 60, 3, 1, { ability: "QUARK_DRIVE", moves: ["POUND"], nature: "HARDY", ivs });
    const plain = new BattleSim({ seed: "q", teams: [team([bundle]), team([dummy()])] }, {});
    const baseSpeed = plain.effSpeed(plain.battlers[0]!);
    const koko = mon("TAPU_KOKO", 60, 5, 1, { ability: "ELECTRIC_SURGE", moves: ["POUND"] });
    const sim = new BattleSim({ seed: "q", teams: [team([bundle, koko, item("BOOSTER_ENERGY", 3, 2)]), team([dummy()])] }, {});
    sim.setTerrain("electric");
    expect(sim.effSpeed(sim.battlers[0]!)).toBeCloseTo(baseSpeed * 1.5, 5);
    const r = sim.run();
    expect(abilityEvents(r.events, "QUARK_DRIVE")[0]).toMatchObject({ t: 0 });
    expect(r.events.some((e) => e.k === "item" && e.item === "BOOSTER_ENERGY" && e.t === 0)).toBe(false);
  });

  it("Mirror Armor bounces Intimidate back", () => {
    const r = simulateBattle({
      seed: "mirror",
      teams: [team([mon("CORVIKNIGHT", 50, 3, 1, { ability: "MIRROR_ARMOR", moves: ["POUND"] })]), team([mon("GYARADOS", 50, 3, 1, { ability: "INTIMIDATE", moves: ["POUND"] })])],
    });
    expect(abilityEvents(r.events, "MIRROR_ARMOR").length).toBeGreaterThan(0);
    expect(r.events.find((e) => e.k === "stage" && e.stat === "atk")).toMatchObject({ target: 1, delta: -1 });
    expect(r.events.some((e) => e.k === "stage" && e.target === 0 && e.stat === "atk" && e.delta < 0)).toBe(false);
  });

  it("Merciless always lands critical hits on poisoned targets", () => {
    const r = simulateBattle({
      seed: "merciless",
      teams: [
        team([mon("TOXAPEX", 50, 3, 1, { ability: "MERCILESS", moves: ["POUND"] })]),
        team([dummy(3, { ability: "SERENE_GRACE", moves: ["GROWL"] }), item("TOXIC_ORB", 3, 2)]),
      ],
    });
    const hits = r.events.filter((e) => e.k === "damage" && e.cause === "move" && e.src === 0);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((e) => e.k === "damage" && e.crit)).toBe(true);
  });

  it("Fluffy halves contact damage and doubles Fire damage", () => {
    const attacker = mon("MACHAMP", 60, 3, 1, { ability: "NO_GUARD" });
    const bewear = (ability: string) => mon("BEWEAR", 60, 3, 1, { ability });
    expect(hitWith(attacker, bewear("FLUFFY"), "POUND", "normal") / hitWith(attacker, bewear("KLUTZ"), "POUND", "normal")).toBeCloseTo(0.5, 1);
    expect(hitWith(attacker, bewear("FLUFFY"), "FLAMETHROWER", "fire") / hitWith(attacker, bewear("KLUTZ"), "FLAMETHROWER", "fire")).toBeCloseTo(2, 1);
  });

  it("Mega Sol fights as if in harsh sunlight", () => {
    const meganium = (ability: string) => mon("MEGANIUM", 60, 3, 1, { ability });
    const frail = mon("MAGIKARP", 10, 3, 1);
    const ratio = hitWith(meganium("MEGA_SOL"), frail, "FLAMETHROWER", "fire") / hitWith(meganium("OVERGROW"), frail, "FLAMETHROWER", "fire");
    expect(ratio).toBeGreaterThan(1.45);
    expect(ratio).toBeLessThan(1.6);
  });

  it("Piercing Drill hits through Protect with contact moves", () => {
    const hitsThroughProtect = (ability: string) => {
      const sim = new BattleSim(
        { seed: "drill", teams: [team([mon("EXCADRILL", 60, 3, 1, { ability, moves: ["POUND"] })]), team([dummy(3, { ability: "SERENE_GRACE", moves: ["GROWL"] })])] },
        {},
      );
      sim.battlers[1]!.protectUntil = Number.MAX_SAFE_INTEGER;
      return sim.run().events.filter((e) => e.k === "damage" && e.cause === "move" && e.src === 0);
    };
    expect(hitsThroughProtect("PIERCING_DRILL").length).toBeGreaterThan(0);
    expect(hitsThroughProtect("SAND_RUSH")).toHaveLength(0);
  });

  it("Speed Boost raises Speed every other pulse (4 s), not every pulse", () => {
    const r = simulateBattle({ seed: "boost", teams: [team([mon("NINJASK", 50, 3, 1, { ability: "SPEED_BOOST", moves: ["POUND"] })]), team([dummy()])] });
    const boosts = abilityEvents(r.events, "SPEED_BOOST").map((e) => e.t);
    expect(boosts.length).toBeGreaterThan(1);
    for (let i = 1; i < boosts.length; i++) expect(boosts[i]! - boosts[i - 1]!).toBeGreaterThanOrEqual(40);
  });

  it("Spicy Spray burns whoever hits it", () => {
    const r = simulateBattle({
      seed: "spicy",
      teams: [team([mon("SCOVILLAIN", 50, 3, 1, { ability: "SPICY_SPRAY", moves: ["GROWL"] })]), team([mon("MACHAMP", 50, 3, 1, { ability: "NO_GUARD", moves: ["POUND"] })])],
    });
    expect(abilityEvents(r.events, "SPICY_SPRAY").length).toBeGreaterThan(0);
    expect(r.events.some((e) => e.k === "status" && e.target === 1 && e.status === "brn")).toBe(true);
  });
});
