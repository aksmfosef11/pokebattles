/**
 * Looks bought with points (docs/DESIGN.md §8): shiny looks per evolution line, a home arena and a
 * starter nickname. Display only: the battle never reads them, so they cannot change a result.
 */
import { CONTENT } from "../content/index.ts";
import { rngFor } from "../rng.ts";
import { lineBase } from "../run/pool.ts";
import type { TeamSnapshot } from "../run/types.ts";

/** Battle backgrounds (PokéRogue arenas, `assets/arenas/<key>_bg.png`). */
export const ARENAS = ["plains", "forest", "beach", "cave", "desert", "mountain", "volcano", "ice_cave", "graveyard", "power_plant", "sea", "space"] as const;
export type Arena = (typeof ARENAS)[number];

export function isArena(key: unknown): key is Arena {
  return typeof key === "string" && (ARENAS as readonly string[]).includes(key);
}

/**
 * A battle's background: the player's home arena on odd rounds and the opponent's on even rounds
 * (whichever side has one if only one does), otherwise a random arena from the battle seed.
 */
export function battleArena(seed: string, teams: readonly [TeamSnapshot, TeamSnapshot]): Arena {
  const home = teams[0].cosmetics?.arena;
  const away = teams[1].cosmetics?.arena;
  const pick = teams[0].round % 2 === 1 ? (home ?? away) : (away ?? home);
  if (isArena(pick)) return pick;
  return ARENAS[rngFor(seed, "arena").int(0, ARENAS.length - 1)]!;
}

/** Drawn shiny: a real (rolled) shiny, or a Pokémon of a line its owner has a shiny look for. */
export function looksShiny(shinyLines: readonly string[] | undefined, species: string, shiny: boolean): boolean {
  if (shiny) return true;
  if (!shinyLines?.length || !CONTENT.species[species]) return false;
  return shinyLines.includes(lineBase(species));
}

export const NICKNAME_MAX = 12;

/** A starter nickname as stored and shown: no control characters, trimmed, at most NICKNAME_MAX characters. */
export function cleanNickname(input: unknown): string {
  const s = typeof input === "string" ? input.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, "").trim() : "";
  return [...s].slice(0, NICKNAME_MAX).join("").trim();
}
