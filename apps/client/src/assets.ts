/** Loading of PokéRogue TexturePacker atlases and the asset manifests written by tools/extract. */

export interface AtlasFrame {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Offset of the trimmed frame inside the untrimmed source. */
  ox: number;
  oy: number;
  /** Untrimmed source size. */
  sw: number;
  sh: number;
}

export interface Atlas {
  image: HTMLImageElement;
  frames: AtlasFrame[];
  byName: Map<string, AtlasFrame>;
  width: number;
  height: number;
}

interface RawFrame {
  filename: string;
  frame: { x: number; y: number; w: number; h: number };
  spriteSourceSize: { x: number; y: number; w: number; h: number };
  sourceSize: { w: number; h: number };
}

const atlasCache = new Map<string, Promise<Atlas>>();

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`image ${src}`));
    img.src = src;
  });
}

/** `path` is relative to /assets and has no extension (as in the manifests). */
export function loadAtlas(path: string): Promise<Atlas> {
  let p = atlasCache.get(path);
  if (!p) {
    p = (async () => {
      const [json, image] = await Promise.all([
        fetch(`/assets/${path}.json`).then((r) => r.json() as Promise<{ textures?: { frames: RawFrame[] }[]; frames?: RawFrame[] }>),
        loadImage(`/assets/${path}.png`),
      ]);
      const raw = json.textures?.[0]?.frames ?? json.frames ?? [];
      const frames = raw
        .map((f) => ({
          name: f.filename,
          x: f.frame.x,
          y: f.frame.y,
          w: f.frame.w,
          h: f.frame.h,
          ox: f.spriteSourceSize.x,
          oy: f.spriteSourceSize.y,
          sw: f.sourceSize.w,
          sh: f.sourceSize.h,
        }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      let width = 0;
      let height = 0;
      for (const f of frames) {
        width = Math.max(width, f.sw);
        height = Math.max(height, f.sh);
      }
      return { image, frames, byName: new Map(frames.map((f) => [f.name, f])), width, height };
    })();
    atlasCache.set(path, p);
  }
  return p;
}

export function loadImageCached(path: string): Promise<HTMLImageElement> {
  const key = `img:${path}`;
  let p = atlasCache.get(key) as unknown as Promise<HTMLImageElement> | undefined;
  if (!p) {
    p = loadImage(`/assets/${path}`);
    atlasCache.set(key, p as unknown as Promise<Atlas>);
  }
  return p;
}

interface PokemonManifest {
  [species: string]: {
    id: number;
    forms: Record<string, { front: string | null; back: string | null; frontShiny: string | null; backShiny: string | null }>;
  };
}

export type ItemIconRef = { atlas: string; frame: string } | { file: string } | null;

let pokemonManifest: Promise<PokemonManifest> | null = null;
let itemManifest: Promise<Record<string, ItemIconRef>> | null = null;

export function getPokemonManifest(): Promise<PokemonManifest> {
  pokemonManifest ??= fetch("/assets/pokemon/manifest.json").then((r) => r.json() as Promise<PokemonManifest>);
  return pokemonManifest;
}

export function getItemManifest(): Promise<Record<string, ItemIconRef>> {
  itemManifest ??= fetch("/assets/items-manifest.json").then((r) => r.json() as Promise<Record<string, ItemIconRef>>);
  return itemManifest;
}

export async function pokemonSpritePath(species: string, formKey: string, back: boolean, shiny: boolean): Promise<string | null> {
  const m = (await getPokemonManifest())[species];
  if (!m) return null;
  const form = m.forms[formKey] ?? Object.values(m.forms)[0];
  if (!form) return null;
  const pick = back ? (shiny ? form.backShiny : form.back) : shiny ? form.frontShiny : form.front;
  return pick ?? form.front;
}

export interface SpriteRef {
  species: string;
  formKey: string;
  back: boolean;
  shiny: boolean;
}

/**
 * Fetches the given Pokémon atlases in parallel (only these: sprites are never bulk-loaded).
 * Resolves once all are ready, or after `timeoutMs` so a slow connection never blocks the game.
 */
export async function preloadPokemonSprites(refs: SpriteRef[], timeoutMs = 4000): Promise<void> {
  const unique = new Map(refs.map((r) => [`${r.species}|${r.formKey}|${r.back}|${r.shiny}`, r]));
  const jobs = [...unique.values()].map(async (r) => {
    const path = await pokemonSpritePath(r.species, r.formKey, r.back, r.shiny);
    if (path) await loadAtlas(path);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([Promise.allSettled(jobs).then(() => undefined), timeout]);
  clearTimeout(timer);
}

// ── One shared animation clock (12 fps) for every sprite on screen.
type Tick = (frame: number) => void;
const subscribers = new Set<Tick>();
let rafId = 0;
let frame = 0;
let last = 0;

function loop(now: number) {
  if (now - last >= 1000 / 12) {
    last = now;
    frame++;
    for (const cb of subscribers) cb(frame);
  }
  rafId = subscribers.size > 0 ? requestAnimationFrame(loop) : 0;
}

export function subscribeClock(cb: Tick): () => void {
  subscribers.add(cb);
  if (!rafId) rafId = requestAnimationFrame(loop);
  return () => {
    subscribers.delete(cb);
  };
}
