import { useEffect, useRef, useState } from "react";
import { BAGS, CONTENT, natureEffect, NATURES, type Nature } from "@pokebattles/game";
import { getItemManifest, loadAtlas, loadImageCached, pokemonSpritePath, subscribeClock, type Atlas } from "../assets.ts";
import { useI18n } from "../i18n.tsx";

/** Ticks of the 12 fps clock per breath of a still sprite. */
const BREATH_TICKS = 22;
/** How far a still sprite squashes at the bottom of a breath. */
const BREATH_DEPTH = 0.035;

function drawFrame(ctx: CanvasRenderingContext2D, atlas: Atlas, index: number, scale: number, boxW: number, boxH: number, valign: SpriteVAlign, squash = 0) {
  const f = atlas.frames[index % Math.max(1, atlas.frames.length)];
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  if (!f) return;
  // Anchor the untrimmed source box at the bottom centre (or the middle) of the canvas.
  const left = Math.round((boxW - f.sw * scale) / 2);
  const top = Math.round(valign === "middle" ? (boxH - f.sh * scale) / 2 : boxH - f.sh * scale);
  ctx.save();
  if (squash) {
    // Squash towards the sprite's feet so it never grows past the box.
    const feet = top + f.sh * scale;
    ctx.translate(0, feet);
    ctx.scale(1, 1 - squash);
    ctx.translate(0, -feet);
  }
  ctx.drawImage(atlas.image, f.x, f.y, f.w, f.h, left + f.ox * scale, top + f.oy * scale, f.w * scale, f.h * scale);
  ctx.restore();
}

export type SpriteVAlign = "bottom" | "middle";

interface AtlasCanvasProps {
  path: string | null;
  /** Box the sprite must fit in (CSS px). */
  width: number;
  height: number;
  /** Upper bound on the scale factor. */
  maxScale?: number;
  animate?: boolean;
  /** "middle" centres the sprite in a box taller than it, e.g. a Pokémon turned upright on the board. */
  valign?: SpriteVAlign;
  className?: string;
  flip?: boolean;
}

export function AtlasCanvas({ path, width, height, maxScale = 3, animate = true, valign = "bottom", className, flip }: AtlasCanvasProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [atlas, setAtlas] = useState<Atlas | null>(null);

  useEffect(() => {
    let alive = true;
    setAtlas(null);
    if (path) loadAtlas(path).then((a) => alive && setAtlas(a)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [path]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !atlas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const scale = Math.min(maxScale, width / Math.max(1, atlas.width), height / Math.max(1, atlas.height));
    let i = 0;
    drawFrame(ctx, atlas, i, scale, width, height, valign);
    if (!animate) return;
    if (atlas.frames.length < 2) {
      // PokéRogue has no animation for this sprite (mostly megas, gigantamax forms and some trainers): breathe
      // instead, each sprite from its own phase so a board of them does not pulse in unison.
      let t = Math.floor(Math.random() * BREATH_TICKS);
      return subscribeClock(() => {
        t++;
        const squash = (BREATH_DEPTH * (1 - Math.cos((2 * Math.PI * t) / BREATH_TICKS))) / 2;
        drawFrame(ctx, atlas, 0, scale, width, height, valign, squash);
      });
    }
    return subscribeClock(() => {
      i++;
      drawFrame(ctx, atlas, i, scale, width, height, valign);
    });
  }, [atlas, width, height, maxScale, animate, valign]);

  return (
    <canvas
      ref={ref}
      className={className}
      style={{ width, height, transform: flip ? "scaleX(-1)" : undefined, imageRendering: "pixelated" }}
    />
  );
}

interface PokemonSpriteProps {
  species: string;
  formKey?: string;
  back?: boolean;
  shiny?: boolean;
  width: number;
  height: number;
  maxScale?: number;
  animate?: boolean;
  valign?: SpriteVAlign;
  className?: string;
}

export function PokemonSprite({ species, formKey = "", back = false, shiny = false, ...rest }: PokemonSpriteProps) {
  const [path, setPath] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    pokemonSpritePath(species, formKey, back, shiny).then((p) => alive && setPath(p));
    return () => {
      alive = false;
    };
  }, [species, formKey, back, shiny]);
  return <AtlasCanvas path={path} {...rest} />;
}

