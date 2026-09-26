import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const PATHS = {
  root: path.resolve(here, "../../.."),
  get tools() {
    return path.join(this.root, "tools");
  },
  get pins() {
    return path.join(this.root, "tools/extract/pins.json");
  },
  get vendor() {
    return path.join(this.root, "vendor");
  },
  get dataPokerogue() {
    return path.join(this.root, "data/pokerogue");
  },
  get dataI18n() {
    return path.join(this.root, "data/i18n");
  },
  get rosterIds() {
    return path.join(this.root, "data/roster-ids.json");
  },
  get sourcesMd() {
    return path.join(this.root, "data/SOURCES.md");
  },
  get clientAssets() {
    return path.join(this.root, "apps/client/public/assets");
  },
};

export interface Pin {
  url: string;
  ref: string;
  commit: string;
}
export interface Pins {
  pokerogue: Pin;
  pokerogueLocales: Pin;
  pokerogueAssets: Pin;
  pokeapi: Pin;
  pokeapiSprites: Pin;
}

export function readPins(): Pins {
  return JSON.parse(fs.readFileSync(PATHS.pins, "utf8")) as Pins;
}

export function short(sha: string): string {
  return sha.slice(0, 12);
}

export function log(...args: unknown[]): void {
  console.log("[extract]", ...args);
}

/** Pretty JSON with a trailing newline. Key order is whatever the caller built (callers build deterministic orders). */
export function toJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Write a file only when its bytes differ. Returns true when the file changed. */
export function writeIfChanged(file: string, content: string | Buffer): boolean {
  const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  if (fs.existsSync(file)) {
    const old = fs.readFileSync(file);
    if (old.equals(buf)) return false;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return true;
}

export function writeJson(file: string, value: unknown): boolean {
  return writeIfChanged(file, toJson(value));
}

/** Byte-identical copy that leaves the destination untouched when it already matches. */
export function copyIfChanged(src: string, dest: string): boolean {
  return writeIfChanged(dest, fs.readFileSync(src));
}

export function sha1(buf: Buffer | string): string {
  return createHash("sha1").update(buf).digest("hex");
}

export function readJson<T = any>(file: string): T {
  let text = fs.readFileSync(file, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return JSON.parse(text) as T;
}

export function tryReadJson<T = any>(file: string): T | undefined {
  try {
    return readJson<T>(file);
  } catch {
    return undefined;
  }
}

/** Build an object from entries in the given order. */
export function fromEntries<V>(entries: Iterable<[string, V]>): Record<string, V> {
  const out: Record<string, V> = {};
  for (const [k, v] of entries) out[k] = v;
  return out;
}

export function sortedObject<V>(obj: Record<string, V>, cmp?: (a: string, b: string) => number): Record<string, V> {
  const keys = Object.keys(obj).sort(cmp ?? ((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  const out: Record<string, V> = {};
  for (const k of keys) out[k] = obj[k];
  return out;
}

export function codepointCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// #region PokéRogue string casing (ported verbatim from pokerogue src/utils/strings.ts so keys map identically)

const SPLIT_LOWER_UPPER_RE = /([\p{Ll}\d])(\p{Lu})/gu;
const SPLIT_UPPER_UPPER_RE = /(\p{Lu})([\p{Lu}][\p{Ll}])/gu;
const DELIM_STRIP_REGEXP = /[-_ ]+/giu;
const SPLIT_REPLACE_VALUE = "$1\0$2";

function trimFromStartAndEnd(str: string, charToTrim: string): string {
  let start = 0;
  let end = str.length;
  const blockLength = charToTrim.length;
  while (str.startsWith(charToTrim, start)) start += blockLength;
  if (start - end === blockLength) return "";
  while (str.endsWith(charToTrim, end)) end -= blockLength;
  return str.slice(start, end);
}

export function splitWords(value: string): string[] {
  let result = value.trim();
  result = result.replace(SPLIT_LOWER_UPPER_RE, SPLIT_REPLACE_VALUE).replace(SPLIT_UPPER_UPPER_RE, SPLIT_REPLACE_VALUE);
  result = result.replace(DELIM_STRIP_REGEXP, "\0");
  return trimFromStartAndEnd(result, "\0").split(/\0/g);
}

export function toCamelCase(str: string): string {
  return splitWords(str)
    .map((word, index) =>
      index === 0 ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
    )
    .join("");
}

export function toPascalCase(str: string): string {
  return splitWords(str)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join("");
}

// #endregion

/** camelCase / snake / kebab -> UPPER_SNAKE (used for locale keys that have no enum counterpart). */
export function toUpperSnake(str: string): string {
  return splitWords(str)
    .map(w => w.toUpperCase())
    .join("_");
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Minimal RFC4180 CSV parser (handles quotes, escaped quotes and embedded newlines). */
export function parseCsv(text: string): Record<string, string>[] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows;
  return body.map(r => {
    const o: Record<string, string> = {};
    header.forEach((h, i) => {
      o[h] = r[i] ?? "";
    });
    return o;
  });
}

export function listFilesRecursive(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out;
}

export function dirSize(dir: string): { files: number; bytes: number } {
  let bytes = 0;
  const files = listFilesRecursive(dir);
  for (const f of files) bytes += fs.statSync(f).size;
  return { files: files.length, bytes };
}

export function fmtBytes(n: number): string {
  if (n > 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MiB`;
  if (n > 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${n} B`;
}
