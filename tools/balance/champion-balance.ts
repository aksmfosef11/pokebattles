/**
 * `pnpm balance` — are the nine champions balanced with their shop pools (own generation + real squad)?
 *
 * For every champion at a mid-game and a late-game round:
 *   worst   – normal bot runs (spend all gold, usual rerolls, random wins/losses) restricted to the
 *             champion's shop; the 10th-percentile run by strength = a run whose shops rolled badly
 *   typical – the median bot run
 *   best    – hill-climbed team: Pokémon from the champion's pool that are unlocked by that round,
 *             at perfect-run levels (bought on unlock, every round won), shop items of unlocked tiers
 *             plus the champion's gimmick items, within the gold earned so far and the board space
 *             that gold buys
 * Strength = win rate against a reference field of typical bot teams of every champion. Lucky vs lucky =
 * a champion's top-decile bot runs against every champion's top-decile runs: can a run that went well
 * beat the other runs that went well (the ghosts a winning run meets)? The search
 * and the report use different fields/seeds so the best teams are not scored on what they were tuned
 * against. Writes docs/balance-report.md.
 *
 * Bot runs and fields are generated once per round and shared by every job. `--seed <salt>` reruns with
 * other bot runs and fields (to see how far the numbers move between samples); `--seeds ,b` runs several
 * seeds in one worker pool and averages them (`,b` = the default seed and "b"). `--fast` skips the
 * best-party search (the slowest and noisiest part) and reports worst / typical / best bot runs and lucky vs
 * lucky only. `--report <path>` writes the report elsewhere.
 *
 * `--rounds 2,4,6` measures other rounds than 8 and 14. `--early` is rounds 1–5 into docs/balance-early-report.md
 * (`pnpm balance:early`): the champions are tuned on rounds 8 and 14, and early-game help for a weak starter
 * has to be gone by round 6 so it cannot move those numbers. The early game is not meant to be even (a champion
 * strong late may start slow); what it must avoid is a champion whose runs routinely open 0–5, so the early
 * report adds each champion's chance of losing all of rounds 1–5. `--stage 0` gives every bot the pool of that
 * unlock stage (meta/progress.ts), i.e. a field of new players.
 *
 *   pnpm balance [--quick] [--fast] [--seed <salt> | --seeds <a,b,...>] [--early | --rounds <r,...>] [--stage <n>] [--report <path>]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BOARD_H,
  BOARD_W,
  botTeam,
  cellKey,
  CHAMPION_KEYS,
  CHAMPION_RULES,
  CHAMPIONS,
  championSpeciesByTier,
  computeAdjacency,
  getSpecies,
  INCOME,
  isLanceKinLine,
  ITEMS,
  moveSlotsFor,
  newPokemon,
  partyCap,
  pieceShape,
  placeShape,
  POKEMON_PRICE,
  rngFor,
  rollTraits,
  roughPower,
  simulateBattle,
  TIER_LEVEL,
  TIER_UNLOCK,
  tierOdds,
  TYPES,
  WINS_TO_CLEAR,
  XP_LOSS,
  XP_WIN,
  type BattleResult,
  type ChampionKey,
  type ItemPiece,
  type Piece,
  type Placement,
  type PokemonPiece,
  type Rng,
  type RunState,
  type SubclassKey,
  type TeamSnapshot,
  type Tier,
} from "../../packages/game/src/index.ts";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const QUICK = process.argv.includes("--quick");
/** Prefix of every seed: another salt samples other bot runs, fields and searches. */
const SALT = argValue("--seed") ?? "";
/** Seeds run by the main process (workers get one `--seed` each). */
const SEEDS = argValue("--seeds")?.split(",") ?? [SALT];
/** Skip the best-party search: bot runs and lucky vs lucky only. */
const FAST = process.argv.includes("--fast");
const EARLY = process.argv.includes("--early");
const ROUNDS = argValue("--rounds")?.split(",").map(Number) ?? (EARLY ? [1, 2, 3, 4, 5] : [8, 14]);
/** Pool unlock stage every bot plays with (undefined: the full pool). */
const STAGE = argValue("--stage") === undefined ? undefined : Number(argValue("--stage"));
const RUNS_PER_CHAMPION = QUICK ? 30 : 150;
/** Opponents per champion in the reference fields (search and report use different teams). */
const SEARCH_FIELD = QUICK ? 1 : 3;
const REPORT_FIELD = QUICK ? 3 : 12;
const SEARCH_STEPS = QUICK ? 80 : 400;
const RIVAL_STEPS = QUICK ? 40 : 250;
/** Independent best-party searches per champion; the best one is kept. */
const SEARCH_RESTARTS = QUICK ? 1 : 2;
const MATRIX_SEEDS = QUICK ? 10 : 40;
const ITEM_CAP: Record<number, number> = { 8: 7, 14: 11 };
/** Items a best party may hold at a round: the table, or the line through it for other rounds. */
const itemCap = (round: number) => ITEM_CAP[round] ?? Math.max(1, Math.round(7 + ((round - 8) * 2) / 3));

// ───────────────────────────── scoring

function battleScore(a: TeamSnapshot, b: TeamSnapshot, seed: string): number {
  const r = simulateBattle({ seed, teams: [a, b] });
  return r.winner === 0 ? 1 : r.winner === null ? 0.5 : 0;
}