export function TrainerSprite({ champion, width, height, className }: { champion: string; width: number; height: number; className?: string }) {
  return <AtlasCanvas path={`trainers/${champion}`} width={width} height={height} maxScale={4} className={className} />;
}

/** PokéRogue's mint icons are coloured by the stat the nature raises. */
function mintFrame(nature: string | undefined): string {
  const up = NATURES.includes(nature as Nature) ? natureEffect(nature as Nature).up : null;
  const frames = { atk: "mint_atk", def: "mint_def", spa: "mint_spatk", spd: "mint_spdef", spe: "mint_spd" } as const;
  return up && up !== "hp" ? frames[up] : "mint_neutral";
}

export function ItemIcon({ item, param, size = 32, className }: { item: string; param?: string; size?: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      const manifest = await getItemManifest();
      let key = item;
      if (item === "TERA_SHARD" && param) key = `${param.toUpperCase()}_TERA_SHARD`;
      let ref2 = manifest[key];
      if (item === "TM") ref2 = { atlas: "items", frame: `tm_${(param && CONTENT.moves[param]?.type) || "normal"}` };
      if (item === "MINT") ref2 = { atlas: "items", frame: mintFrame(param) };
      const canvas = ref.current;
      if (!alive || !canvas || !ref2) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = size * dpr;
      canvas.height = size * dpr;
      const ctx = canvas.getContext("2d")!;
      ctx.imageSmoothingEnabled = false;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if ("file" in ref2) {
        const img = await loadImageCached(ref2.file);
        if (!alive) return;
        const s = Math.min(size / img.width, size / img.height);
        ctx.drawImage(img, (size - img.width * s) / 2, (size - img.height * s) / 2, img.width * s, img.height * s);
        return;
      }
      const atlas = await loadAtlas(ref2.atlas);
      const f = atlas.byName.get(ref2.frame);
      if (!alive || !f) return;
      const s = size / Math.max(f.sw, f.sh);
      ctx.drawImage(atlas.image, f.x, f.y, f.w, f.h, (f.ox + (Math.max(f.sw, f.sh) - f.sw) / 2) * s, (f.oy + (Math.max(f.sw, f.sh) - f.sh) / 2) * s, f.w * s, f.h * s);
    })().catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [item, param, size]);
  return <canvas ref={ref} className={className} style={{ width: size, height: size, imageRendering: "pixelated" }} />;
}

/** PokéRogue's localized type label sprites; falls back to text. */
export function TypeBadge({ type, scale = 2 }: { type: string; scale?: number }) {
  const { lang, tr } = useI18n();
  const ref = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setFailed(false);
    const tryPaths = [`types/types_${lang}`, `types/types_${lang.split("-")[0]}`, "types/types"];
    (async () => {
      for (const p of tryPaths) {
        try {
          const atlas = await loadAtlas(p);
          const f = atlas.byName.get(type);
          const canvas = ref.current;
          if (!alive || !canvas || !f) continue;
          const dpr = window.devicePixelRatio || 1;
          canvas.width = f.sw * scale * dpr;
          canvas.height = f.sh * scale * dpr;
          canvas.style.width = `${f.sw * scale}px`;
          canvas.style.height = `${f.sh * scale}px`;
          const ctx = canvas.getContext("2d")!;
          ctx.imageSmoothingEnabled = false;
          ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
          ctx.drawImage(atlas.image, f.x, f.y, f.w, f.h, f.ox, f.oy, f.w, f.h);
          return;
        } catch {
          /* try next */
        }
      }
      if (alive) setFailed(true);
    })();
    return () => {
      alive = false;
    };
  }, [type, lang, scale]);
  if (failed) return <span className={`type-text type-${type}`}>{tr.type(type)}</span>;
  return <canvas ref={ref} className="type-badge" title={tr.type(type)} style={{ imageRendering: "pixelated" }} />;
}

/** A bag: bags named after real items (Berry Pouch, Candy Jar, Coin Case) show that item's icon, the rest a leather swatch. */
export function BagIcon({ bag, size = 40 }: { bag: string; size?: number }) {
  if (BAGS[bag]?.realItem) return <ItemIcon item={bag} size={size} />;
  return <div className="bag-icon" style={{ width: size, height: size }} />;
}
