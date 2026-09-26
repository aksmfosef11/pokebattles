import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { log, PATHS, type Pin, parseCsv, readPins, short } from "./util.ts";

function git(cwd: string, args: string[], opts: { buffer?: boolean; quiet?: boolean } = {}): string {
  const out = execFileSync("git", args, {
    cwd,
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["ignore", "pipe", opts.quiet ? "ignore" : "inherit"],
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return out;
}

function gitOk(cwd: string, args: string[]): boolean {
  try {
    execFileSync("git", args, { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export interface RepoOptions {
  /** Directory name under vendor/ */
  name: string;
  pin: Pin;
  /** Partial-clone filter; omit for a full (shallow) fetch. */
  filter?: "blob:none" | "tree:0";
  /**
   * Non-cone sparse-checkout patterns to materialize. `null` = do not check anything out
   * (objects are read with ls-tree / cat-file instead).
   */
  sparse: string[] | null;
}

export class VendorRepo {
  readonly dir: string;
  constructor(
    readonly name: string,
    readonly pin: Pin,
  ) {
    this.dir = path.join(PATHS.vendor, name);
  }

  get commit(): string {
    return this.pin.commit;
  }

  /** Path of a checked-out file (only valid for materialized paths). */
  file(rel: string): string {
    return path.join(this.dir, rel);
  }

  /** List every path of the pinned tree (optionally below `prefix`). Needs trees only, never blobs. */
  lsTree(prefixes: string[] = []): string[] {
    const out = git(this.dir, ["ls-tree", "-r", "--name-only", this.commit, "--", ...prefixes], { quiet: true });
    return out.split("\n").filter(Boolean);
  }

  /** Read one file of the pinned tree from the object store (lazily fetches that blob in partial clones). */
  readText(rel: string): string {
    return git(this.dir, ["cat-file", "blob", `${this.commit}:${rel}`], { quiet: true });
  }

  /** Change the materialized set of paths; git batch-fetches any missing blobs. */
  setSparse(patterns: string[]): void {
    const infoDir = path.join(this.dir, ".git", "info");
    fs.mkdirSync(infoDir, { recursive: true });
    const file = path.join(infoDir, "sparse-checkout");
    const body = `${[...new Set(patterns)].sort().join("\n")}\n`;
    const old = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    const head = gitOk(this.dir, ["rev-parse", "-q", "--verify", "HEAD"])
      ? git(this.dir, ["rev-parse", "HEAD"], { quiet: true }).trim()
      : null;
    if (old === body && head === this.commit) return;
    fs.writeFileSync(file, body);
    if (head !== this.commit) {
      git(this.dir, ["-c", "advice.detachedHead=false", "checkout", "-q", "-f", "--detach", this.commit]);
    } else {
      git(this.dir, ["read-tree", "--reset", "-u", "HEAD"]);
    }
  }
}

/** Clone/fetch a repo at its pinned commit (idempotent; no network when already present). */
export function ensureRepo(opts: RepoOptions): VendorRepo {
  const repo = new VendorRepo(opts.name, opts.pin);
  const dir = repo.dir;
  if (!fs.existsSync(path.join(dir, ".git"))) {
    fs.mkdirSync(dir, { recursive: true });
    git(dir, ["init", "-q"]);
    git(dir, ["remote", "add", "origin", opts.pin.url]);
  }
  // Byte-exact checkouts on Windows (system git often has autocrlf=true).
  git(dir, ["config", "core.autocrlf", "false"]);
  git(dir, ["config", "core.eol", "lf"]);
  git(dir, ["config", "core.sparseCheckout", "true"]);
  git(dir, ["config", "core.sparseCheckoutCone", "false"]);
  if (!gitOk(dir, ["cat-file", "-e", `${opts.pin.commit}^{commit}`])) {
    log(`fetching ${opts.name}@${short(opts.pin.commit)} (${opts.filter ?? "full"}, depth 1)`);
    const args = ["fetch", "-q", "--depth", "1"];
    if (opts.filter) args.push(`--filter=${opts.filter}`);
    args.push("origin", opts.pin.commit);
    git(dir, args);
  }
  if (opts.sparse) repo.setSparse(opts.sparse);
  return repo;
}

export function pokerogueRepo(): VendorRepo {
  const pins = readPins();
  return ensureRepo({
    name: "pokerogue",
    pin: pins.pokerogue,
    filter: "blob:none",
    sparse: ["/src/", "/LICENSE", "/LICENSES/", "/REUSE.toml", "/README.md", "/CREDITS.md", "/.gitmodules"],
  });
}

export function localesRepo(): VendorRepo {
  const pins = readPins();
  return ensureRepo({ name: "pokerogue-locales", pin: pins.pokerogueLocales, sparse: ["/*"] });
}

export function assetsRepo(): VendorRepo {
  const pins = readPins();
  // Blobless: trees only; files are materialized on demand via setSparse().
  return ensureRepo({ name: "pokerogue-assets", pin: pins.pokerogueAssets, filter: "blob:none", sparse: null });
}

export function pokeapiSpritesRepo(): VendorRepo {
  const pins = readPins();
  // Treeless: even the tree listing is fetched lazily, only for the directories we look at.
  return ensureRepo({ name: "pokeapi-sprites", pin: pins.pokeapiSprites, filter: "tree:0", sparse: null });
}

// #region PokeAPI CSVs (individual raw files at the pinned commit, cached under vendor/pokeapi-csv/<sha>/)

const csvCache = new Map<string, Record<string, string>[]>();

export async function pokeapiCsv(name: string): Promise<Record<string, string>[]> {
  const cached = csvCache.get(name);
  if (cached) return cached;
  const { pokeapi } = readPins();
  const dir = path.join(PATHS.vendor, "pokeapi-csv", pokeapi.commit);
  const file = path.join(dir, `${name}.csv`);
  if (!fs.existsSync(file)) {
    const url = `https://raw.githubusercontent.com/PokeAPI/pokeapi/${pokeapi.commit}/data/v2/csv/${name}.csv`;
    log(`downloading ${url}`);
    let lastErr: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
        const buf = Buffer.from(await res.arrayBuffer());
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(`${file}.tmp`, buf);
        fs.renameSync(`${file}.tmp`, file);
        lastErr = undefined;
        break;
      } catch (e) {
        lastErr = e;
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    if (lastErr) throw lastErr;
  }
  const rows = parseCsv(fs.readFileSync(file, "utf8"));
  csvCache.set(name, rows);
  return rows;
}

// #endregion
