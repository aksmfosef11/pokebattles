/**
 * Builds data/i18n/{lang}.json from pokerogue-locales (primary) and PokeAPI CSVs (supplemental), keyed by the
 * same enum member names as data/pokerogue.
 */
import fs from "node:fs";
import path from "node:path";
import {
  type ItemCatalogEntry,
  keyFromPokeapiIdentifier,
  POKEAPI_SUPPLEMENTAL_CATEGORIES,
  pokeapiIdentifierFor,
  REQUIRED_ITEMS,
} from "./items.ts";
import {
  type AbilityOut,
  type Ctx,
  classStaticRecord,
  type MoveOut,
  type RawSpeciesData,
  switchReturnMap,
} from "./pokerogue.ts";
import { pokeapiCsv } from "./sources.ts";
import { findAll, parseFile, ts, unwrap } from "./ts-eval.ts";
import { fromEntries, isPlainObject, listFilesRecursive, type Pins, readJson, short, toCamelCase, toPascalCase, toUpperSnake } from "./util.ts";

type Dict = Record<string, any>;

export interface I18nInput {
  ctx: Ctx;
  localesDir: string;
  pins: Pins;
  species: RawSpeciesData[];
  moves: MoveOut[];
  gmax: MoveOut[];
  abilities: AbilityOut[];
  rosterIds: number[];
  rosterTrainers: string[];
}

export interface I18nResult {
  files: Record<string, Dict>;
  report: Dict;
  itemCatalog: Record<string, ItemCatalogEntry>;
  gmaxSpecies: Record<string, { species: string | null; formKey: string | null; derivedFrom: string }>;
}

const get = (obj: unknown, dotted: string): unknown => {
  let cur: any = obj;
  for (const part of dotted.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return cur;
};
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);
const render = (tpl: string, vars: Record<string, string>): string =>
  tpl.replace(/\{\{\s*-?\s*(\w+)\s*\}\}/g, (m, k) => (k in vars ? vars[k] : m));