/** Share of its starting HP each side still has at the end. */
function hpLeft(r: BattleResult): [number, number] {
  const hp = r.initial.map((b) => b.hp);
  const max = r.initial.map((b) => b.maxHp);
  for (const e of r.events) {
    if (e.k === "damage" || e.k === "heal") hp[e.target] = e.hp;
    if (e.k === "form") hp[e.target] = Math.min(e.hp, max[e.target]!);
  }
  const left: [number, number] = [0, 0];
  const total: [number, number] = [0, 0];
  r.initial.forEach((b, i) => {
    left[b.side] += Math.max(0, Math.min(hp[i]!, max[i]!));
    total[b.side] += max[i]!;
  });
  return [left[0] / Math.max(1, total[0]), left[1] / Math.max(1, total[1])];
}

/** Search objective: wins first, then how decisively (so a team that always wins can still improve). */
function marginScore(a: TeamSnapshot, b: TeamSnapshot, seed: string): number {
  const r = simulateBattle({ seed, teams: [a, b] });
  const [mine, theirs] = hpLeft(r);
  if (r.winner === 0) return 0.75 + 0.25 * mine;
  if (r.winner === 1) return 0.25 * (1 - theirs);
  return 0.5;
}

/** Win rate against a field, playing each opponent from both sides (margin-weighted when searching). */
function strength(team: TeamSnapshot, field: TeamSnapshot[], tag: string, margin = false): number {
  const score = margin ? marginScore : battleScore;
  let total = 0;
  field.forEach((f, i) => {
    total += score(team, f, `${tag}:${i}:a`);
    total += 1 - score(f, team, `${tag}:${i}:b`);
  });
  return total / (field.length * 2);
}


/**
 * One champion's share of a round's fields: typical bot teams for the report, and for the search a
 * tougher field of the strongest of three bot runs per slot.
 */
function fieldTeams(champion: ChampionKey, round: number): { report: TeamSnapshot[]; lucky: TeamSnapshot[] } {
  return {
    report: Array.from({ length: REPORT_FIELD }, (_, i) => botTeam(`${SALT}report-${champion}-${i}`, round, champion, STAGE)),
    lucky: Array.from({ length: SEARCH_FIELD }, (_, i) =>
      [0, 1, 2].map((k) => botTeam(`${SALT}search-${champion}-${i}-${k}`, round, champion, STAGE)).reduce((a, b) => (roughPower(b) > roughPower(a) ? b : a)),
    ),
  };
}

/** A round's fields, built once by the field jobs: `lucky` per champion. */
interface Fields {
  report: TeamSnapshot[];
  lucky: Record<string, TeamSnapshot[]>;
}

/** A run ends at 10 wins, so the best record that still plays `round` is (up to) 9 wins, the losses first. */
function bestRecord(round: number): { wins: number; losses: number } {
  const wins = Math.min(round - 1, WINS_TO_CLEAR - 1);
  return { wins, losses: round - 1 - wins };
}

// ───────────────────────────── best party search

interface Candidate {
  species: string;
  level: number;
  cost: number;
}

/** Perfect run: every tier bought when it unlocks, every round won since. */
function candidates(champion: ChampionKey, round: number): Candidate[] {
  const byTier = championSpeciesByTier(champion);
  const best = new Map<string, Candidate>();
  const record = (c: Candidate) => {
    const prev = best.get(c.species);
    if (!prev || c.level > prev.level || (c.level === prev.level && c.cost < prev.cost)) best.set(c.species, c);
  };
  for (const tier of [1, 2, 3, 4, 5] as Tier[]) {
    const unlock = tier === 5 && champion === "cynthia" ? CHAMPION_RULES.cynthia.legendaryUnlockRound : TIER_UNLOCK[tier];
    if (round < unlock) continue;
    const bought = Math.max(1, unlock);
    // Rounds since purchase split between the run's losses (early) and wins (late).
    const { losses } = bestRecord(round);
    const since = round - bought;
    const lostSince = Math.max(0, losses - (bought - 1));
    const level = TIER_LEVEL[tier] + XP_LOSS * Math.min(since, lostSince) + XP_WIN * Math.max(0, since - lostSince);
    const battles = since;
    for (const buy of byTier[tier]) {
      const walk = (species: string, cost: number) => {
        const s = getSpecies(species);
        // Level and battle evolutions happen on their own, so an unevolved one past that point cannot exist.
        let forced = false;
        for (const evo of s.evolutions) {
          let ok = false;
          let extra = 0;
          if (evo.item) {
            ok = true;
            extra = 3;
          } else if (evo.level !== undefined) {
            let need = evo.level;
            if (champion === "lance" && isLanceKinLine(species)) need = Math.floor(need * CHAMPION_RULES.lance.dragonEvoLevelMultiplier);
            if (champion === "alder" && s.types.includes("bug")) need = Math.floor(need * CHAMPION_RULES.alder.bugEvoLevelMultiplier);
            ok = level >= need;
            forced ||= ok;
          } else if (evo.battles !== undefined) {
            ok = battles >= evo.battles && evo.onResult !== "loss";
            forced ||= ok;
          }
          if (ok) walk(evo.to, cost + extra);
        }
        if (!forced) record({ species, level, cost });
      };
      walk(buy, POKEMON_PRICE[tier]);
    }
  }
  return [...best.values()].sort((a, b) => (a.species < b.species ? -1 : 1));
}

