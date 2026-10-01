import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { BERRY_POUCH_SAVE_CHANCE, CANDY_JAR_EXTRA_LEVELS, COIN_CASE_EXTRA_GOLD, COIN_CASE_WIN_GOLD, CHOICE_BOOST, CHOICE_ITEMS, CONTENT, ITEMS, TIMED_ITEMS } from "@pokebattles/game";

type Dict = Record<string, unknown>;

interface Bundle {
  lang: string;
  species: Record<string, string>;
  forms: Record<string, string>;
  moves: Record<string, { name: string; effect?: string }>;
  abilities: Record<string, { name: string; description?: string }>;
  types: Record<string, string>;
  natures: Record<string, string>;
  stats: Record<string, { name: string; short?: string }>;
  items: Record<string, { name: string; description?: string }>;
  itemTemplates: Record<string, { name: string; description?: string }>;
  trainers: Record<string, string>;
  trainerTitles: Record<string, string>;
  zMoves: Record<string, string>;
  maxMoves: Record<string, string>;
  game: Dict;
}

export interface LangInfo {
  code: string;
  name: string;
  ui: boolean;
}

const STORAGE_KEY = "pokebattles.lang";

function storedLang(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function pickInitial(langs: LangInfo[]): string {
  const saved = storedLang();
  if (saved && langs.some((l) => l.code === saved)) return saved;
  for (const nav of navigator.languages ?? [navigator.language]) {
    const exact = langs.find((l) => l.code.toLowerCase() === nav.toLowerCase());
    if (exact) return exact.code;
    const base = langs.find((l) => l.code.split("-")[0] === nav.split("-")[0]);
    if (base) return base.code;
  }
  return "ko";
}

// ── Korean particles: PokéRogue writes "[[는]]" after a name; pick the form that fits the batchim.
const JOSA: [string, string][] = [
  ["은", "는"],
  ["이", "가"],
  ["을", "를"],
  ["과", "와"],
  ["으로", "로"],
  ["이라", "라"],
  ["아", "야"],
];

function batchim(ch: string): number {
  const code = ch.charCodeAt(0) - 0xac00;
  if (code < 0 || code > 11171) return /[013678]$/.test(ch) ? 1 : 0;
  return code % 28;
}

export function resolveJosa(text: string): string {
  return text.replace(/(.?)\[\[([가-힣]+)\]\]/g, (_m, prev: string, marker: string) => {
    const pair = JOSA.find(([a, b]) => a === marker || b === marker);
    if (!pair) return prev + marker;
    const b = prev ? batchim(prev) : 0;
    if (pair[0] === "으로") return prev + (b === 0 || b === 8 ? "로" : "으로");
    return prev + (b ? pair[0] : pair[1]);
  });
}

function interpolate(text: string, params?: Record<string, string | number>): string {
  const filled = params ? text.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => String(params[k] ?? "")) : text;
  return resolveJosa(filled);
}

export class Translator {
  constructor(readonly b: Bundle) {}

  t = (path: string, params?: Record<string, string | number>): string => {
    let cur: unknown = this.b.game;
    for (const part of path.split(".")) {
      if (!cur || typeof cur !== "object") return path;
      cur = (cur as Dict)[part];
    }
    return typeof cur === "string" ? interpolate(cur, params) : path;
  };

  has = (path: string): boolean => this.t(path) !== path;

  species = (key: string): string => this.b.species[key] ?? key;

  form = (key: string, formKey: string): string => (formKey ? (this.b.forms[`${key}:${formKey}`] ?? this.species(key)) : this.species(key));

  move = (key: string): string => this.b.moves[key]?.name ?? this.b.zMoves[key] ?? this.b.maxMoves[key] ?? key;

  moveEffect = (key: string): string => resolveJosa(this.b.moves[key]?.effect ?? "");

  ability = (key: string): string => this.b.abilities[key]?.name ?? key;

  abilityDesc = (key: string): string => resolveJosa(this.b.abilities[key]?.description ?? "");

  type = (type: string): string => this.b.types[type] ?? type;

  nature = (n: string): string => this.b.natures[n] ?? n;

  stat = (k: "hp" | "atk" | "def" | "spa" | "spd" | "spe"): string => {
    const map = { hp: "HP", atk: "ATK", def: "DEF", spa: "SPATK", spd: "SPDEF", spe: "SPD" } as const;
    const s = this.b.stats[map[k]];
    return s?.short ?? s?.name ?? k;
  };

  trainer = (key: string): string => this.b.trainers[key] ?? key;

  championTitle = (): string => this.b.trainerTitles.champion ?? this.t("ui.champion");

  itemName = (key: string, param?: string): string => {
    if (key === "TERA_SHARD" && param) return this.b.items[`${param.toUpperCase()}_TERA_SHARD`]?.name ?? `${this.type(param)} ✦`;
    if (key === "TM" && param) {
      const tpl = this.b.itemTemplates.TM?.name ?? "TM {{moveName}}";
      const id = CONTENT.moves[param] ? String((CONTENT.moves[param] as { id?: number | null }).id ?? "") : "";
      return interpolate(tpl, { moveId: id.padStart(3, "0"), moveName: this.move(param) });
    }
    // PokéRogue names mints "{{natureName}} Mint"; a start-item Mint before its nature is known is just "Mint".
    if (key === "MINT") return interpolate(this.b.itemTemplates.MINT?.name ?? "{{natureName}} Mint", { natureName: param ? this.nature(param) : "" }).trim();
    // Bags named after real items (Berry Pouch, Candy Jar, Coin Case) only have a description here.
    const bag = (this.b.game.bag as Record<string, { name?: string }> | undefined)?.[key];
    if (bag?.name) return bag.name;
    return this.b.items[key]?.name ?? key;
  };

