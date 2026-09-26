/**
 * `pnpm extract` — PokéRogue data + localization extraction.
 *
 * Reads PokéRogue's TypeScript source (AST only, never executed), its locales, and supplemental PokeAPI CSVs,
 * all at the commits pinned in tools/extract/pins.json, and writes deterministic JSON to data/pokerogue/ and data/i18n/.
 */
import fs from "node:fs";
import path from "node:path";
import { buildI18n } from "./lib/i18n.ts";
import {
  type AbilityOut,
  buildLearnsets,
  buildTms,
  createContext,
  extractAbilities,
  extractEggMoves,
  extractMoves,
  extractSpecies,
  extractTmTiers,
  extractTypeChart,
  type MoveOut,
} from "./lib/pokerogue.ts";
import { localesRepo, pokerogueRepo } from "./lib/sources.ts";
import { writeSourcesMd } from "./lib/sources-md.ts";
import { fromEntries, log, PATHS, readJson, readPins, toJson, tryReadJson, writeIfChanged, writeJson } from "./lib/util.ts";

async function main() {
  const pins = readPins();
  const pr = pokerogueRepo();
  const loc = localesRepo();
  const ctx = createContext(pr.dir);
  const out = PATHS.dataPokerogue;
  const changed: string[] = [];
  const put = (name: string, value: unknown) => {
    if (writeJson(path.join(out, name), value)) changed.push(name);
  };

  log("parsing moves");
  const { moves, gmax, flagOrder } = extractMoves(ctx);
  log("parsing abilities");
  const abilities = extractAbilities(ctx);
  log("parsing species");
  const recs = extractSpecies(ctx);
  const learnsets = buildLearnsets(recs);
  const tmTiers = extractTmTiers(ctx);
  const tms = buildTms(
    recs,
    moves.map(m => m.key),
  );
  const eggMoves = extractEggMoves(ctx);
  const typeChart = extractTypeChart(ctx);

  put("species.json", recs.map(r => r.species));
  put("moves.json", moves);
  put("abilities.json", abilities);
  put("learnsets.json", learnsets);
  put("tms.json", tms.byMove);
  put("tm-tiers.json", tmTiers);
  put("egg-moves.json", eggMoves);
  put("evolutions.json", fromEntries(recs.filter(r => r.evolutions.length).map(r => [r.species.key, r.evolutions])));
  put("form-changes.json", fromEntries(recs.filter(r => r.formChanges.length).map(r => [r.species.key, r.formChanges])));
  put("type-chart.json", typeChart);

  log("building localization");
  const roster = readJson<{ species: number[]; trainers: string[] }>(PATHS.rosterIds);
  const i18n = await buildI18n({
    ctx,
    localesDir: loc.dir,
    pins,
    species: recs,
    moves,
    gmax,
    abilities,
    rosterIds: roster.species,
    rosterTrainers: roster.trainers,
  });
  put(
    "gmax-moves.json",
    gmax.map(g => ({ ...g, gigantamax: i18n.gmaxSpecies[g.key] ?? null })),
  );
  put("items.json", i18n.itemCatalog);
  for (const [lang, data] of Object.entries(i18n.files)) {
    if (writeJson(path.join(PATHS.dataI18n, `${lang}.json`), data)) changed.push(`i18n/${lang}.json`);
  }

  // --- report
  const histogram = (list: { attrs: { name: string; implicit?: true }[]; unused?: true }[]) => {
    const h = new Map<string, number>();
    for (const x of list) for (const a of x.attrs) if (!a.implicit) h.set(a.name, (h.get(a.name) ?? 0) + 1);
    return fromEntries([...h.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)));
  };
  const usedMoves = moves.filter(m => !m.unused);
  const report = {
    counts: {
      species: recs.length,
      forms: recs.reduce((n, r) => n + r.species.forms.length, 0),
      moves: moves.length,
      movesUnused: moves.length - usedMoves.length,
      gmaxMoves: gmax.length,
      abilities: abilities.length,
      learnsetEntries: Object.keys(learnsets).length,
      tmMoves: Object.keys(tms.byMove).length,
      tmTiers: Object.keys(tmTiers).length,
      eggMoveSpecies: Object.keys(eggMoves).length,
      evolutions: recs.reduce((n, r) => n + r.evolutions.length, 0),
      formChanges: recs.reduce((n, r) => n + r.formChanges.length, 0),
      i18nLanguages: Object.keys(i18n.files).length,
      itemCatalog: Object.keys(i18n.itemCatalog).length,
    },
    unparseable: ctx.report.unparseable,
    warnings: ctx.report.warnings,
    notes: ctx.report.notes,
    unknownBuilderCalls: {
      moves: fromEntries([...ctx.report.unknownMoveCalls.entries()].sort()),
      abilities: fromEntries([...ctx.report.unknownAbilityCalls.entries()].sort()),
    },
    moveFlagOrder: flagOrder,
    tmFormExceptions: tms.formOnlyExceptions,
    attrHistogram: {
      movesNote: "occurrences of explicit .attr()/.addAttr() across moves not marked unused; implicit attrs (e.g. HealStatusEffectAttr on every Fire AttackMove) excluded",
      moves: histogram(usedMoves),
      movesChargeAttrs: histogram(usedMoves.map(m => ({ attrs: m.chargeAttrs ?? [] }))),
      abilities: histogram(abilities.filter(a => !a.unused)),
      implicitMoveAttrs: histogram(usedMoves.map(m => ({ attrs: m.attrs.filter(a => a.implicit).map(a => ({ name: a.name })) }))),
    },
    i18n: i18n.report,
  };
  put("extract-report.json", report);

  // --- meta (extractedAt only changes when some output changed, so reruns are byte-identical)
  const metaFile = path.join(out, "meta.json");
  const prevMeta = tryReadJson<{ extractedAt?: string }>(metaFile);
  const metaBody = {
    sources: {
      pokerogue: pins.pokerogue,
      pokerogueLocales: pins.pokerogueLocales,
      pokeapi: pins.pokeapi,
    },
    counts: report.counts,
    conventions: {
      keys: "Species/moves/abilities/items keyed by PokéRogue enum member names (SpeciesId/MoveId/AbilityId/...).",
      enumArgs: "Numeric enum members -> member name; string enums (e.g. SpeciesFormKey) -> their string value. argKinds[i] tells what each arg was (enum:<Name>, number, string, boolean, array, object, const:<NAME>, raw).",
      raw: "Anything not statically evaluable (lambdas, new expressions, conditions, i18n calls) is kept as comment-free single-line source text.",
      nulls: "power/accuracy/chance -1 in PokéRogue -> null (accuracy null = never misses). abilities.a2 null = PokéRogue reuses a1 for that slot; hidden null = none.",
      learnsets: "SPECIES = default form (levelMoves + formLevelMoves[forms[0].formKey]); 'SPECIES:formKey' = full list for that form. Level 0 = EVOLVE_MOVE, -1 = RELEARN_MOVE.",
      tms: "Effective TM learners like PokéRogue getTms(): own tms + formTms + prevolution chain. 'SPECIES:formKey' listed only when that non-default form learns it but the default form does not.",
      formChanges: "synthesized:true entries are the reverse item changes PokéRogue adds at runtime (initReverseFormChanges).",
      unused: "moves/abilities with unused:true sit inside PokéRogue's /* Unused */ blocks (Z-moves, Max moves, ...). gmax-moves.json are commented out entirely in PokéRogue (no MoveId).",
    },
  };
  const extractedAt =
    changed.length === 0 && prevMeta?.extractedAt ? prevMeta.extractedAt : new Date().toISOString();
  const meta = { extractedAt, ...metaBody };
  const metaChanged = writeIfChanged(metaFile, toJson(meta));
  if (writeSourcesMd(pins)) changed.push("SOURCES.md");

  log(`done. changed: ${changed.length ? changed.join(", ") : "(nothing)"}${metaChanged ? " + meta.json" : ""}`);
  if (ctx.report.unparseable.length) log(`${ctx.report.unparseable.length} unparseable item(s) listed in extract-report.json`);
}

export type { AbilityOut, MoveOut };

main().catch(e => {
  console.error(e);
  process.exit(1);
});

void fs;