const USEFUL_FAMILIES = new Set(["held", "berry", "typeBoost", "weatherRock", "orb", "zCrystal", "tera", "dynamax"]);

function itemCandidates(champion: ChampionKey, round: number): string[] {
  const odds = tierOdds({ round, champion } as RunState);
  const maxTier = odds.reduce((m, w, i) => (w > 0 ? i + 1 : m), 1);
  return Object.values(ITEMS)
    .filter((d) => !d.noShop && d.tier <= maxTier && (!d.champions || d.champions.includes(champion)))
    .filter((d) => USEFUL_FAMILIES.has(d.family) || (champion === "steven" && d.stone))
    .filter((d) => !d.consumable && !d.forSpecies)
    .map((d) => d.key)
    .sort();
}

/** Items every run of the champion starts with or gets for free. */
function fixedItems(champion: ChampionKey, subclass: SubclassKey): { key: string; param?: string }[] {
  const starter = CHAMPIONS[champion].starter;
  const out: { key: string; param?: string }[] = [{ key: starter.item, ...(starter.itemParam ? { param: starter.itemParam } : {}) }];
  if (subclass === "geeta_stellar") out.push({ key: "TERA_SHARD", param: "stellar" });
  return out;
}

interface Plan {
  subclass: SubclassKey;
  mons: { species: string; ability: string }[];
  items: { key: string; param?: string; holder: number; fixed?: boolean }[];
}

function traitsFor(species: string, ability: string) {
  const t = rollTraits(species, rngFor("balance", species));
  return { ...t, ivs: { hp: 20, atk: 20, def: 20, spa: 20, spd: 20, spe: 20 }, nature: "HARDY" as const, ability, hiddenAbility: false, shiny: false };
}

/** Places a plan on the board: each Pokémon, then its items touching it (front row first). */
function layout(plan: Plan, cands: Map<string, Candidate>, champion: ChampionKey, round: number): TeamSnapshot | null {
  const pieces: Record<string, Piece> = {};
  const taken = new Set<number>();
  const fits = (p: Piece, place: Placement) =>
    placeShape(pieceShape(p), place).every((c) => c.x >= 0 && c.y >= 0 && c.x < BOARD_W && c.y < BOARD_H && !taken.has(cellKey(c)));
  const put = (p: Piece, place: Placement) => {
    p.place = place;
    pieces[p.uid] = p;
    for (const c of placeShape(pieceShape(p), place)) taken.add(cellKey(c));
  };
  const monUids: string[] = [];
  const { wins, losses } = bestRecord(round);
  plan.mons.forEach((m, i) => {
    const c = cands.get(m.species)!;
    let level = c.level;
    if (champion === "red" && i === 0) {
      level = Math.min(100, level + CHAMPION_RULES.red.aceExtraLevels * Math.floor((wins + losses) / CHAMPION_RULES.red.aceExtraLevelEvery));
    }
    const mon = newPokemon(`m${i}`, m.species, level, traitsFor(m.species, m.ability), 0, moveSlotsFor(plan.subclass));
    if (champion === "red" && i === 0) mon.aceBonus = Math.min(CHAMPION_RULES.red.aceWinStatCap, CHAMPION_RULES.red.aceWinStatBonus * wins);
    monUids.push(mon.uid);
    const need = plan.items.filter((it) => it.holder === i).length;
    let placed = false;
    for (let y = 0; y < BOARD_H && !placed; y++) {
      for (let x = 0; x < BOARD_W && !placed; x++) {
        for (const rot of [0, 1] as const) {
          const place = { x, y, rot };
          if (!fits(mon, place)) continue;
          const cells = placeShape(pieceShape(mon), place);
          const free = new Set<number>();
          for (const cell of cells) {
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const n = { x: cell.x + dx!, y: cell.y + dy! };
              const k = cellKey(n);
              if (n.x >= 0 && n.y >= 0 && n.x < BOARD_W && n.y < BOARD_H && !taken.has(k) && !cells.some((q) => cellKey(q) === k)) free.add(k);
            }
          }
          if (free.size < need) continue;
          put(mon, place);
          placed = true;
          break;
        }
      }
    }
    if (!placed) return;
    // Its items: every rotation/spot that reaches it, preferring spots that also reach allies.
    plan.items.forEach((it, j) => {
      if (it.holder !== i) return;
      const item: ItemPiece = { uid: `i${j}`, kind: "item", place: null, paid: 0, item: it.key, age: 0, ...(it.param ? { param: it.param } : {}) };
      let best: Placement | null = null;
      let bestScore = 0;
      for (let y = 0; y < BOARD_H; y++) {
        for (let x = 0; x < BOARD_W; x++) {
          for (const rot of [0, 1, 2, 3] as const) {
            const place = { x, y, rot };
            if (!fits(item, place)) continue;
            const holders = computeAdjacency({ ...pieces, [item.uid]: { ...item, place } }).holdersOf.get(item.uid) ?? [];
            if (!holders.includes(mon.uid)) continue;
            const score = 10 + holders.length;
            if (score > bestScore) {
              best = place;
              bestScore = score;
            }
          }
        }
      }
      if (best) put(item, best);
    });
  });
  if (monUids.some((u) => !pieces[u])) return null;
  return {
    name: `best-${champion}`,
    champion,
    subclass: round >= 8 ? plan.subclass : null,
    round,
    wins,
    losses,
    streak: wins,
    ace: champion === "red" ? "m0" : null,
    pieces: Object.values(pieces),
  };
}

