import { describe, expect, it } from "vitest";
import {
  applyAction,
  applyRoundResult,
  CHAMPION_RULES,
  createRun,
  EARLY_ROUNDS,
  earlyBonus,
  newPokemon,
  prepareForBattle,
  rollTraits,
  rngFor,
  simulateBattle,
  type ChampionKey,
  type ItemPiece,
  type Piece,
  type PokemonPiece,
  type RunState,
  type SubclassKey,
  type TeamSnapshot,
} from "../src/index.ts";

let uid = 0;
function mon(species: string, level: number, x: number, y: number, extra: Partial<PokemonPiece> = {}): PokemonPiece {
  const p = newPokemon(`m${uid++}`, species, level, rollTraits(species, rngFor("t", species, uid)), 0, 4);
  p.place = { x, y, rot: 0 };
  return { ...p, ...extra };
}
function item(key: string, x: number, y: number, param?: string): ItemPiece {
  return { uid: `i${uid++}`, kind: "item", place: { x, y, rot: 0 }, paid: 0, item: key, age: 0, ...(param ? { param } : {}) };
}
function team(champion: ChampionKey, pieces: Piece[], subclass: SubclassKey | null = null, round = 10): TeamSnapshot {
  return { name: champion, champion, subclass, round, wins: 0, losses: 0, streak: 0, ace: null, pieces };
}
// Bulky targets with a pinned weak move, so tests don't depend on automatic moveset choices.
const wall = () => team("red", [mon("SNORLAX", 70, 2, 1, { moves: ["TACKLE"] }), mon("BLISSEY", 70, 4, 1, { moves: ["POUND"] })]);

describe("champion gimmicks in battle", () => {
  it("keeps every early-game adjustment to rounds 1–5, so rounds 8 and 14 stay as tuned", () => {
    const r = CHAMPION_RULES;
    for (const [bonus, perRound] of [
      [r.lance.youngKinStatBonus, r.lance.youngKinPerRound],
      [r.steven.earlyStatBonus, r.steven.earlyStatPerRound],
      [r.alder.youngBugStatBonus, r.alder.youngBugPerRound],
    ]) {
      expect(earlyBonus(bonus!, perRound!, 1)).toBeGreaterThan(0);
      for (let round = EARLY_ROUNDS + 1; round <= 18; round++) expect(earlyBonus(bonus!, perRound!, round)).toBe(0);
    }
    const dratini = mon("DRATINI", 12, 3, 1);
    const hp = (champion: ChampionKey, round: number) =>
      simulateBattle({ seed: "early", teams: [team(champion, [dratini], null, round), wall()] }).initial.find((b) => b.side === 0)!.maxHp;
    // Red has no stat adjustment on a Pokémon that is not his ace: the reference.
    expect(hp("lance", 2)).toBeGreaterThan(hp("red", 2));
    expect(hp("lance", 6)).toBe(hp("red", 6));
    expect(hp("steven", 2)).toBeGreaterThan(hp("red", 2));
    expect(hp("steven", 5)).toBe(hp("red", 5));
  });

  it("Leon dynamaxes the Pokémon next to the Dynamax Band (Gigantamax form for Charizard)", () => {
    const r = simulateBattle({ seed: "leon", teams: [team("leon", [mon("CHARIZARD", 50, 3, 1), item("DYNAMAX_BAND", 3, 2)]), wall()] });
    const form = r.events.find((e) => e.k === "form" && (e.form === "gmax" || e.form === "dynamax"));
    expect(form).toMatchObject({ form: "gmax", formKey: "gigantamax" });
    expect(r.events.some((e) => e.k === "move" && e.variant === "gmax")).toBe(true);
  });

  it("Diantha mega evolves at battle start next to the Key Stone", () => {
    const r = simulateBattle({
      seed: "diantha",
      teams: [team("diantha", [mon("GARDEVOIR", 50, 3, 1), item("GARDEVOIRITE", 2, 1), item("MEGA_BRACELET", 5, 1)]), wall()],
    });
    expect(r.events.find((e) => e.k === "form" && e.form === "mega")).toMatchObject({ t: 0, formKey: "mega" });
  });

  it("Diantha mega evolves at half HP without the Key Stone", () => {
    const r = simulateBattle({ seed: "diantha2", teams: [team("diantha", [mon("CHARIZARD", 40, 3, 1), item("CHARIZARDITE_Y", 3, 2)]), wall()] });
    const mega = r.events.find((e) => e.k === "form" && e.form === "mega");
    expect(mega).toBeDefined();
    expect(mega!.t).toBeGreaterThan(0);
  });

  it("Kukui turns the first attack of the crystal's type into a Z-move", () => {
    const r = simulateBattle({ seed: "kukui", teams: [team("kukui", [mon("RAICHU", 50, 3, 1), item("ELECTRIUM_Z", 3, 2)]), wall()] });
    const z = r.events.filter((e) => e.k === "move" && e.variant === "z");
    expect(z.length).toBe(1);
    expect(z[0]).toMatchObject({ move: "GIGAVOLT_HAVOC" });
  });

  it("Geeta terastallizes next to a Tera Shard", () => {
    const r = simulateBattle({ seed: "geeta", teams: [team("geeta", [mon("GLIMMORA", 50, 3, 1), item("TERA_SHARD", 3, 2, "rock")]), wall()] });
    expect(r.events.find((e) => e.k === "form" && e.form === "tera")).toMatchObject({ tera: "rock", types: ["rock"] });
  });

  it("Steven's Mega Metagross subclass mega evolves at start", () => {
    const r = simulateBattle({
      seed: "steven",
      teams: [team("steven", [mon("METAGROSS", 50, 3, 1), item("METAGROSSITE", 6, 1)], "steven_mega"), wall()],
    });
    expect(r.events.find((e) => e.k === "form" && e.form === "mega")).toMatchObject({ t: 0 });
  });

  it("Aegislash switches stance when attacking", () => {
    const r = simulateBattle({ seed: "aegis", teams: [team("leon", [mon("AEGISLASH", 50, 3, 1, { ability: "STANCE_CHANGE" })]), wall()] });
    expect(r.events.some((e) => e.k === "form" && e.form === "stance" && e.formKey === "blade")).toBe(true);
  });
});

