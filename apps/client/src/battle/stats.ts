import type { BattleResult } from "@pokebattles/game";

export interface BattlerStats {
  dealt: number;
  taken: number;
  healed: number;
  kos: number;
  /** Status conditions and stat drops inflicted on enemies. */
  support: number;
}

/** Per-battler contribution totals, derived from the event log. */
export function battleStats(result: BattleResult): BattlerStats[] {
  const side = new Map(result.initial.map((b) => [b.id, b.side]));
  const stats: BattlerStats[] = result.initial.map(() => ({ dealt: 0, taken: 0, healed: 0, kos: 0, support: 0 }));
  const lastHitter = new Map<number, number>();
  let lastMoveSrc: number | null = null;
  for (const e of result.events) {
    switch (e.k) {
      case "move":
        lastMoveSrc = e.src;
        break;
      case "damage":
        stats[e.target]!.taken += e.amount;
        if (e.src !== undefined && side.get(e.src) !== side.get(e.target)) {
          stats[e.src]!.dealt += e.amount;
          lastHitter.set(e.target, e.src);
        }
        break;
      case "heal":
        stats[e.target]!.healed += e.amount;
        break;
      case "status":
      case "confuse":
        if (lastMoveSrc !== null && side.get(lastMoveSrc) !== side.get(e.target)) stats[lastMoveSrc]!.support++;
        break;
      case "stage":
        if (e.delta < 0 && lastMoveSrc !== null && side.get(lastMoveSrc) !== side.get(e.target)) stats[lastMoveSrc]!.support++;
        break;
      case "faint": {
        const killer = lastHitter.get(e.target);
        if (killer !== undefined) stats[killer]!.kos++;
        break;
      }
    }
  }
  return stats;
}

export const TYPE_COLORS: Record<string, string> = {
  normal: "#a8a77a",
  fire: "#ee8130",
  water: "#6390f0",
  electric: "#f7d02c",
  grass: "#7ac74c",
  ice: "#96d9d6",
  fighting: "#c22e28",
  poison: "#a33ea1",
  ground: "#e2bf65",
  flying: "#a98ff3",
  psychic: "#f95587",
  bug: "#a6b91a",
  rock: "#b6a136",
  ghost: "#735797",
  dragon: "#6f35fc",
  dark: "#705746",
  steel: "#b7b7ce",
  fairy: "#d685ad",
};