function budget(champion: ChampionKey, round: number, subclass: SubclassKey): number {
  const { losses } = bestRecord(round);
  let gold = 0;
  for (let r = 1; r <= round; r++) {
    gold += INCOME[r - 1] ?? 16;
    if (r > 1 && r - 1 <= losses) gold += 1; // consolation
    if (champion === "steven" && r > 1) gold += CHAMPION_RULES.steven.extraIncome;
    if (champion === "leon" && r - 1 > losses) gold += Math.min(r - 1 - losses, CHAMPION_RULES.leon.streakIncomeCap);
  }
  if (champion === "geeta") {
    // Banking enough gold for the full interest from round 4 on, minus the gold kept in the bank.
    const cap = subclass === "geeta_investor" && round >= 8 ? CHAMPION_RULES.geeta.investorInterestCap : CHAMPION_RULES.geeta.interestCap;
    gold += Math.max(0, cap * Math.max(0, round - 4) - cap * CHAMPION_RULES.geeta.interestPer);
  }
  return gold;
}

function planCost(plan: Plan, cands: Map<string, Candidate>): { gold: number; cells: number } {
  let gold = 0;
  let cells = 0;
  for (const m of plan.mons) {
    gold += cands.get(m.species)!.cost;
    const f = getSpecies(m.species).footprint;
    cells += f.w * f.h;
  }
  for (const it of plan.items) {
    if (!it.fixed) gold += ITEMS[it.key]!.price;
    const s = ITEMS[it.key]!.size ?? { w: 1, h: 1 };
    cells += s.w * s.h;
  }
  // Board space: the 3×3 starting bag is free, every further cell costs about 1G of bags.
  gold += Math.max(0, cells - 9);
  return { gold, cells };
}

function feasible(plan: Plan, cands: Map<string, Candidate>, champion: ChampionKey, round: number): boolean {
  if (new Set(plan.mons.map((m) => m.species)).size !== plan.mons.length) return false;
  const { gold } = planCost(plan, cands);
  return gold <= budget(champion, round, plan.subclass) && plan.items.length <= itemCap(round) && plan.mons.length <= partyCap({ champion, round });
}

function mutate(plan: Plan, rng: Rng, pool: Candidate[], items: string[], champion: ChampionKey, round: number): Plan {
  const next: Plan = structuredClone(plan);
  const op = rng.int(0, 7);
  const pickItem = (): { key: string; param?: string } => {
    const key = rng.pick(items);
    return ITEMS[key]!.param === "type" ? { key, param: rng.pick(TYPES) } : { key };
  };
  const pickMon = () => {
    const c = rng.pick(pool.filter((p) => !next.mons.some((m) => m.species === p.species)));
    return { species: c.species, ability: rng.pick(getSpecies(c.species).abilities) };
  };
  switch (op) {
    case 0:
    case 1: // replace a Pokémon
      if (next.mons.length > 0) next.mons[rng.int(0, next.mons.length - 1)] = pickMon();
      break;
    case 2: // add or drop a Pokémon
      if (rng.chance(0.6) && next.mons.length < partyCap({ champion, round })) next.mons.push(pickMon());
      else if (next.mons.length > 1) {
        const i = rng.int(0, next.mons.length - 1);
        next.mons.splice(i, 1);
        next.items = next.items.filter((it) => it.holder !== i || it.fixed).map((it) => ({ ...it, holder: it.holder > i ? it.holder - 1 : Math.min(it.holder, next.mons.length - 1) }));
      }
      break;
    case 3: // reorder (formation)
      if (next.mons.length > 1) {
        const i = rng.int(0, next.mons.length - 1);
        const j = rng.int(0, next.mons.length - 1);
        [next.mons[i], next.mons[j]] = [next.mons[j]!, next.mons[i]!];
        for (const it of next.items) it.holder = it.holder === i ? j : it.holder === j ? i : it.holder;
      }
      break;
    case 4:
    case 5: {
      // replace / add / drop an item
      const free = next.items.map((it, i) => ({ it, i })).filter(({ it }) => !it.fixed);
      if (rng.chance(0.5) && free.length > 0) next.items[rng.pick(free).i] = { ...pickItem(), holder: rng.int(0, next.mons.length - 1) };
      else if (rng.chance(0.7)) next.items.push({ ...pickItem(), holder: rng.int(0, next.mons.length - 1) });
      else if (free.length > 0) next.items.splice(rng.pick(free).i, 1);
      break;
    }
    case 6: // move an item (also the gimmick ones) to another Pokémon, or retune a type parameter
      if (next.items.length > 0) {
        const it = rng.pick(next.items);
        if (it.param && rng.chance(0.5)) it.param = rng.pick([...TYPES, ...(it.key === "TERA_SHARD" ? ["stellar"] : [])]);
        else it.holder = rng.int(0, next.mons.length - 1);
      }
      break;
    case 7: // ability or subclass
      if (rng.chance(0.3)) next.subclass = rng.pick(CHAMPIONS[champion].subclasses);
      else if (next.mons.length > 0) {
        const m = rng.pick(next.mons);
        m.ability = rng.pick(getSpecies(m.species).abilities);
      }
      break;
  }
  return next;
}

