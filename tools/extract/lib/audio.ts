/**
 * PokéRogue audio the client plays (tools/extract/fetch-assets.ts copies the files byte-identically).
 * Keys are PokéRogue's own names: BGM as `audioManager.playBgm(name)` takes them, sounds as `playSound(key)`.
 */
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "./util.ts";

export const AUDIO_SE = [
  "ui/select",
  "ui/menu_open",
  "ui/error",
  "se/buy",
  "se/pb_rel",
  "se/pb_move",
  "se/pb_throw",
  "se/pb_lock",
  "se/hit",
  "se/hit_strong",
  "se/hit_weak",
  "se/faint",
  "se/stat_up",
  "se/stat_down",
  "se/restore",
  "se/shine",
  "se/sparkle",
  "se/charge",
  "se/beam",
  "se/level_up",
  "se/upgrade",
  "se/flee",
  "se/exp",
] as const;

export const AUDIO_BGM = [
  "title",
  "menu",
  "mystery_encounter_gen_5_gts",
  "mystery_encounter_gen_6_gts",
  "battle_kanto_champion",
  "battle_johto_champion",
  "battle_hoenn_champion_g6",
  "battle_sinnoh_champion",
  "battle_champion_alder",
  "battle_kalos_champion",
  "battle_champion_kukui",
  "battle_galar_champion",
  "battle_champion_geeta",
  "bw/victory_trainer",
  "bw/victory_champion",
] as const;

/** Fanfares that play once instead of looping. */
const PLAY_ONCE = new Set<string>(["bw/victory_trainer", "bw/victory_champion"]);

/** Repo path of a sound key (`se/buy` → `audio/se/buy.wav`). */
export const seRepoPath = (key: string) => `audio/${key}.wav`;
/** Repo path of a BGM name (`bw/victory_trainer` → `audio/bgm/bw/victory_trainer.mp3`). */
export const bgmRepoPath = (name: string) => `audio/bgm/${name}.mp3`;

export const AUDIO_MANAGER_SRC = "src/audio/audio-manager.ts";

/**
 * Loop points (seconds) from `getBgmLoopPoint` in PokéRogue's audio manager: the track restarts there
 * after its intro. Names the switch does not list loop from 0, as PokéRogue does.
 */
export function readBgmLoopPoints(): Record<string, number> {
  const src = fs.readFileSync(path.join(PATHS.vendor, "pokerogue", AUDIO_MANAGER_SRC), "utf8");
  const start = src.indexOf("getBgmLoopPoint(bgmName: string)");
  if (start < 0) throw new Error(`getBgmLoopPoint not found in vendor/pokerogue/${AUDIO_MANAGER_SRC}`);
  const body = src.slice(start);
  const end = body.indexOf("\n  }\n");
  const out: Record<string, number> = {};
  // Consecutive `case` labels share the next `return`.
  let pending: string[] = [];
  for (const line of (end > 0 ? body.slice(0, end) : body).split("\n")) {
    const c = /^\s*case\s+"([^"]+)"\s*:/.exec(line);
    if (c) pending.push(c[1]!);
    const r = /^\s*return\s+([\d.]+)\s*;/.exec(line);
    if (r && pending.length) {
      for (const name of pending) out[name] = Number(r[1]);
      pending = [];
    }
  }
  if (Object.keys(out).length < 10) throw new Error("getBgmLoopPoint: too few loop points parsed; did the source change?");
  return out;
}

export function bgmLoop(name: string, loops: Record<string, number>): number | null {
  return PLAY_ONCE.has(name) ? null : (loops[name] ?? 0);
}

/** Seconds of PCM audio in a RIFF/WAVE file, from its fmt and data chunks (any chunk order or header size). */
export function wavDuration(buf: Buffer): number {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a RIFF/WAVE file");
  let byteRate = 0;
  let dataBytes = -1;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") byteRate = buf.readUInt32LE(off + 8 + 8);
    else if (id === "data") dataBytes = Math.min(size, buf.length - off - 8);
    off += 8 + size + (size % 2);
  }
  if (!byteRate || dataBytes < 0) throw new Error("WAVE without fmt or data chunk");
  return Math.round((dataBytes / byteRate) * 1000) / 1000;
}

export interface ReuseAnnotation {
  paths: string[];
  copyright: string;
  license: string;
}

/** `[[annotations]]` blocks of a REUSE.toml (only the keys we need; paths relative to that file's directory). */
export function parseReuseToml(text: string): ReuseAnnotation[] {
  const out: ReuseAnnotation[] = [];
  for (const block of text.split(/^\[\[annotations\]\]/m).slice(1)) {
    const pathsMatch = /path\s*=\s*(\[[\s\S]*?\]|"[^"]*")/.exec(block);
    const paths = pathsMatch ? [...pathsMatch[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!) : [];
    const copyright = /SPDX-FileCopyrightText\s*=\s*"([^"]*)"/.exec(block)?.[1] ?? "";
    const license = /SPDX-License-Identifier\s*=\s*"([^"]*)"/.exec(block)?.[1] ?? "";
    out.push({ paths, copyright, license });
  }
  return out;
}

function globToRegExp(glob: string): RegExp {
  const re = glob
    .split("")
    .map((ch) => (ch === "*" ? "[^/]*" : /[.+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch))
    .join("");
  return new RegExp(`^${re}$`);
}

/** The annotation that applies to `rel` (REUSE: the last matching one in the file wins). */
export function reuseFor(annotations: ReuseAnnotation[], rel: string): ReuseAnnotation | null {
  let hit: ReuseAnnotation | null = null;
  for (const a of annotations) if (a.paths.some((p) => globToRegExp(p).test(rel))) hit = a;
  return hit;
}

/**
 * The first `<level × #> <title>` section of PokéRogue's CREDITS.md without its heading, up to the
 * next heading of the same or a higher level.
 */
export function creditsSection(title: string, level = 2): string {
  const md = fs.readFileSync(path.join(PATHS.vendor, "pokerogue", "CREDITS.md"), "utf8");
  const lines = md.split(/\r?\n/);
  const hashes = "#".repeat(level);
  const start = lines.findIndex((l) => l.trim() === `${hashes} ${title}`);
  if (start < 0) throw new Error(`CREDITS.md has no "${hashes} ${title}" section`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => new RegExp(`^#{1,${level}}\\s`).test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
}

/** What SOURCES.md says about the copied audio. */
export interface AudioSourceInfo {
  /** Repo path (audio/…) → license / copyright holder from the assets repo's audio/REUSE.toml. */
  files: { repoPath: string; license: string; copyright: string }[];
  composers: string;
  bgmCredits: string;
  seCredits: string;
}