const hasPlaceholder = (s: string) => /\{\{/.test(s);

export async function buildI18n(input: I18nInput): Promise<I18nResult> {
  const { ctx, localesDir, pins, species, moves, gmax, abilities } = input;
  const LOC = `pokerogue-locales@${pins.pokerogueLocales.commit}`;
  const API = `pokeapi@${pins.pokeapi.commit}`;
  const enums = ctx.enums;

  const langs = fs
    .readdirSync(localesDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules")
    .map(d => d.name)
    .filter(l => fs.readdirSync(path.join(localesDir, l)).some(f => f.endsWith(".json")))
    .sort();

  const nsCache = new Map<string, Dict>();
  const ns = (lang: string, file: string): Dict => {
    const k = `${lang}/${file}`;
    if (!nsCache.has(k)) {
      const p = path.join(localesDir, lang, `${file}.json`);
      nsCache.set(k, fs.existsSync(p) ? readJson<Dict>(p) : {});
    }
    return nsCache.get(k)!;
  };

  // --- PokéRogue i18n config (fallback chain + supported languages)
  const { fallbackLng, supportedLngs } = readI18nConfig(ctx);
  const chainFor = (lang: string): string[] => (fallbackLng[lang] ?? fallbackLng.default ?? ["en"]).filter(l => l !== lang);

  // --- PokeAPI tables
  const [apiLangs, apiItems, apiItemNames, apiItemFlavor, apiItemCats, apiVersionGroups, apiMoves, apiMoveNames] = await Promise.all([
    pokeapiCsv("languages"),
    pokeapiCsv("items"),
    pokeapiCsv("item_names"),
    pokeapiCsv("item_flavor_text"),
    pokeapiCsv("item_categories"),
    pokeapiCsv("version_groups"),
    pokeapiCsv("moves"),
    pokeapiCsv("move_names"),
  ]);
  const apiLangIdent = new Map(apiLangs.map(l => [l.id, l.identifier]));
  const pokeapiLangsFor = (lang: string): string[] => {
    const lc = lang.toLowerCase();
    let idents: string[];
    if (lc === "ja") idents = ["ja", "ja-hrkt"];
    else if (lc === "es-es") idents = ["es"];
    else if (lc === "es-419") idents = ["es-419", "es"];
    else idents = [lc];
    return idents.flatMap(i => apiLangs.filter(l => l.identifier === i).map(l => l.id));
  };
  const itemById = new Map(apiItems.map(i => [i.id, i]));
  const itemIdByIdent = new Map(apiItems.map(i => [i.identifier, i.id]));
  const itemIdents = new Set(itemIdByIdent.keys());
  const catIdent = new Map(apiItemCats.map(c => [c.id, c.identifier]));
  const itemNames = new Map<string, Map<string, string>>(); // itemId -> langId -> name
  for (const r of apiItemNames) {
    if (!itemNames.has(r.item_id)) itemNames.set(r.item_id, new Map());
    itemNames.get(r.item_id)!.set(r.local_language_id, r.name);
  }
  const vgOrder = new Map(apiVersionGroups.map(v => [v.id, Number(v.order || v.id)]));
  const itemFlavor = new Map<string, Map<string, { order: number; text: string }>>();
  for (const r of apiItemFlavor) {
    if (!itemFlavor.has(r.item_id)) itemFlavor.set(r.item_id, new Map());
    const m = itemFlavor.get(r.item_id)!;
    const ord = vgOrder.get(r.version_group_id) ?? Number(r.version_group_id);
    const prev = m.get(r.language_id);
    if (!prev || ord > prev.order) m.set(r.language_id, { order: ord, text: r.flavor_text });
  }
  const cleanFlavor = (text: string, lang: string): string => {
    const joiner = /^(ja|zh)/.test(lang) ? "" : " ";
    return text
      .replace(/­\n?/g, "")
      .replace(/[\f\r]/g, "\n")
      .split("\n")
      .map(s => s.trim())
      .filter(Boolean)
      .join(joiner)
      .replace(/ {2,}/g, " ");
  };
  const apiItemName = (ident: string, lang: string): { name: string; description: string | null; langId: string } | undefined => {
    const id = itemIdByIdent.get(ident);
    if (!id) return undefined;
    for (const lid of pokeapiLangsFor(lang)) {
      const n = itemNames.get(id)?.get(lid);
      if (n) {
        const fl = itemFlavor.get(id)?.get(lid);
        return { name: n, description: fl ? cleanFlavor(fl.text, lang) : null, langId: lid };
      }
    }
    return undefined;
  };
  const moveNames = new Map<string, Map<string, string>>();
  for (const r of apiMoveNames) {
    if (!moveNames.has(r.move_id)) moveNames.set(r.move_id, new Map());
    moveNames.get(r.move_id)!.set(r.local_language_id, r.name);
  }
  const apiMoveById = new Map(apiMoves.map(m => [m.id, m]));
  // PokéRogue MoveId values follow the national move numbering; verify per move before using PokeAPI by id.
  const norm = (s: string) => s.toLowerCase().replace(/ten[-_]?million/, "10000000").replace(/[^a-z0-9]/g, "");
  const moveIdMismatches: string[] = [];
  for (const m of moves) {
    if (m.id == null) continue;
    const a = apiMoveById.get(String(m.id));
    if (!a) continue;
    if (norm(a.identifier) !== norm(m.key)) moveIdMismatches.push(`${m.key}(${m.id}) vs pokeapi ${a.identifier}`);
  }
  const apiMoveName = (m: MoveOut, lang: string): { name: string; langId: string; identifier: string } | undefined => {
    if (m.id == null) return undefined;
    const a = apiMoveById.get(String(m.id));
    if (!a || norm(a.identifier) !== norm(m.key)) return undefined;
    for (const lid of pokeapiLangsFor(lang)) {
      const n = moveNames.get(String(m.id))?.get(lid);
      if (n) return { name: n, langId: lid, identifier: a.identifier };
    }
    return undefined;
  };

  // --- Enum / lookup tables from PokéRogue source
  const typeMembers = enums.memberNames("PokemonType");
  const statMembers = enums.memberNames("Stat");
  const natureMembers = enums.memberNames("Nature");
  const statusMembers = enums.memberNames("StatusEffect");
  const berryMembers = enums.memberNames("BerryType");
  const evoItemMembers = enums.memberNames("EvolutionItem").filter(k => k !== "NONE");
  const formItemMembers = enums.memberNames("FormChangeItem").filter(k => k !== "NONE");
  const attackBoosterEnum = enums.get("AttackTypeBoosterItem");
  const baseStatItems = classStaticRecord(ctx, "modifier/modifier-type.ts", "BaseStatBoosterModifierTypeGenerator", "items");
  const tempStatItems = classStaticRecord(ctx, "modifier/modifier-type.ts", "TempStatStageBoosterModifierTypeGenerator", "items");
  const ballNameKeys = switchReturnMap(ctx, "data/pokeball.ts", "getPokeballName");
  const ballFrames = switchReturnMap(ctx, "data/pokeball.ts", "getPokeballAtlasKey");
  const voucherNameKeys = switchReturnMap(ctx, "system/voucher.ts", "getVoucherTypeName");
  const voucherIcons = switchReturnMap(ctx, "system/voucher.ts", "getVoucherTypeIcon");
  const customFormNames = readCustomFormNames(ctx);
  const regionMembers = enums.memberNames("Region");

  const speciesByKey = new Map(species.map(r => [r.species.key, r]));
  const rootSpecies = (key: string): string => {
    let k = key;
    for (let i = 0; i < 10; i++) {
      const p = speciesByKey.get(k)?.species.prevolution;
      if (!p) break;
      k = p;
    }
    return k;
  };

  // --- Item catalog: PokéRogue items (by locale key) + required keys + PokeAPI supplemental items
  interface ItemSrc {
    key: string;
    group: string;
    frame: string | null;
    /** resolve name/description for a language from PokéRogue locales */
    pr: (lang: string) => { name: string; description: string | null; localeKey: string } | undefined;
  }
  const prItems = new Map<string, ItemSrc>();
  const addPr = (src: ItemSrc) => {
    if (!prItems.has(src.key)) prItems.set(src.key, src);
  };
  const mt = (lang: string) => ns(lang, "modifier-type");
  const typeName = (lang: string, member: string) => str(get(ns(lang, "pokemon-info"), `type.${toCamelCase(member)}`));
  const statName = (lang: string, member: string) => str(get(ns(lang, "pokemon-info"), `stat.${toCamelCase(member)}`));

  // 1. ModifierType.<KEY> entries with a literal name
  for (const [k, v] of Object.entries(get(mt("en"), "ModifierType") ?? {})) {
    if (!/^[A-Z0-9_]+$/.test(k) || !isPlainObject(v) || !str(v.name) || hasPlaceholder(v.name as string)) continue;
    addPr({
      key: k,
      group: "modifier",
      frame: k.toLowerCase(),
      pr: lang => {
        const e = get(mt(lang), `ModifierType.${k}`) as Dict | undefined;
        const name = str(e?.name);
        if (!name || hasPlaceholder(name)) return undefined;
        const d = str(e?.description);
        return { name, description: d && !hasPlaceholder(d) ? d : null, localeKey: `modifierType:ModifierType.${k}` };
      },
    });
  }
  // 2. species boosters
  for (const [k] of Object.entries(get(mt("en"), "SpeciesBoosterItem") ?? {})) {
    addPr({
      key: k,
      group: "speciesBooster",
      frame: k.toLowerCase(),
      pr: lang => {
        const e = get(mt(lang), `SpeciesBoosterItem.${k}`) as Dict | undefined;
        const name = str(e?.name);
        return name ? { name, description: str(e?.description) ?? null, localeKey: `modifierType:SpeciesBoosterItem.${k}` } : undefined;
      },
    });
  }
  // 3. type boosters (AttackTypeBoosterItem enum index == PokemonType value)
  if (attackBoosterEnum) {
    for (const [member, idx] of attackBoosterEnum.members) {
      const nameKey = member.toLowerCase();
      const pType = enums.nameOf("PokemonType", idx as number);
      addPr({
        key: member,
        group: "typeBooster",
        frame: nameKey,
        pr: lang => {
          const name = str(get(mt(lang), `AttackTypeBoosterItem.${nameKey}`));
          if (!name) return undefined;
          const tpl = str(get(mt(lang), "ModifierType.AttackTypeBoosterModifierType.description"));
          const tn = pType ? typeName(lang, pType) : undefined;
          return { name, description: tpl && tn ? render(tpl, { moveType: tn }) : null, localeKey: `modifierType:AttackTypeBoosterItem.${nameKey}` };
        },
      });
    }
  }
  // 4. base-stat boosters (vitamins)
  for (const [stat, nameKey] of Object.entries(baseStatItems)) {
    addPr({
      key: nameKey.toUpperCase(),
      group: "vitamin",
      frame: nameKey,
      pr: lang => {
        const name = str(get(mt(lang), `BaseStatBoosterItem.${nameKey}`));
        if (!name) return undefined;
        const tpl = str(get(mt(lang), "ModifierType.BaseStatBoosterModifierType.description"));
        const sn = statName(lang, stat);
        return { name, description: tpl && sn ? render(tpl, { stat: sn }) : null, localeKey: `modifierType:BaseStatBoosterItem.${nameKey}` };
      },
    });
  }
  // 5. X items (TempStatStageBoosterModifierType: ACC uses "stage", others "percentage")
  for (const [stat, nameKey] of Object.entries(tempStatItems)) {
    addPr({
      key: nameKey.toUpperCase(),
      group: "xItem",
      frame: nameKey,
      pr: lang => {
        const name = str(get(mt(lang), `TempStatStageBoosterItem.${nameKey}`));
        if (!name) return undefined;
        const tpl = str(get(mt(lang), "ModifierType.TempStatStageBoosterModifierType.description"));
        const amount = str(get(mt(lang), `ModifierType.TempStatStageBoosterModifierType.extra.${stat === "ACC" ? "stage" : "percentage"}`));
        const sn = statName(lang, stat);
        return {
          name,
          description: tpl && sn && amount ? render(tpl, { stat: sn, amount }) : null,
          localeKey: `modifierType:TempStatStageBoosterItem.${nameKey}`,
        };
      },
    });
  }
  // 6/7. evolution + form-change items
  for (const [enumName, list, group] of [
    ["EvolutionItem", evoItemMembers, "evolution"],
    ["FormChangeItem", formItemMembers, "formChange"],
  ] as const) {
    for (const k of list) {
      addPr({
        key: k,
        group,
        frame: k.toLowerCase(),
        pr: lang => {
          const name = str(get(mt(lang), `${enumName}.${k}`));
          if (!name) return undefined;
          return {
            name,
            description: str(get(mt(lang), `ModifierType.${enumName}ModifierType.description`)) ?? null,
            localeKey: `modifierType:${enumName}.${k}`,
          };
        },
      });
    }
  }
  // 8. berries
  for (const b of berryMembers) {
    const lk = toCamelCase(b);
    addPr({
      key: `${b}_BERRY`,
      group: "berry",
      frame: `${b.toLowerCase()}_berry`,
      pr: lang => {
        const e = get(ns(lang, "berry"), lk) as Dict | undefined;
        const name = str(e?.name);
        return name ? { name, description: str(e?.effect) ?? null, localeKey: `berry:${lk}` } : undefined;
      },
    });
  }
  // 9. balls
  for (const [member, fullKey] of Object.entries(ballNameKeys)) {
    const [nsName, k] = fullKey.split(":");
    const file = nsName.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);
    addPr({
      key: toUpperSnake(k),
      group: "ball",
      frame: ballFrames[member] ?? null,
      pr: lang => {
        const name = str(get(ns(lang, file), k));
        return name ? { name, description: null, localeKey: fullKey } : undefined;
      },
    });
  }
  // 10. vouchers (REGULAR -> VOUCHER)
  for (const [member, fullKey] of Object.entries(voucherNameKeys)) {
    const [, k] = fullKey.split(":");
    const key = member === "REGULAR" ? "VOUCHER" : `VOUCHER_${member}`;
    addPr({
      key,
      group: "voucher",
      frame: voucherIcons[member] ?? null,
      pr: lang => {
        const name = str(get(ns(lang, "voucher"), k));
        return name ? { name, description: null, localeKey: fullKey } : undefined;
      },
    });
  }
  // 11. per-type tera shards (PokéRogue names are a template: "{{teraType}} Tera Shard")
  for (const t of typeMembers) {
    if (t === "UNKNOWN") continue;
    addPr({
      key: `${t}_TERA_SHARD`,
      group: "teraShard",
      frame: `${t.toLowerCase()}_tera_shard`,
      pr: lang => {
        const tpl = get(mt(lang), "ModifierType.TerastallizeModifierType") as Dict | undefined;
        const tn = typeName(lang, t);
        if (!str(tpl?.name) || !tn) return undefined;
        return {
          name: render(tpl!.name, { teraType: tn }),
          description: str(tpl?.description) ? render(tpl!.description, { teraType: tn }) : null,
          localeKey: `modifierType:ModifierType.TerastallizeModifierType (template) + pokemonInfo:type.${toCamelCase(t)}`,
        };
      },
    });
  }

  // roster mega stones / primal orbs
  const rosterSet = new Set(input.rosterIds);
  const rosterStones = new Map<string, string[]>();
  for (const r of species) {
    if (!rosterSet.has(r.species.id)) continue;
    for (const fc of r.formChanges) {
      if (fc.synthesized || !fc.item || fc.preFormKey !== "" && !r.species.forms.some(f => f.formKey === fc.preFormKey && f.formIndex === 0)) continue;
      if (!/^(mega|primal)/.test(fc.formKey)) continue;
      if (!rosterStones.has(fc.item)) rosterStones.set(fc.item, []);
      const l = rosterStones.get(fc.item)!;
      if (!l.includes(r.species.key)) l.push(r.species.key);
    }
  }

  const requiredKeys = new Map<string, string>();
  for (const g of REQUIRED_ITEMS) for (const k of g.keys) requiredKeys.set(k, g.group);

  const catalog: Record<string, ItemCatalogEntry> = {};
  const addCatalog = (key: string, e: Omit<ItemCatalogEntry, "required">) => {
    if (catalog[key]) return;
    catalog[key] = { ...e, required: requiredKeys.has(key) || rosterStones.has(key) };
    if (rosterStones.has(key)) catalog[key].rosterMegaStoneFor = rosterStones.get(key);
  };
  for (const src of prItems.values()) {
    const ident = pokeapiIdentifierFor(src.key, itemIdents);
    addCatalog(src.key, {
      pokerogueLocaleKey: src.pr("en")?.localeKey ?? null,
      pokeapiIdentifier: ident,
      pokeapiCategory: ident ? (catIdent.get(itemById.get(itemIdByIdent.get(ident)!)!.category_id) ?? null) : null,
      group: src.group,
      atlasFrame: src.frame,
    });
  }
  for (const [key, group] of requiredKeys) {
    const ident = pokeapiIdentifierFor(key, itemIdents);
    addCatalog(key, {
      pokerogueLocaleKey: null,
      pokeapiIdentifier: ident,
      pokeapiCategory: ident ? (catIdent.get(itemById.get(itemIdByIdent.get(ident)!)!.category_id) ?? null) : null,
      group,
      atlasFrame: key.toLowerCase(),
    });
  }
  const supplementalCats = new Set(POKEAPI_SUPPLEMENTAL_CATEGORIES);
  const zCrystalIdents: string[] = [];
  for (const it of apiItems) {
    const cat = catIdent.get(it.category_id) ?? "";
    const isZ = /-z--held$/.test(it.identifier);
    if (isZ) zCrystalIdents.push(it.identifier);
    if (!supplementalCats.has(cat) && !isZ) continue;
    if (/--bag$/.test(it.identifier)) continue;
    const key = keyFromPokeapiIdentifier(it.identifier);
    addCatalog(key, {
      pokerogueLocaleKey: null,
      pokeapiIdentifier: it.identifier,
      pokeapiCategory: isZ ? "z-crystals" : cat,
      group: isZ ? "zCrystal" : `pokeapi:${cat}`,
      atlasFrame: key.toLowerCase(),
    });
  }
  const catalogOrder = Object.keys(catalog).sort((a, b) => {
    const ra = catalog[a].required ? 0 : 1;
    const rb = catalog[b].required ? 0 : 1;
    return ra - rb || (a < b ? -1 : a > b ? 1 : 0);
  });
  const sortedCatalog = fromEntries(catalogOrder.map(k => [k, catalog[k]]));

  // Z / Max moves
  const zMoveList = moves.filter(m => /__(PHYSICAL|SPECIAL)$/.test(m.key) || (m.generation === 7 && m.pp === 1 && m.unused));
  const zMoveKeys = [...new Set(zMoveList.map(m => m.key.replace(/__(PHYSICAL|SPECIAL)$/, "")))];
  const maxMoveList = [...moves.filter(m => /^MAX_/.test(m.key) && m.generation === 8), ...gmax];

  // G-Max move -> species (from the English effect text "... that Gigantamax <Species> use")
  const enPokemon = ns("en", "pokemon");
  const enNameToKey = new Map<string, string>();
  for (const r of species) {
    const n = str(enPokemon[toCamelCase(r.species.key)]);
    if (n && !enNameToKey.has(n)) enNameToKey.set(n, r.species.key);
  }
  const gmaxSpecies: I18nResult["gmaxSpecies"] = {};
  for (const g of gmax) {
    const eff = str(get(ns("en", "move"), `${toCamelCase(g.key)}.effect`)) ?? "";
    const m = /Gigantamax ([^\s.,]+(?: [A-Z][^\s.,]*)?) use/.exec(eff);
    let sp: string | null = null;
    let fk: string | null = null;
    if (m) {
      sp = enNameToKey.get(m[1]) ?? enNameToKey.get(m[1].split(" ")[0]) ?? null;
      const rec = sp ? speciesByKey.get(sp) : undefined;
      const gforms = rec?.species.forms.filter(f => f.formKey.startsWith("gigantamax")) ?? [];
      if (gforms.length === 1) fk = gforms[0].formKey;
      else if (gforms.length > 1) {
        const hint = /single-strike/i.test(eff) ? "single" : /rapid-strike/i.test(eff) ? "rapid" : "";
        fk = gforms.find(f => hint && f.formKey.endsWith(hint))?.formKey ?? null;
      }
    }
    gmaxSpecies[g.key] = { species: sp, formKey: fk, derivedFrom: `en/move.json ${toCamelCase(g.key)}.effect` };
  }

  // --- per-language build
  const files: Record<string, Dict> = {};
  const langReport: Dict = {};
  const champions = input.rosterTrainers;
  const enTrainers = ns("en", "trainer-names");
  const championLocaleKey = (gameKey: string): string | null => {
    if (str(enTrainers[gameKey])) return gameKey;
    const cand = Object.keys(enTrainers).find(k => k.toLowerCase() === gameKey.toLowerCase());
    return cand ?? null;
  };

  for (const lang of langs) {
    const L = (file: string) => ns(lang, file);
    const prov: Dict = {};
    const fallbacks: Dict = {};
    const missing: Dict = {};

    // species
    const speciesOut: Dict = {};
    for (const r of species) {
      const n = str(L("pokemon")[toCamelCase(r.species.key)]);
      if (n) speciesOut[r.species.key] = n;
    }
    prov.species = LOC;

    // forms
    const forms: Dict = {};
    const formLabels: Dict = {};
    const pf = L("pokemon-form");
    const pfb = L("pokemon-form-battle");
    const battleFormKeys = ["mega", "mega-x", "mega-y", "mega-z", "primal", "gigantamax", "gigantamax-rapid", "gigantamax-single", "eternamax"];
    const megaVariants = ["mega-original", "mega-curly", "mega-droopy", "mega-stretchy"];
    const unlocalizedForms: string[] = [];
    for (const r of species) {
      const sp = r.species;
      const spName = speciesOut[sp.key];
      if (!spName) continue;
      const region = Math.floor(sp.id / 2000);
      const regionName = regionMembers[region] ?? "NORMAL";
      for (const f of sp.forms) {
        const key = `${sp.key}:${f.formKey}`;
        const formText = toPascalCase(f.formKey);
        const speciesCamel = toCamelCase(sp.key);
        let label: string | undefined;
        let full: string | undefined;
        if (sp.key === "ARCEUS") {
          label = str(get(L("pokemon-info"), `type.${toCamelCase(formText)}`));
          if (label) full = str(pf.appendForm?.generic) ? render(pf.appendForm.generic, { pokemonName: spName, formName: label }) : undefined;
        } else if (battleFormKeys.includes(f.formKey) || megaVariants.includes(f.formKey)) {
          const k = toCamelCase(megaVariants.includes(f.formKey) ? "mega" : f.formKey);
          label = str(get(pf, `battleForm.${k}`));
          const tpl = str(pfb[k]);
          full = tpl ? render(tpl, { pokemonName: spName }) : undefined;
        } else if (regionName === "NORMAL" || (sp.key === "GALAR_DARMANITAN" && f.formIndex > 0) || sp.key === "PALDEA_TAUROS") {
          label = str(pf[`${speciesCamel}${formText}`]) ?? str(pf[`${toCamelCase(rootSpecies(sp.key))}${formText}`]);
          if (label && str(pf.appendForm?.generic)) full = render(pf.appendForm.generic, { pokemonName: spName, formName: label });
          if (!label && f.formKey) unlocalizedForms.push(key);
        } else {
          const appendKey = toCamelCase(sp.key.split("_")[0]);
          const tpl = str(get(pf, `appendForm.${appendKey}`));
          full = tpl ? render(tpl, { pokemonName: spName }) : undefined;
          const custom = customFormNames[sp.key];
          label = custom ? str(pf[custom]) : str(get(pf, `regionalForm.${toCamelCase(regionName)}`));
        }
        if (full) forms[key] = full;
        if (label) formLabels[key] = label;
      }
    }
    // Regional species (Alolan Ninetales, Galarian Mr. Mime) are named the way PokéRogue's
    // PokemonSpecies.getName() does it: pokemonForm:appendForm.<region> around the base name.
    for (const r of species) {
      const sp = r.species;
      if (sp.id < 2000 || !speciesOut[sp.key]) continue;
      const tpl = str(get(pf, `appendForm.${toCamelCase(sp.key.split("_")[0])}`));
      if (tpl) speciesOut[sp.key] = render(tpl, { pokemonName: speciesOut[sp.key] });
    }
    prov.forms = LOC;
    prov.formLabels = LOC;

    // moves
    const movesOut: Dict = {};
    const mv = L("move");
    for (const m of moves) {
      const e = mv[toCamelCase(m.key)];
      const name = str(e?.name);
      if (name) movesOut[m.key] = { name, effect: str(e?.effect) ?? null };
    }
    prov.moves = LOC;

    // abilities
    const abilitiesOut: Dict = {};
    const ab = L("ability");
    for (const a of abilities) {
      const e = ab[toCamelCase(a.key)];
      const name = str(e?.name);
      if (name) abilitiesOut[a.key] = { name, description: str(e?.description) ?? null };
    }
    prov.abilities = LOC;

    // types, natures, stats, status effects
    const types: Dict = {};
    for (const t of typeMembers) {
      const n = typeName(lang, t);
      if (n) types[t.toLowerCase()] = n;
    }
    const natures: Dict = {};
    for (const n of natureMembers) {
      const v = str(L("nature")[toCamelCase(n)]);
      if (v) natures[n] = v;
    }
    const stats: Dict = {};
    for (const s of statMembers) {
      const n = statName(lang, s);
      if (n) stats[s] = { name: n, short: str(get(L("pokemon-info"), `stat.${toCamelCase(s)}Shortened`)) ?? null };
    }
    const statusEffects: Dict = {};
    for (const s of statusMembers) {
      const e = L("status-effect")[toCamelCase(s)];
      if (isPlainObject(e) && str(e.name)) statusEffects[s] = fromEntries(Object.entries(e).filter(([, v]) => typeof v === "string") as [string, string][]);
    }
    prov.types = LOC;
    prov.natures = LOC;
    prov.stats = LOC;
    prov.statusEffects = LOC;

    // items
    const items: Dict = {};
    const itemProv: Dict = {};
    for (const key of catalogOrder) {
      const c = catalog[key];
      const src = prItems.get(key);
      const p = src?.pr(lang);
      if (p) {
        items[key] = { name: p.name, description: p.description };
        itemProv[key] = { source: LOC, localeKey: p.localeKey };
        continue;
      }
      if (c.pokeapiIdentifier) {
        const a = apiItemName(c.pokeapiIdentifier, lang);
        if (a) {
          items[key] = { name: a.name, description: a.description };
          itemProv[key] = { source: API, pokeapiIdentifier: c.pokeapiIdentifier, pokeapiLanguage: apiLangIdent.get(a.langId) };
          continue;
        }
      }
      if (c.required) (missing.items ??= []).push(key);
    }
    prov.items = itemProv;

    const templates: Dict = {};
    const tplSrc: [string, string][] = [
      ["TM", "TmModifierType"],
      ["TM_WITH_INFO", "TmModifierTypeWithInfo"],
      ["TERA_SHARD", "TerastallizeModifierType"],
      ["MINT", "PokemonNatureChangeModifierType"],
      ["POKEBALL_BUNDLE", "AddPokeballModifierType"],
      ["VOUCHER_BUNDLE", "AddVoucherModifierType"],
    ];
    for (const [k, mk] of tplSrc) {
      const e = get(mt(lang), `ModifierType.${mk}`) as Dict | undefined;
      if (str(e?.name)) templates[k] = { name: e!.name, description: str(e?.description) ?? null, localeKey: `modifierType:ModifierType.${mk}` };
    }
    prov.itemTemplates = LOC;

    // trainers
    const trainers: Dict = {};
    for (const [k, v] of Object.entries(L("trainer-names"))) if (str(v)) trainers[k] = v;
    for (const game of champions) {
      const lk = championLocaleKey(game);
      if (!lk) {
        (missing.champions ??= []).push(`${game} (no PokéRogue trainer-name key)`);
        continue;
      }
      if (str(trainers[lk])) {
        if (lk !== game) trainers[game] = trainers[lk];
        continue;
      }
      // look in other locale files of this language for a same-named string key
      let found: { value: string; file: string } | undefined;
      for (const f of listFilesRecursive(path.join(localesDir, lang)).filter(f => f.endsWith(".json"))) {
        const rel = path.relative(path.join(localesDir, lang), f).replace(/\\/g, "/");
        if (rel === "trainer-names.json") continue;
        const j = readJson<Dict>(f);
        const hit = findStringKey(j, lk);
        if (hit) {
          found = { value: hit, file: rel };
          break;
        }
      }
      if (found) {
        trainers[game] = found.value;
        fallbacks[`trainers.${game}`] = { source: LOC, lang, file: found.file, key: lk };
        continue;
      }
      for (const fl of chainFor(lang)) {
        const v = str(ns(fl, "trainer-names")[lk]);
        if (v) {
          trainers[game] = v;
          fallbacks[`trainers.${game}`] = { source: LOC, lang: fl, file: "trainer-names.json", key: lk };
          break;
        }
      }
      if (!trainers[game]) (missing.champions ??= []).push(game);
    }
    prov.trainers = LOC;
    const trainerTitles: Dict = {};
    for (const [k, v] of Object.entries(L("trainer-titles"))) if (str(v)) trainerTitles[k] = v;
    prov.trainerTitles = LOC;

    // Z-crystals, Z-moves, Max moves
    const zCrystals: Dict = {};
    const zProv: Dict = {};
    for (const ident of zCrystalIdents) {
      const key = keyFromPokeapiIdentifier(ident);
      const pr = prItems.get(key)?.pr(lang);
      if (pr) {
        zCrystals[key] = pr.name;
        zProv[key] = { source: LOC, localeKey: pr.localeKey };
        continue;
      }
      const a = apiItemName(ident, lang);
      if (a) {
        zCrystals[key] = a.name;
        zProv[key] = { source: API, pokeapiIdentifier: ident, pokeapiLanguage: apiLangIdent.get(a.langId) };
      } else if (requiredKeys.has(key)) (missing.zCrystals ??= []).push(key);
    }
    prov.zCrystals = zProv;

    const moveNameFor = (m: MoveOut): { name: string; prov: Dict } | undefined => {
      const e = mv[toCamelCase(m.key)];
      if (str(e?.name)) return { name: e.name, prov: { source: LOC, localeKey: `move:${toCamelCase(m.key)}.name` } };
      const a = apiMoveName(m, lang);
      if (a) return { name: a.name, prov: { source: API, pokeapiIdentifier: a.identifier, pokeapiLanguage: apiLangIdent.get(a.langId) } };
      return undefined;
    };
    const zMoves: Dict = {};
    const zmProv: Dict = {};
    for (const zk of zMoveKeys) {
      const variants = zMoveList.filter(m => m.key.replace(/__(PHYSICAL|SPECIAL)$/, "") === zk);
      const got = variants.map(moveNameFor).filter(Boolean) as { name: string; prov: Dict }[];
      if (!got.length) {
        (missing.zMoves ??= []).push(zk);
        continue;
      }
      zMoves[zk] = got[0].name;
      zmProv[zk] = got[0].prov;
      if (got.some(g => g.name !== got[0].name)) (missing.zMoveVariantNameMismatch ??= []).push(zk);
    }
    prov.zMoves = zmProv;
    const maxMoves: Dict = {};
    const mmProv: Dict = {};
    for (const m of maxMoveList) {
      const got = moveNameFor(m);
      if (got) {
        maxMoves[m.key] = got.name;
        mmProv[m.key] = got.prov;
      } else (missing.maxMoves ??= []).push(m.key);
    }
    prov.maxMoves = mmProv;

    files[lang] = {
      lang,
      _meta: {
        pokerogueSupported: supportedLngs.includes(lang),
        fallbackChain: chainFor(lang),
        fallbackNote: "Sections contain only strings that exist for this language (no silent English copies). Resolve missing keys via fallbackChain at runtime. Exception: champion trainer names listed in _fallbacks.",
        pokeapiLanguages: pokeapiLangsFor(lang).map(id => apiLangIdent.get(id)),
      },
      species: speciesOut,
      forms,
      formLabels,
      moves: movesOut,
      abilities: abilitiesOut,
      types,
      natures,
      stats,
      statusEffects,
      items,
      itemTemplates: templates,
      trainers,
      trainerTitles,
      zCrystals,
      zMoves,
      maxMoves,
      _provenance: prov,
      _fallbacks: fallbacks,
    };
    langReport[lang] = {
      counts: {
        species: Object.keys(speciesOut).length,
        forms: Object.keys(forms).length,
        moves: Object.keys(movesOut).length,
        abilities: Object.keys(abilitiesOut).length,
        items: Object.keys(items).length,
        itemsFromPokeapi: Object.values(itemProv).filter((p: any) => p.source === API).length,
        trainers: Object.keys(trainers).length,
        zCrystals: Object.keys(zCrystals).length,
        zMoves: Object.keys(zMoves).length,
        maxMoves: Object.keys(maxMoves).length,
      },
      missing,
      fallbacks,
      unlocalizedForms: lang === "en" ? unlocalizedForms : undefined,
    };
  }

  // unmapped locale keys (en)
  const used = (keys: string[]) => new Set(keys.map(k => toCamelCase(k)));
  const unmapped = (obj: Dict, usedSet: Set<string>) => Object.keys(obj).filter(k => !usedSet.has(k));
  const report = {
    languages: langs,
    pokerogueSupportedLanguages: supportedLngs,
    fallbackLng,
    pokeapiLanguageMap: fromEntries(langs.map(l => [l, pokeapiLangsFor(l).map(id => apiLangIdent.get(id) ?? id)])),
    unmappedLocaleKeys: {
      "pokemon.json": unmapped(ns("en", "pokemon"), used(species.map(r => r.species.key))),
      "move.json": unmapped(ns("en", "move"), used([...moves.map(m => m.key), ...gmax.map(m => m.key)])),
      "ability.json": unmapped(ns("en", "ability"), used(abilities.map(a => a.key))),
      "nature.json": unmapped(ns("en", "nature"), used(natureMembers)),
      "berry.json": unmapped(ns("en", "berry"), used(berryMembers)),
    },
    moveIdVsPokeapiMismatches: moveIdMismatches,
    perLanguage: langReport,
  };
  return { files, report, itemCatalog: sortedCatalog, gmaxSpecies };
}

function findStringKey(obj: unknown, key: string, depth = 0): string | undefined {
  if (!isPlainObject(obj) || depth > 6) return undefined;
  for (const [k, v] of Object.entries(obj)) {
    if (k === key && typeof v === "string" && v.trim() && v.length <= 40 && !/[{}\n]/.test(v)) return v;
  }
  for (const v of Object.values(obj)) {
    const r = findStringKey(v, key, depth + 1);
    if (r) return r;
  }
  return undefined;
}

function readI18nConfig(ctx: Ctx): { fallbackLng: Record<string, string[]>; supportedLngs: string[] } {
  const fallbackLng: Record<string, string[]> = {};
  let supportedLngs: string[] = [];
  const files = listFilesRecursive(ctx.src).filter(f => /i18n[^/\\]*\.ts$/.test(f));
  for (const f of files) {
    const sf = parseFile(f);
    for (const pa of findAll(sf, ts.isPropertyAssignment)) {
      if (pa.name.getText(sf) !== "fallbackLng") continue;
      const v = ctx.ev.eval(pa.initializer);
      if (v.kind === "object") for (const [k, val] of Object.entries(v.value as Dict)) if (Array.isArray(val)) fallbackLng[k] = val as string[];
    }
    for (const vd of findAll(sf, ts.isVariableDeclaration)) {
      if (vd.name.getText(sf) !== "supportedLngs" || !vd.initializer) continue;
      const v = ctx.ev.eval(unwrap(vd.initializer));
      if (v.kind === "array") supportedLngs = v.value as string[];
    }
  }
  if (!Object.keys(fallbackLng).length) fallbackLng.default = ["en"];
  return { fallbackLng, supportedLngs };
}

function readCustomFormNames(ctx: Ctx): Record<string, string> {
  const f = path.join(ctx.src, "data/pokemon-species.ts");
  if (!fs.existsSync(f)) return {};
  const sf = parseFile(f);
  const vd = findAll(sf, ts.isVariableDeclaration).find(d => d.name.getText(sf) === "CUSTOM_FORM_NAMES");
  if (!vd?.initializer) return {};
  const v = ctx.ev.eval(vd.initializer);
  return v.kind === "object" ? (v.value as Record<string, string>) : {};
}

export { short };