/** Mega stones for mega-capable members (Diantha: bracelet next to the first; Steven's mega subclass). */
function withGimmicks(plan: Plan, champion: ChampionKey): Plan {
  const next = structuredClone(plan);
  next.items = next.items.filter((it) => !ITEMS[it.key]?.mega);
  const megaSlots = champion === "diantha" ? (next.subclass === "diantha_dual" ? 2 : 1) : next.subclass === "steven_mega" ? 1 : 0;
  let used = 0;
  next.mons.forEach((m, i) => {
    if (used >= megaSlots) return;
    const s = getSpecies(m.species);
    const form = s.megaForms[0];
    if (!form || (champion === "steven" && m.species !== "METAGROSS")) return;
    next.items.push({ key: form.item, holder: i, fixed: champion === "steven" });
    used++;
  });
  return next;
}

function searchBest(
  champion: ChampionKey,
  round: number,
  field: TeamSnapshot[],
  steps: number,
  from?: Plan,
  restart = 0,
): { team: TeamSnapshot; plan: Plan; score: number } {
  const rng = rngFor("balance-search", SALT, champion, round, from ? "rivals" : "field", restart);
  const pool = candidates(champion, round);
  const cands = new Map(pool.map((c) => [c.species, c]));
  const items = itemCandidates(champion, round);
  // Start: the strongest-looking affordable Pokémon, then generic items.
  const power = (c: Candidate) => getSpecies(c.species).bst * (1 + c.level / 50) - c.cost * 8;
  const start: Plan = { subclass: CHAMPIONS[champion].subclasses[0], mons: [], items: [] };
  for (const f of fixedItems(champion, start.subclass)) start.items.push({ ...f, holder: 0, fixed: true });
  for (const c of [...pool].sort((a, b) => power(b) - power(a))) {
    if (start.mons.length >= partyCap({ champion, round })) break;
    const trial = { ...start, mons: [...start.mons, { species: c.species, ability: getSpecies(c.species).abilities[0]! }] };
    if (feasible(withGimmicks(trial, champion), cands, champion, round)) start.mons = trial.mons;
  }
  for (const key of ["LIFE_ORB", "LEFTOVERS", "SITRUS_BERRY", "EXPERT_BELT", "SHELL_BELL", "CHOICE_SPECS", "CHOICE_BAND", "ASSAULT_VEST"]) {
    if (!items.includes(key)) continue;
    const trial = { ...start, items: [...start.items, { key, holder: start.items.length % Math.max(1, start.mons.length) }] };
    if (feasible(withGimmicks(trial, champion), cands, champion, round)) start.items = trial.items;
  }
  let plan = from ?? withGimmicks(start, champion);
  // The board is tight: drop generic items, then the last Pokémon, until the starting team fits.
  let placed = layout(plan, cands, champion, round);
  while (!placed) {
    const trimmed: Plan = structuredClone(plan);
    // Mega stones come back with their Pokémon (withGimmicks), so they are not trimmed on their own.
    const free = trimmed.items.map((it, i) => ({ it, i })).filter(({ it }) => !it.fixed && !ITEMS[it.key]?.mega);
    if (free.length > 0) trimmed.items.splice(free[free.length - 1]!.i, 1);
    else {
      if (trimmed.mons.length <= 1) throw new Error(`no ${champion} team fits the board`);
      trimmed.mons.pop();
      trimmed.items = trimmed.items.map((it) => ({ ...it, holder: Math.min(it.holder, trimmed.mons.length - 1) }));
    }
    plan = withGimmicks(trimmed, champion);
    placed = layout(plan, cands, champion, round);
  }
  let team = placed;
  let score = strength(team, field, "search", true);
  for (let step = 0; step < steps; step++) {
    const next = withGimmicks(mutate(plan, rng, pool, items, champion, round), champion);
    if (next.mons.length === 0 || !feasible(next, cands, champion, round)) continue;
    const t = layout(next, cands, champion, round);
    if (!t) continue;
    const s = strength(t, field, "search", true);
    if (s >= score) {
      plan = next;
      team = t;
      score = s;
    }
  }
  return { team, plan, score };
}

// ───────────────────────────── report

const pct = (x: number) => `${Math.round(x * 100)}%`;

function describe(team: TeamSnapshot): string {
  const mons = team.pieces.filter((p): p is PokemonPiece => p.kind === "pokemon");
  const adj = computeAdjacency(Object.fromEntries(team.pieces.map((p) => [p.uid, p])));
  return mons
    .map((m) => {
      const items = (adj.itemsOf.get(m.uid) ?? []).map((i) => (i.param ? `${i.item}(${i.param})` : i.item));
      return `${m.species} Lv${m.level}${items.length ? ` [${items.join(", ")}]` : ""}`;
    })
    .join("; ");
}

