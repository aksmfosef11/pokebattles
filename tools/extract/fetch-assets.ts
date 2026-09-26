/**
 * `pnpm --filter @pokebattles/tools sprites` — copies PokéRogue sprites/atlases (byte-identical) for the roster into
 * apps/client/public/assets/, plus PokeAPI/sprites item icons PokéRogue lacks. Needs data/pokerogue/*.json (`pnpm extract`).
 */
import fs from "node:fs";
import path from "node:path";
import {
  AUDIO_BGM,
  AUDIO_MANAGER_SRC,
  AUDIO_SE,
  type AudioSourceInfo,
  bgmLoop,
  bgmRepoPath,
  creditsSection,
  parseReuseToml,
  readBgmLoopPoints,
  reuseFor,
  seRepoPath,
  wavDuration,
} from "./lib/audio.ts";
import type { ItemCatalogEntry } from "./lib/items.ts";
import type { SpeciesOut } from "./lib/pokerogue.ts";
import { assetsRepo, pokeapiSpritesRepo, type VendorRepo } from "./lib/sources.ts";
import { writeSourcesMd } from "./lib/sources-md.ts";
import { copyIfChanged, fmtBytes, fromEntries, listFilesRecursive, log, PATHS, readJson, readPins, writeJson } from "./lib/util.ts";

const ARENAS = ["plains", "forest", "beach", "sea", "cave", "desert", "volcano", "ice_cave", "mountain", "graveyard", "power_plant", "space"];
const KINDS = [
  { kind: "front", dir: "front", manifestKey: "front" },
  { kind: "back", dir: "back", manifestKey: "back" },
  { kind: "frontShiny", dir: "front-shiny", manifestKey: "frontShiny" },
  { kind: "backShiny", dir: "back-shiny", manifestKey: "backShiny" },
] as const;

interface CopyJob {
  repo: VendorRepo;
  src: string; // repo-relative
  dest: string; // assets-relative
}