  itemFlavor = (key: string): string => resolveJosa(this.b.items[key]?.description ?? "");

  /** Patch notes, newest first (game locale `patchNotes.entries`). */
  patchNotes = (): { date: string; items: string[] }[] => {
    const notes = this.b.game.patchNotes as { entries?: { date: string; items: string[] }[] } | undefined;
    return Array.isArray(notes?.entries) ? notes.entries : [];
  };

  /** Rules text for an item in this game (not PokéRogue's flavor text). */
  itemEffect = (key: string, param?: string): string => {
    const def = ITEMS[key];
    const bag = (this.b.game.bag as Record<string, { desc: string }> | undefined)?.[key];
    if (bag) {
      const names = Object.fromEntries(
        ["RARE_CANDY", "RARER_CANDY", "AMULET_COIN", "LUCK_INCENSE", "NUGGET", "BIG_NUGGET"].map((k) => [k, this.itemName(k)]),
      );
      return this.t(`bag.${key}.desc`, {
        ...names,
        pct: Math.round(BERRY_POUCH_SAVE_CHANCE * 100),
        levels: CANDY_JAR_EXTRA_LEVELS,
        gold: COIN_CASE_EXTRA_GOLD,
        winGold: COIN_CASE_WIN_GOLD,
      });
    }
    if (!def) return "";
    if (def.family === "typeBoost" && def.type) return this.t("itemEffect.TYPE_BOOST", { type: this.type(def.type) });
    if (def.family === "zCrystal" && def.type) return this.t("itemEffect.Z_CRYSTAL", { type: this.type(def.type) });
    if (def.family === "plate" && def.type) return this.t("itemEffect.PLATE", { type: this.type(def.type) });
    if (def.family === "berry" && def.type) {
      return key === "CHILAN_BERRY" ? this.t("itemEffect.CHILAN_BERRY") : this.t("itemEffect.RESIST_BERRY", { type: this.type(def.type) });
    }
    if (def.family === "evolution" && key !== "LINKING_CORD") return this.t("itemEffect.EVOLUTION_STONE");
    if (def.mega) return this.t("itemEffect.MEGA_STONE", { species: this.species(def.mega.species) });
    if (key === "TERA_SHARD") {
      return param === "stellar" ? this.t("itemEffect.TERA_SHARD_STELLAR") : this.t("itemEffect.TERA_SHARD", { type: this.type(param ?? "") });
    }
    if (key === "TM") return this.t("itemEffect.TM", { move: this.move(param ?? "") });
    if (key === "MINT") return param ? this.t("itemEffect.MINT", { nature: this.nature(param) }) : this.t("itemEffect.MINT_RANDOM");
    if (key in CHOICE_ITEMS) return this.t(`itemEffect.${key}`, { mult: CHOICE_BOOST });
    const timed = TIMED_ITEMS[key];
    if (timed) return this.t(`itemEffect.${key}`, { sec: timed.every, uses: timed.uses, ...("heal" in timed ? { pct: Math.round(timed.heal * 100) } : {}) });
    if (def.forAbilities) return this.t(`itemEffect.${key}`, { abilities: def.forAbilities.map(this.ability).join("·") });
    return this.t(`itemEffect.${key}`);
  };
}

interface I18nValue {
  tr: Translator;
  lang: string;
  langs: LangInfo[];
  setLang: (code: string) => void;
}

const I18nContext = createContext<I18nValue | null>(null);

const bundleCache = new Map<string, Bundle>();
async function loadBundle(code: string): Promise<Bundle> {
  const hit = bundleCache.get(code);
  if (hit) return hit;
  const res = await fetch(`/locales/${code}.json`);
  const b = (await res.json()) as Bundle;
  bundleCache.set(code, b);
  return b;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [langs, setLangs] = useState<LangInfo[]>([]);
  const [lang, setLangState] = useState<string | null>(null);
  const [bundle, setBundle] = useState<Bundle | null>(null);

  useEffect(() => {
    fetch("/locales/index.json")
      .then((r) => r.json() as Promise<LangInfo[]>)
      .then((list) => {
        setLangs(list);
        setLangState(pickInitial(list));
      })
      .catch(() => setLangState("ko"));
  }, []);

  useEffect(() => {
    if (!lang) return;
    let alive = true;
    loadBundle(lang).then((b) => {
      if (!alive) return;
      setBundle(b);
      document.documentElement.lang = lang;
    });
    return () => {
      alive = false;
    };
  }, [lang]);

  const value = useMemo<I18nValue | null>(() => {
    if (!bundle || !lang) return null;
    return {
      tr: new Translator(bundle),
      lang,
      langs,
      setLang: (code) => {
        try {
          localStorage.setItem(STORAGE_KEY, code);
        } catch {
          /* private mode */
        }
        setLangState(code);
      },
    };
  }, [bundle, lang, langs]);

  if (!value) return <div className="boot">…</div>;
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const v = useContext(I18nContext);
  if (!v) throw new Error("useI18n outside provider");
  return v;
}