interface JobResult {
  champion: ChampionKey;
  round: number;
  worst: number;
  typical: number;
  bestBot: number;
  /** Strength of each bot run, in run order (run i is the same run at every round). */
  byRun: number[];
  /** Top-decile bot runs (pass 1), and their win rate against every champion's (pass 2). */
  lucky: TeamSnapshot[];
  luckyVsLucky: number;
  best: number;
  bestTeam: TeamSnapshot;
  worstTeam: TeamSnapshot;
  plan: Plan | null;
}

/**
 * Pass 1: bot runs (worst/typical) and a best party searched against lucky bots.
 * Pass 2 (`rivals` = pass-1 results): the best party keeps improving against the other champions' best parties.
 */
function runJob(champion: ChampionKey, round: number, fields: Fields, rivals: JobResult[] | null): JobResult {
  const reportField = fields.report;
  if (rivals) {
    const mine = rivals.find((r) => r.champion === champion && r.round === round)!;
    const luckyField = rivals.filter((r) => r.round === round).flatMap((r) => r.lucky);
    const luckyVsLucky = mine.lucky.reduce((sum, t) => sum + strength(t, luckyField, "lucky"), 0) / mine.lucky.length;
    if (FAST) return { ...mine, luckyVsLucky };
    const others = rivals.filter((r) => r.round === round && r.champion !== champion).map((r) => r.bestTeam);
    const field = [...CHAMPION_KEYS.map((c) => fields.lucky[c]![0]!), ...others, ...others];
    const found = searchBest(champion, round, field, RIVAL_STEPS, mine.plan!);
    return { ...mine, best: strength(found.team, reportField, "report"), bestTeam: found.team, plan: found.plan, luckyVsLucky };
  }
  const searchField = CHAMPION_KEYS.flatMap((c) => fields.lucky[c]!);
  const unsorted = Array.from({ length: RUNS_PER_CHAMPION }, (_, i) => botTeam(`${SALT}run-${champion}-${i}`, round, champion, STAGE)).map(
    (t) => ({ t, s: strength(t, reportField, "report") }),
  );
  const byRun = unsorted.map((r) => r.s);
  const runs = [...unsorted].sort((a, b) => a.s - b.s);
  const at = (q: number) => runs[Math.min(runs.length - 1, Math.floor(q * runs.length))]!;
  const bot = {
    champion,
    round,
    worst: at(0.1).s,
    typical: at(0.5).s,
    bestBot: at(0.9).s,
    byRun,
    lucky: runs.slice(Math.floor(runs.length * 0.9)).map((r) => r.t),
    luckyVsLucky: NaN,
    worstTeam: at(0.1).t,
  };
  if (FAST) return { ...bot, best: NaN, bestTeam: at(0.9).t, plan: null };
  let found = searchBest(champion, round, searchField, SEARCH_STEPS);
  for (let restart = 1; restart < SEARCH_RESTARTS; restart++) {
    const again = searchBest(champion, round, searchField, SEARCH_STEPS, undefined, restart);
    if (again.score > found.score) found = again;
  }
  return {
    champion,
    round,
    worst: at(0.1).s,
    typical: at(0.5).s,
    bestBot: at(0.9).s,
    byRun,
    lucky: runs.slice(Math.floor(runs.length * 0.9)).map((r) => r.t),
    luckyVsLucky: NaN,
    best: strength(found.team, reportField, "report"),
    bestTeam: found.team,
    worstTeam: at(0.1).t,
    plan: found.plan,
  };
}

function runWorker(args: string[], out: string): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), ...args, "--out", out], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    child.on("exit", (code) => (code === 0 ? done() : fail(new Error(`worker ${args.join(" ")} exited ${code}`))));
  });
}

function matrix(
  rows: JobResult[],
  left: (r: JobResult) => TeamSnapshot,
  right: (r: JobResult) => TeamSnapshot,
  skipSelf: boolean,
): { lines: string[]; avg: Map<ChampionKey, number> } {
  const out = [`| | ${rows.map((r) => r.champion).join(" | ")} | avg |`, `|---|${rows.map(() => "---").join("|")}|---|`];
  const avg = new Map<ChampionKey, number>();
  for (const a of rows) {
    const cells: number[] = [];
    for (const b of rows) {
      if (a === b && skipSelf) {
        cells.push(NaN);
        continue;
      }
      let s = 0;
      for (let k = 0; k < MATRIX_SEEDS; k++) {
        s += k % 2 === 0 ? battleScore(left(a), right(b), `${SALT}m${k}`) : 1 - battleScore(right(b), left(a), `${SALT}m${k}`);
      }
      cells.push(s / MATRIX_SEEDS);
    }
    const valid = cells.filter((x) => !Number.isNaN(x));
    avg.set(a.champion, valid.reduce((p, q) => p + q, 0) / valid.length);
    out.push(`| ${a.champion} | ${cells.map((x) => (Number.isNaN(x) ? "—" : pct(x))).join(" | ")} | **${pct(avg.get(a.champion)!)}** |`);
  }
  return { lines: out, avg };
}