async function main() {
  const pins = readPins();
  const roster = readJson<{ species: number[]; trainers: string[] }>(PATHS.rosterIds);
  const speciesFile = path.join(PATHS.dataPokerogue, "species.json");
  if (!fs.existsSync(speciesFile)) throw new Error("data/pokerogue/species.json missing - run `pnpm extract` first");
  const species = readJson<SpeciesOut[]>(speciesFile);
  const catalog = readJson<Record<string, ItemCatalogEntry>>(path.join(PATHS.dataPokerogue, "items.json"));

  const assets = assetsRepo();
  log("listing pokerogue-assets tree");
  const tree = new Set(assets.lsTree(["images/"]));
  const has = (p: string) => tree.has(p);
  const hasAtlas = (base: string) => has(`${base}.png`) && has(`${base}.json`);
  const atlasFrameCount = (base: string): number => {
    const json = JSON.parse(assets.readText(`${base}.json`));
    const frames = json.textures?.[0]?.frames ?? json.frames ?? [];
    return Array.isArray(frames) ? frames.length : Object.keys(frames).length;
  };

  const jobs: CopyJob[] = [];
  const addAtlas = (repo: VendorRepo, srcBase: string, destBase: string) => {
    jobs.push({ repo, src: `${srcBase}.png`, dest: `${destBase}.png` }, { repo, src: `${srcBase}.json`, dest: `${destBase}.json` });
  };

  // variant masterlist decides which file PokéRogue uses for the standard (tier-0) shiny
  const masterPath = "images/pokemon/variant/_masterlist.json";
  const masterlist = JSON.parse(assets.readText(masterPath)) as Record<string, any>;
  // With experimental sprites on, PokéRogue overwrites masterlist entries that already exist (deepMergeSpriteData).
  const expMasterlist = JSON.parse(assets.readText("images/pokemon/variant/_exp_masterlist.json")) as Record<string, any>;
  const variantSet = (fb: string, back: boolean, exp: boolean): unknown => {
    const base = back ? masterlist.back?.[fb] : masterlist[fb];
    const ex = back ? expMasterlist.back?.[fb] : expMasterlist[fb];
    return exp && Array.isArray(base) && Array.isArray(ex) ? ex : base;
  };

  /**
   * PokéRogue's sprite file for one kind of one form, as its "Mixed Animated" sprite set picks it
   * (`exp` = the animated images/pokemon/exp/ tree). Null when that tree has no atlas for it.
   */
  const pickSprite = (fb: string, back: boolean, shiny: boolean, exp: boolean): { srcBase: string | null; note?: string } => {
    const x = exp ? "exp/" : "";
    const dir = `images/pokemon/${x}${back ? "back/" : ""}`;
    if (!shiny) return { srcBase: hasAtlas(`${dir}${fb}`) ? `${dir}${fb}` : null };
    const vset = variantSet(fb, back, exp);
    const v0 = Array.isArray(vset) ? vset[0] : 0;
    const variantFile = `images/pokemon/variant/${x}${back ? "back/" : ""}${fb}_1`;
    if (v0 === 2 && hasAtlas(variantFile)) return { srcBase: variantFile };
    const recolor = `variant/${x}${back ? "back/" : ""}${fb}.json`;
    if (hasAtlas(`${dir}shiny/${fb}`)) {
      const note = v0 === 1 ? `PokéRogue recolors the base sprite with ${recolor} (masterlist v0=1); copied ${x}shiny/ file instead` : undefined;
      return { srcBase: `${dir}shiny/${fb}`, note };
    }
    return { srcBase: null, note: v0 === 1 ? `palette-only shiny (${recolor}), no standalone atlas` : undefined };
  };

  // --- Pokémon sprites
  const report: Record<string, any> = { missingSpriteKinds: [] as string[], shinyNotes: [] as string[], animatedExpSprites: 0, staticSprites: [] as string[] };
  const manifest: Record<string, { id: number; forms: Record<string, Record<string, string | null>> }> = {};
  // Roster ids are PokéRogue species ids: national dex numbers, or 2000+ for regional forms.
  const byId = new Map(species.map(s => [s.id, s]));
  const missingIds: number[] = [];
  for (const id of roster.species) {
    const sp = byId.get(id);
    if (!sp) {
      missingIds.push(id);
      continue;
    }
    const forms = sp.forms.length ? sp.forms : [{ formKey: "", formSpriteKey: "" }];
    const entry: Record<string, Record<string, string | null>> = {};
    const seenSprite = new Set<string>();
    for (const f of forms) {
      const fb = `${id}${f.formSpriteKey ? `-${f.formSpriteKey}` : ""}`;
      if (!hasAtlas(`images/pokemon/${fb}`)) continue; // form has no battle sprite
      const out: Record<string, string | null> = {};
      for (const k of KINDS) {
        const back = k.kind.startsWith("back");
        const shiny = k.kind.endsWith("Shiny");
        // Most gen 6+ standard atlases are a single still frame; the exp/ tree has their animated versions.
        const exp = pickSprite(fb, back, shiny, true);
        const pick = exp.srcBase ? exp : pickSprite(fb, back, shiny, false);
        const srcBase = pick.srcBase;
        if (pick.note) report.shinyNotes.push(`${fb} ${k.kind}: ${pick.note}`);
        if (exp.srcBase) report.animatedExpSprites++;
        else if (k.kind === "front" && srcBase && atlasFrameCount(srcBase) < 2) report.staticSprites.push(fb);
        if (srcBase && hasAtlas(srcBase)) {
          const fileName = path.posix.basename(srcBase);
          const destBase = `pokemon/${k.dir}/${fileName}`;
          if (!seenSprite.has(`${k.dir}/${fileName}`)) addAtlas(assets, srcBase, destBase);
          seenSprite.add(`${k.dir}/${fileName}`);
          out[k.manifestKey] = destBase;
        } else {
          out[k.manifestKey] = null;
          report.missingSpriteKinds.push(`${sp.key}:${f.formKey} (${fb}) ${k.kind}`);
        }
      }
      entry[f.formKey] = out;
    }
    if (!Object.keys(entry).length) report.missingSpriteKinds.push(`${sp.key}: no battle sprite for any form`);
    manifest[sp.key] = { id, forms: entry };
  }
  if (missingIds.length) report.rosterIdsWithoutSpecies = missingIds;

  // --- items atlas + manifest
  if (!hasAtlas("images/items")) throw new Error("images/items atlas not found in pokerogue-assets");
  addAtlas(assets, "images/items", "items");
  const itemsAtlas = JSON.parse(assets.readText("images/items.json"));
  const frames = new Set<string>(
    itemsAtlas.textures ? itemsAtlas.textures.flatMap((t: any) => t.frames.map((f: any) => f.filename)) : Object.keys(itemsAtlas.frames ?? {}),
  );
  const neededItems = Object.entries(catalog)
    .filter(([k, c]) => c.required || c.group === "teraShard")
    .map(([k]) => k);
  const itemsManifest: Record<string, { atlas: string; frame: string } | { file: string } | null> = {};
  const extraNeeded: { key: string; ident: string }[] = [];
  for (const key of neededItems) {
    const c = catalog[key];
    if (c.atlasFrame && frames.has(c.atlasFrame)) itemsManifest[key] = { atlas: "items", frame: c.atlasFrame };
    else if (c.pokeapiIdentifier) extraNeeded.push({ key, ident: c.pokeapiIdentifier });
    else itemsManifest[key] = null;
  }
  const extraSources: Record<string, string> = {};
  if (extraNeeded.length) {
    const spr = pokeapiSpritesRepo();
    log("listing PokeAPI/sprites item icons");
    const dirs = ["sprites/items/", "sprites/items/gen9/", "sprites/items/gen8/"];
    const sprTree = new Set<string>();
    for (const d of dirs) {
      const out = spr.lsTree([d]);
      for (const p of out) sprTree.add(p);
    }
    const chosen: { key: string; src: string }[] = [];
    for (const { key, ident } of extraNeeded) {
      const src = dirs.map(d => `${d}${ident}.png`).find(p => sprTree.has(p));
      if (src) chosen.push({ key, src });
      else itemsManifest[key] = null;
    }
    spr.setSparse(chosen.map(c => `/${c.src}`));
    for (const c of chosen) {
      jobs.push({ repo: spr, src: c.src, dest: `items-extra/${c.key}.png` });
      itemsManifest[c.key] = { file: `items-extra/${c.key}.png` };
      extraSources[c.key] = `PokeAPI/sprites@${pins.pokeapiSprites.commit}:${c.src}`;
    }
  }
  const sortedItemsManifest = fromEntries(neededItems.map(k => [k, itemsManifest[k] ?? null]));

  // --- type icons (all language variants)
  const typeFiles = [...tree].filter(p => /^images\/types[^/]*\.(png|json)$/.test(p)).sort();
  for (const p of typeFiles) jobs.push({ repo: assets, src: p, dest: `types/${path.posix.basename(p)}` });

  // --- champion trainers (sprite key = TrainerType name lowercased; LANCE_CHAMPION derives to LANCE)
  const trainerManifest: Record<string, { source: string } | null> = {};
  for (const game of roster.trainers) {
    const cand = [`images/trainer/${game}`, `images/trainer/${game}_m`, `images/trainer/${game}_f`, `images/trainer/${game}_champion`];
    const src = cand.find(hasAtlas);
    if (src) {
      addAtlas(assets, src, `trainers/${game}`);
      trainerManifest[game] = { source: `${src}.png|json` };
    } else {
      trainerManifest[game] = null;
      (report.missingTrainers ??= []).push(game);
    }
  }

  // --- arenas
  // PokéRogue's *_bg.png is only the sky gradient; the detail is in the *_a (player platform) / *_b (enemy platform) layers.
  const arenaManifest: Record<string, Record<string, string>> = {};
  for (const a of ARENAS) {
    if (!has(`images/arenas/${a}_bg.png`)) {
      (report.missingArenas ??= []).push(a);
      continue;
    }
    arenaManifest[a] = {};
    for (const layer of ["bg", "a", "b"]) {
      const p = `images/arenas/${a}_${layer}.png`;
      if (!has(p)) continue;
      jobs.push({ repo: assets, src: p, dest: `arenas/${a}_${layer}.png` });
      arenaManifest[a][layer] = `arenas/${a}_${layer}.png`;
    }
  }

  // --- audio: PokéRogue's sounds and music, keyed by its own playSound / playBgm names
  const audioTree = new Set(assets.lsTree(["audio/bgm/", "audio/se/", "audio/ui/"]));
  const loopPoints = readBgmLoopPoints();
  const audioReuse = parseReuseToml(assets.readText("audio/REUSE.toml"));
  const audioSe: { key: string; file: string }[] = [];
  const audioBgm: { name: string; file: string }[] = [];
  const audioLicenses: AudioSourceInfo["files"] = [];
  const addAudio = (src: string): boolean => {
    if (!audioTree.has(src)) {
      (report.missingAudio ??= []).push(src);
      return false;
    }
    jobs.push({ repo: assets, src, dest: src });
    const lic = reuseFor(audioReuse, src.slice("audio/".length));
    audioLicenses.push({ repoPath: src, license: lic?.license ?? "?", copyright: lic?.copyright ?? "?" });
    return true;
  };
  for (const key of AUDIO_SE) if (addAudio(seRepoPath(key))) audioSe.push({ key, file: seRepoPath(key) });
  for (const name of AUDIO_BGM) if (addAudio(bgmRepoPath(name))) audioBgm.push({ name, file: bgmRepoPath(name) });

  // --- materialize + copy
  const assetJobs = jobs.filter(j => j.repo === assets);
  log(`materializing ${assetJobs.length} files from pokerogue-assets`);
  assets.setSparse(assetJobs.map(j => `/${j.src}`));
  const root = PATHS.clientAssets;
  let changed = 0;
  const produced = new Set<string>();
  for (const j of jobs) {
    const src = j.repo.file(j.src);
    if (!fs.existsSync(src)) throw new Error(`not materialized: ${j.repo.name}/${j.src}`);
    if (copyIfChanged(src, path.join(root, j.dest))) changed++;
    produced.add(j.dest);
  }

  const pokemonManifest = fromEntries(Object.entries(manifest));
  const writeManaged = (rel: string, value: unknown) => {
    if (writeJson(path.join(root, rel), value)) changed++;
    produced.add(rel);
  };
  writeManaged("pokemon/manifest.json", pokemonManifest);
  writeManaged("items-manifest.json", sortedItemsManifest);
  writeManaged("trainers/manifest.json", trainerManifest);
  const audioSources: AudioSourceInfo = {
    files: audioLicenses,
    composers: [creditsSection("Head Composer"), creditsSection("Composers", 3)].join("\n"),
    bgmCredits: creditsSection("BGM"),
    seCredits: creditsSection("Sound Effects"),
  };
  const audioManifest = {
    bgm: fromEntries(audioBgm.map(b => [b.name, { file: b.file, loop: bgmLoop(b.name, loopPoints) }])),
    se: fromEntries(audioSe.map(s => [s.key, { file: s.file, duration: wavDuration(fs.readFileSync(path.join(root, s.file))) }])),
  };
  writeManaged("audio/manifest.json", audioManifest);

  // prune stale files we own
  let pruned = 0;
  for (const f of listFilesRecursive(root)) {
    const rel = path.relative(root, f).replace(/\\/g, "/");
    if (rel === "assets-manifest.json") continue;
    if (!produced.has(rel)) {
      fs.rmSync(f);
      pruned++;
    }
  }

  // size summary (deterministic)
  const sizes: Record<string, { files: number; bytes: number }> = {};
  let total = 0;
  for (const rel of [...produced].sort()) {
    const top = rel.includes("/") ? rel.split("/").slice(0, rel.startsWith("pokemon/") || rel.startsWith("audio/") ? 2 : 1).join("/") : rel;
    const b = fs.statSync(path.join(root, rel)).size;
    sizes[top] ??= { files: 0, bytes: 0 };
    sizes[top].files++;
    sizes[top].bytes += b;
    total += b;
  }
  const formsWithSprites = Object.values(manifest).reduce((n, m) => n + Object.keys(m.forms).length, 0);
  writeManaged("assets-manifest.json", {
    sources: {
      pokerogueAssets: pins.pokerogueAssets,
      pokeapiSprites: pins.pokeapiSprites,
    },
    notes: {
      pokemon: "pokemon/manifest.json paths are relative to this assets/ directory and have no extension: append .png (texture) / .json (TexturePacker atlas). Files are byte-identical copies using PokéRogue's own names (e.g. 6-mega-x). Like PokéRogue's 'Mixed Animated' sprite set, the animated images/pokemon/exp/ atlas is copied when one exists; report.staticSprites lists fronts that are a single still frame.",
      items: "items-manifest.json: { atlas: 'items', frame } refers to items.png/items.json; { file } is a standalone PNG from PokeAPI/sprites; null = no icon in either source.",
      audio: "audio/manifest.json: bgm[name] = { file, loop } with PokéRogue's playBgm names (loop = loop-point seconds from its getBgmLoopPoint, 0 = whole track, null = play once); se[key] = { file, duration } with its playSound keys (se/…, ui/…). Files keep PokéRogue's paths below audio/.",
      teraShards: "PokéRogue has per-type icons (<type>_tera_shard frames) and a templated name '{{teraType}} Tera Shard' (see i18n itemTemplates.TERA_SHARD); there is no generic TERA_SHARD icon or name.",
    },
    counts: { rosterSpecies: Object.keys(manifest).length, formsWithSprites, files: produced.size + 1 },
    bytes: { total, byDir: sizes },
    itemsExtraSources: extraSources,
    arenas: arenaManifest,
    audio: {
      manifest: "audio/manifest.json",
      loopPointsFrom: `pokerogue@${pins.pokerogue.commit}:${AUDIO_MANAGER_SRC} getBgmLoopPoint`,
      bytes: fromEntries(
        [...audioSe.map(s => s.file), ...audioBgm.map(b => b.file)].sort().map(f => [f, fs.statSync(path.join(root, f)).size]),
      ),
      sources: audioSources,
      totalBytes: [...produced].filter(r => r.startsWith("audio/")).reduce((n, r) => n + fs.statSync(path.join(root, r)).size, 0),
    },
    report,
  });
  writeSourcesMd(pins, audioSources);

  log(`${produced.size} files (${fmtBytes(total)}), ${changed} changed, ${pruned} pruned`);
  log(`animated exp/ sprites: ${report.animatedExpSprites}; still fronts: ${report.staticSprites.length}`);
  log(`audio: ${audioSe.length} sounds, ${audioBgm.length} tracks (${fmtBytes(sizes["audio/bgm"]?.bytes ?? 0)} music); missing: ${(report.missingAudio ?? []).join(", ") || "none"}`);
  log(`missing sprite kinds: ${report.missingSpriteKinds.length}; missing trainers: ${(report.missingTrainers ?? []).length}; items without icon: ${Object.entries(sortedItemsManifest).filter(([, v]) => v === null).map(([k]) => k).join(", ") || "none"}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