describe("board rules", () => {
  function withPieces(champion: ChampionKey, pieces: Piece[]): RunState {
    const s = createRun({ runId: "r", seed: "s", playerName: "p", champion });
    const bag: Piece = { uid: "bag", kind: "bag", place: { x: 1, y: 1, rot: 0 }, paid: 0, bag: "BAG_START_LEGACY" };
    s.pieces = Object.fromEntries([bag, ...pieces].map((p) => [p.uid, p]));
    return s;
  }

  it("an adjacent Fire Stone evolves Eevee before the battle and is consumed", () => {
    const eevee = mon("EEVEE", 20, 2, 1);
    const stone = item("FIRE_STONE", 3, 1);
    const s = prepareForBattle(withPieces("red", [eevee, stone]));
    expect((s.pieces[eevee.uid] as PokemonPiece).species).toBe("FLAREON");
    expect(s.pieces[stone.uid]).toBeUndefined();
  });

  it("a stone that touches nothing stays", () => {
    const eevee = mon("EEVEE", 20, 1, 1);
    const stone = item("FIRE_STONE", 5, 3);
    const s = prepareForBattle(withPieces("red", [eevee, stone]));
    expect((s.pieces[eevee.uid] as PokemonPiece).species).toBe("EEVEE");
    expect(s.pieces[stone.uid]).toBeDefined();
  });

  it("Nincada evolving next to an empty cell also yields Shedinja (Alder evolves bugs early)", () => {
    const nincada = mon("NINCADA", 12, 3, 2); // 12 + 4 = 16 ≥ 20 × 0.8: early, below the normal Lv.20
    const s = applyRoundResult(withPieces("alder", [nincada]), { outcome: "win", fainted: [], battleGold: 0, opponent: { name: "", champion: "red", ghost: false } });
    const species = Object.values(s.pieces).flatMap((p) => (p.kind === "pokemon" ? [p.species] : []));
    expect(species).toContain("NINJASK");
    expect(species).toContain("SHEDINJA");
  });

  it("friendship evolutions take 5 battles; only a branching one (Eevee) waits for the result", () => {
    const loss: Parameters<typeof applyRoundResult>[1] = { outcome: "loss", fainted: [], battleGold: 0, opponent: { name: "", champion: "red", ghost: false } };
    const riolu = mon("RIOLU", 8, 2, 1, { battles: 3 });
    let s = applyRoundResult(withPieces("cynthia", [riolu]), loss);
    expect((s.pieces[riolu.uid] as PokemonPiece).species).toBe("RIOLU");
    s = applyRoundResult(s, loss);
    expect((s.pieces[riolu.uid] as PokemonPiece).species).toBe("LUCARIO");
    const eevee = mon("EEVEE", 8, 2, 1, { battles: 4 });
    const e = applyRoundResult(withPieces("red", [eevee]), loss);
    expect((e.pieces[eevee.uid] as PokemonPiece).species).toBe("UMBREON");
  });

  it("round 8 asks for a subclass and Steven's mega path grants a Metagrossite", () => {
    let s = createRun({ runId: "r", seed: "s", playerName: "p", champion: "steven" });
    for (let i = 0; i < 7; i++) {
      s = applyRoundResult(prepareForBattle(s), { outcome: "win", fainted: [], battleGold: 0, opponent: { name: "", champion: "red", ghost: false } });
    }
    expect(s.round).toBe(8);
    expect(s.phase).toBe("subclass");
    expect(() => applyAction(s, { t: "reroll" })).toThrow("wrong_phase");
    s = applyAction(s, { t: "chooseSubclass", subclass: "steven_mega" });
    expect(s.phase).toBe("shop");
    expect(Object.values(s.pieces).some((p) => p.kind === "item" && p.item === "METAGROSSITE")).toBe(true);
    expect(s.shop.every((slot) => slot.offer)).toBe(true);
  });

  it("Red's Pikachu Partner swaps the starter's weakest move for Volt Tackle, and keeps it after leveling", () => {
    const win: Parameters<typeof applyRoundResult>[1] = { outcome: "win", fainted: [], battleGold: 0, opponent: { name: "", champion: "red", ghost: false } };
    let s = createRun({ runId: "r", seed: "s", playerName: "p", champion: "red" });
    for (let i = 0; i < 7; i++) s = applyRoundResult(prepareForBattle(s), win);
    const starter = Object.values(s.pieces).find((p): p is PokemonPiece => p.kind === "pokemon")!;
    expect(starter.species).toBe("PIKACHU");
    expect(starter.moves).not.toContain("VOLT_TACKLE");
    const before = [...starter.moves];
    expect(s.phase).toBe("subclass");

    const picked = applyAction(s, { t: "chooseSubclass", subclass: "red_pikachu" });
    const after = picked.pieces[starter.uid] as PokemonPiece;
    expect(after.moves).toHaveLength(before.length);
    expect(after.moves).toContain("VOLT_TACKLE");
    const lost = before.filter((m) => !after.moves.includes(m));
    expect(lost).toHaveLength(1);
    expect(after.forgot).toContain(lost[0]);
    expect(picked.notices.some((n) => n.key === "notice.partnerMove")).toBe(true);

    // Later level-ups re-pick the set, but the learned move and the forgotten one stay put.
    const grown = applyRoundResult(prepareForBattle(picked), win).pieces[starter.uid] as PokemonPiece;
    expect(grown.moves).toContain("VOLT_TACKLE");
    expect(grown.moves).not.toContain(lost[0]);

    // The other Red path leaves the starter's moves alone.
    const kanto = applyAction(s, { t: "chooseSubclass", subclass: "red_kanto" }).pieces[starter.uid] as PokemonPiece;
    expect(kanto.moves).toEqual(before);
  });

  it("Geeta earns interest and Leon earns streak income", () => {
    const g = createRun({ runId: "r", seed: "s", playerName: "p", champion: "geeta" });
    g.gold = 20;
    const g2 = applyRoundResult(g, { outcome: "win", fainted: [], battleGold: 0, opponent: { name: "", champion: "red", ghost: false } });
    expect(g2.gold).toBe(20 + 8 + 4);
    const l = createRun({ runId: "r", seed: "s", playerName: "p", champion: "leon" });
    l.streak = 2;
    l.gold = 0;
    const l2 = applyRoundResult(l, { outcome: "win", fainted: [], battleGold: 0, opponent: { name: "", champion: "red", ghost: false } });
    expect(l2.streak).toBe(3);
    expect(l2.gold).toBe(8 + 3);
    // A loss ends the streak but pays the rematch bonus on top of everyone's consolation gold.
    const l3 = applyRoundResult({ ...l2, gold: 0 }, { outcome: "loss", fainted: [], battleGold: 0, opponent: { name: "", champion: "red", ghost: false } });
    expect(l3.streak).toBe(0);
    expect(l3.gold).toBe(9 + 1 + CHAMPION_RULES.leon.lossIncome);
    expect(l3.notices).toContainEqual(expect.objectContaining({ key: "notice.income", params: expect.objectContaining({ rematch: CHAMPION_RULES.leon.lossIncome }) }));
  });
  it("Alder's young bugs are stronger early and the bonus is gone from round 6", () => {
    const hp = (champion: ChampionKey, piece: PokemonPiece, round: number) =>
      simulateBattle({ seed: "early", teams: [team(champion, [piece], null, round), wall()] }).initial.find((b) => b.side === 0)!.maxHp;
    const caterpie = mon("CATERPIE", 12, 3, 1);
    expect(hp("alder", caterpie, 1)).toBeGreaterThan(hp("red", caterpie, 1));
    expect(hp("alder", caterpie, 5)).toBeGreaterThan(hp("red", caterpie, 5));
    expect(hp("alder", caterpie, 6)).toBe(hp("red", caterpie, 6));
    // Only bugs that can still evolve: another type, or a last stage, gets nothing.
    const dratini = mon("DRATINI", 12, 3, 1);
    const snorlax = mon("SNORLAX", 12, 3, 1);
    expect(hp("alder", dratini, 1)).toBe(hp("red", dratini, 1));
    expect(hp("alder", snorlax, 1)).toBe(hp("red", snorlax, 1));
  });

  it("Kukui's early research bonus lasts until round 9 (live: rounds 4–9 were his weak stretch)", () => {
    const { earlyMovePowerBonus: bonus, earlyMovePowerPerRound: perRound } = CHAMPION_RULES.kukui;
    for (let round = 1; round <= 9; round++) expect(earlyBonus(bonus, perRound, round)).toBeGreaterThan(0);
    for (let round = 10; round <= 18; round++) expect(earlyBonus(bonus, perRound, round)).toBe(0);
  });

  it("Leon's flat stat bonus applies with no streak, and his Dynamax comes at 6 seconds", () => {
    const rillaboom = mon("RILLABOOM", 40, 3, 1);
    const hp = (champion: ChampionKey) =>
      simulateBattle({ seed: "flat", teams: [team(champion, [rillaboom], null, 8), wall()] }).initial.find((b) => b.side === 0)!.maxHp;
    expect(hp("leon")).toBeGreaterThan(hp("red"));
    const r = simulateBattle({ seed: "dmax", teams: [team("leon", [mon("CHARIZARD", 50, 3, 1), item("DYNAMAX_BAND", 3, 2)]), wall()] });
    expect(r.events.find((e) => e.k === "form" && (e.form === "gmax" || e.form === "dynamax"))).toMatchObject({ t: CHAMPION_RULES.leon.dynamaxTick });
  });
});