async function main(): Promise<void> {
  const out = argValue("--out");
  const fieldArg = process.argv.indexOf("--field");
  if (fieldArg >= 0) {
    writeFileSync(out!, JSON.stringify(fieldTeams(process.argv[fieldArg + 1] as ChampionKey, Number(process.argv[fieldArg + 2]))));
    return;
  }
  const jobArg = process.argv.indexOf("--job");
  if (jobArg >= 0) {
    const champion = process.argv[jobArg + 1] as ChampionKey;
    const round = Number(process.argv[jobArg + 2]);
    const fields = JSON.parse(readFileSync(argValue("--fields")!, "utf8")) as Record<string, Fields>;
    const rivalsFile = argValue("--rivals");
    const rivals = rivalsFile ? (JSON.parse(readFileSync(rivalsFile, "utf8")) as JobResult[]) : null;
    writeFileSync(out!, JSON.stringify(runJob(champion, round, fields[round]!, rivals)));
    return;
  }
  const started = Date.now();
  const dir = mkdtempSync(join(tmpdir(), "pokebattles-balance-"));
  const flags = [...(QUICK ? ["--quick"] : []), ...(FAST ? ["--fast"] : []), ...(STAGE !== undefined ? ["--stage", String(STAGE)] : [])];
  // Round 14 jobs are the slowest: queue them first so the pool does not end on one long job.
  const jobs = SEEDS.flatMap((seed) => [...ROUNDS].reverse().flatMap((round) => CHAMPION_KEYS.map((champion) => ({ seed, champion, round }))));
  type Job = (typeof jobs)[number];
  const runPass = async (kind: "--field" | "--job", extra: (j: Job) => string[], label: string) => {
    const queue = [...jobs];
    const file = (j: Job) => join(dir, `${kind.slice(2)}-${j.seed || "base"}-${j.champion}-${j.round}.json`);
    const workers = Array.from({ length: Math.max(1, Math.min(jobs.length, cpus().length)) }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        await runWorker([kind, job.champion, String(job.round), ...extra(job), ...flags, ...(job.seed ? ["--seed", job.seed] : [])], file(job));
        console.error(`  ${label}: ${job.seed ? `[${job.seed}] ` : ""}${job.champion} round ${job.round} done (${Math.round((Date.now() - started) / 1000)}s)`);
      }
    });
    await Promise.all(workers);
    return jobs.map((j) => ({ ...j, data: JSON.parse(readFileSync(file(j), "utf8")) }));
  };
  const seedFile = (seed: string, name: string) => join(dir, `${name}-${seed || "base"}.json`);
  const fieldParts = await runPass("--field", () => [], "fields");
  for (const seed of SEEDS) {
    const fields: Record<string, Fields> = {};
    for (const round of ROUNDS) {
      const parts = fieldParts.filter((p) => p.seed === seed && p.round === round);
      fields[round] = {
        report: parts.flatMap((p) => p.data.report as TeamSnapshot[]),
        lucky: Object.fromEntries(parts.map((p) => [p.champion, p.data.lucky as TeamSnapshot[]])),
      };
    }
    writeFileSync(seedFile(seed, "fields"), JSON.stringify(fields));
  }
  const pass1 = await runPass("--job", (j) => ["--fields", seedFile(j.seed, "fields")], "pass 1");
  for (const seed of SEEDS) writeFileSync(seedFile(seed, "rivals"), JSON.stringify(pass1.filter((p) => p.seed === seed).map((p) => p.data)));
  const pass2 = await runPass("--job", (j) => ["--fields", seedFile(j.seed, "fields"), "--rivals", seedFile(j.seed, "rivals")], "pass 2");
  const bySeed = SEEDS.map((seed) => pass2.filter((p) => p.seed === seed).map((p) => p.data as JobResult));

  const lines: string[] = [];
  const log = (s = "") => {
    console.log(s);
    lines.push(s);
  };
  const seedLabel = (s: string) => (s === "" ? "default" : s);
  log("# Champion balance report");
  log();
  const roundsFlag = `${EARLY ? " --early" : ROUNDS.join(",") === "8,14" ? "" : ` --rounds ${ROUNDS.join(",")}`}${STAGE !== undefined ? ` --stage ${STAGE}` : ""}`;
  const command = `pnpm balance${QUICK ? " --quick" : ""}${FAST ? " --fast" : ""}${SEEDS.length > 1 ? ` --seeds ${SEEDS.join(",")}` : SALT ? ` --seed ${SALT}` : ""}${roundsFlag}`;
  log(
    `Generated by \`${command}\`: ${RUNS_PER_CHAMPION} bot runs per champion, report field ${REPORT_FIELD * 9} teams${FAST ? " (best-party search skipped)" : `, search field ${SEARCH_FIELD * 9} lucky bot teams, ${SEARCH_RESTARTS} × ${SEARCH_STEPS} + ${RIVAL_STEPS} (vs rival best parties) search steps`}${SEEDS.length > 1 ? `, averaged over ${SEEDS.length} seeds (${SEEDS.map(seedLabel).join(", ")})` : ""}. Round 14 is the last round a run can reach (9 wins, 4 losses).`,
  );
  log("Strength = win rate against a field of typical bot teams from all champions (both sides): worst = p10 run, typical = median, best = p90.");
  log("Lucky vs lucky = the champion's top-decile bot runs against the top-decile runs of every champion.");
  // Best-vs-best needs the searched parties; with several seeds every seed's matrix is averaged.
  const bvb = FAST ? null : bySeed.map((results) => new Map(ROUNDS.map((round) => [round, matrix(results.filter((r) => r.round === round), (r) => r.bestTeam, (r) => r.bestTeam, true)])));
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const avg = (c: ChampionKey, round: number, f: (r: JobResult) => number) => mean(bySeed.map((rs) => f(rs.find((r) => r.champion === c && r.round === round)!)));
  const bvbAvg = (c: ChampionKey, round: number) => (bvb ? mean(bvb.map((m) => m.get(round)!.avg.get(c)!)) : NaN);
  log();
  log(`## Summary (worst p10 / typical median / best p90 of bot runs, lucky vs lucky${FAST ? "" : ", best vs best"})`);
  log();
  log(`| Champion | ${ROUNDS.map((r) => `Round ${r}`).join(" | ")} |`);
  log(`|---|${ROUNDS.map(() => "---").join("|")}|`);
  for (const c of CHAMPION_KEYS) {
    const cells = ROUNDS.map(
      (round) =>
        `${pct(avg(c, round, (r) => r.worst))} / **${pct(avg(c, round, (r) => r.typical))}** / ${pct(avg(c, round, (r) => r.bestBot))}, lucky ${pct(avg(c, round, (r) => r.luckyVsLucky))}${FAST ? "" : `, best ${pct(bvbAvg(c, round))}`}`,
    );
    log(`| ${c} | ${cells.join(" | ")} |`);
  }
  // A run opens 0–5 when it loses every battle of rounds 1–5: per run the product of its loss chances, averaged.
  if ([1, 2, 3, 4, 5].every((r) => ROUNDS.includes(r))) {
    const zeroFive = (c: ChampionKey, pick: (chances: number[]) => number) =>
      mean(
        bySeed.map((rs) => {
          const perRound = [1, 2, 3, 4, 5].map((round) => rs.find((r) => r.champion === c && r.round === round)!.byRun);
          const chances = perRound[0]!.map((_, i) => perRound.reduce((p, byRun) => p * (1 - byRun[i]!), 1)).sort((a, b) => a - b);
          return pick(chances);
        }),
      );
    log();
    log("## 0–5 start (losing every battle of rounds 1–5)");
    log();
    log("Chance a run opens 0–5 against random field opponents: averaged over its bot runs, and for its unluckiest tenth (p90 of the chance).");
    log();
    log("| Champion | 0–5 chance | unlucky runs (p90) |");
    log("|---|---|---|");
    for (const c of CHAMPION_KEYS) log(`| ${c} | ${pct(zeroFive(c, mean))} | ${pct(zeroFive(c, (xs) => xs[Math.floor(xs.length * 0.9)]!))} |`);
  }
  for (const round of ROUNDS) {
    log();
    log(`## Round ${round}`);
    log();
    log(`| Champion | Worst (bad shops, p10) | Typical (median) | Lucky bot (p90) | Lucky vs lucky |${FAST ? "" : " Best party |"}`);
    log(`|---|---|---|---|---|${FAST ? "" : "---|"}`);
    for (const c of CHAMPION_KEYS) {
      const cells = [(r: JobResult) => r.worst, (r: JobResult) => r.typical, (r: JobResult) => r.bestBot, (r: JobResult) => r.luckyVsLucky];
      if (!FAST) cells.push((r) => r.best);
      log(`| ${c} | ${cells.map((f) => pct(avg(c, round, f))).join(" | ")} |`);
    }
    if (SEEDS.length > 1) {
      log();
      log(`Per seed (${SEEDS.map(seedLabel).join(" / ")}): typical median and lucky vs lucky`);
      log();
      for (const c of CHAMPION_KEYS) {
        const per = bySeed.map((rs) => rs.find((r) => r.champion === c && r.round === round)!);
        log(`- ${c}: typical ${per.map((r) => pct(r.typical)).join(" / ")}, lucky ${per.map((r) => pct(r.luckyVsLucky)).join(" / ")}`);
      }
    }
    if (FAST) continue;
    // Matrices and parties of the first seed only (the averaged tables above cover every seed).
    const rows = bySeed[0]!.filter((r) => r.round === round);
    log();
    log(`### Best vs best (row's win rate)${SEEDS.length > 1 ? `, seed ${seedLabel(SEEDS[0]!)}` : ""}`);
    log();
    for (const l of bvb![0]!.get(round)!.lines) log(l);
    log();
    log("### Worst vs worst (row's win rate)");
    log();
    for (const l of matrix(rows, (r) => r.worstTeam, (r) => r.worstTeam, true).lines) log(l);
    log();
    log("### Best (row) vs worst (column)");
    log();
    for (const l of matrix(rows, (r) => r.bestTeam, (r) => r.worstTeam, false).lines) log(l);
    log();
    log("### Best parties found");
    log();
    for (const r of rows) log(`- **${r.champion}** (${r.bestTeam.subclass ?? "no subclass"}): ${describe(r.bestTeam)}`);
    log();
    log("### Worst (p10) bot parties");
    log();
    for (const r of rows) log(`- **${r.champion}**: ${describe(r.worstTeam)}`);
  }
  log();
  log(`_${Math.round((Date.now() - started) / 1000)}s_`);
  const reportName = `balance${EARLY ? "-early" : ""}${STAGE !== undefined ? `-stage${STAGE}` : ""}-report.md`;
  const report = resolve(argValue("--report") ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", reportName));
  writeFileSync(report, lines.join("\n") + "\n");
  console.error(`wrote ${report}`);
}

await main();
