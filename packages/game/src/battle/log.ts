import type { TeamSnapshot } from "../run/types.ts";
import type { BattleResult, Side } from "./types.ts";

/** One Pokémon's part in a battle, for balance statistics (server `battles.detail`). */
export interface BattlerLog {
  side: Side;
  species: string;
  level: number;
  ability: string;
  /** Items touching it (each key once). */
  items: string[];
  nature: string;
  /** Sum of its six IVs (0–186). */
  ivs: number;
  shiny?: true;
  /** Front-most board row it stands on (0 = front) and its left-most column. */
  row: number;
  col: number;
  maxHp: number;
  /** Damage it did to enemies directly: moves, contact abilities, Rocky Helmet, Leech Seed, binding. */
  dealt: number;
  taken: number;
  healed: number;
  /** Enemies whose fainting blow was its damage. */
  kos: number;
  fainted: boolean;
  /** Ticks it was on the field (the whole battle if it never fainted). */
  alive: number;
  /** Moves it used (Z-Moves included). */
  moves: number;
  z?: number;
  /** Mega Evolution, Dynamax / Gigantamax, Terastallization, ... as they happened. */
  forms?: string[];
}

export interface BattleLog {
  ticks: number;
  winner: Side | null;
  /** Share of each side's starting HP left at the end. */
  hpLeft: [number, number];
  battlers: BattlerLog[];
}

/** Sums a simulated battle up per Pokémon (the event stream is far too long to keep). */
export function battleLog(result: BattleResult, teams: readonly [TeamSnapshot, TeamSnapshot]): BattleLog {
  const logs: BattlerLog[] = result.initial.map((b) => {
    const piece = teams[b.side].pieces.find((p) => p.uid === b.uid);
    const mon = piece?.kind === "pokemon" ? piece : null;
    return {
      side: b.side,
      species: b.species,
      level: b.level,
      ability: b.ability,
      items: b.items,
      nature: mon?.nature ?? "",
      ivs: mon ? Object.values(mon.ivs).reduce((a, v) => a + v, 0) : 0,
      ...(b.shiny ? { shiny: true as const } : {}),
      row: b.cells.length ? Math.min(...b.cells.map((c) => c.y)) : 0,
      col: b.cells.length ? Math.min(...b.cells.map((c) => c.x)) : 0,
      maxHp: b.maxHp,
      dealt: 0,
      taken: 0,
      healed: 0,
      kos: 0,
      fainted: false,
      alive: result.ticks,
      moves: 0,
    };
  });
  const hp = result.initial.map((b) => b.hp);
  for (const e of result.events) {
    switch (e.k) {
      case "damage": {
        const target = logs[e.target]!;
        target.taken += e.amount;
        hp[e.target] = e.hp;
        const src = e.src !== undefined ? logs[e.src] : undefined;
        if (src && src.side !== target.side) {
          src.dealt += e.amount;
          if (e.hp <= 0) src.kos++;
        }
        break;
      }
      case "heal":
        logs[e.target]!.healed += e.amount;
        hp[e.target] = e.hp;
        break;
      case "faint":
        logs[e.target]!.fainted = true;
        logs[e.target]!.alive = e.t;
        break;
      case "move": {
        const src = logs[e.src]!;
        src.moves++;
        if (e.variant === "z") src.z = (src.z ?? 0) + 1;
        break;
      }
      case "form": {
        const target = logs[e.target]!;
        if (e.form !== "undynamax" && e.form !== "stance") (target.forms ??= []).push(e.form);
        hp[e.target] = e.hp;
        break;
      }
    }
  }
  const left: [number, number] = [0, 0];
  const total: [number, number] = [0, 0];
  result.initial.forEach((b, i) => {
    // A Dynamaxed or Mega-healed Pokémon counts at most its starting HP.
    left[b.side] += Math.max(0, Math.min(hp[i]!, b.maxHp));
    total[b.side] += b.maxHp;
  });
  const share = (s: Side) => Math.round((left[s] / Math.max(1, total[s])) * 1000) / 1000;
  return { ticks: result.ticks, winner: result.winner, hpLeft: [share(0), share(1)], battlers: logs };
}
