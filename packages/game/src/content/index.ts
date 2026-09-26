import raw from "../generated/content.json";
import { registerMegaStones, ITEMS, type Tier } from "./items.ts";
import type { Content, MoveDef, SpeciesDef, TypeKey } from "./schema.ts";

export const CONTENT = raw as unknown as Content;

registerMegaStones(
  Object.values(CONTENT.species).flatMap((s) =>
    s.megaForms.map((f) => ({ item: f.item, species: s.key, formKey: f.formKey })),
  ),
);

export function getSpecies(key: string): SpeciesDef {
  const s = CONTENT.species[key];
  if (!s) throw new Error(`unknown species ${key}`);
  return s;
}

export function getMove(key: string): MoveDef {
  const m = CONTENT.moves[key];
  if (!m) throw new Error(`unknown move ${key}`);
  return m;
}

let evolutionsByItem: Map<string, { from: string; to: string }[]> | null = null;

/** Every roster evolution an item triggers (evolution stones, Linking Cord), in dex order. */
export function itemEvolutions(item: string): readonly { from: string; to: string }[] {
  if (!evolutionsByItem) {
    evolutionsByItem = new Map();
    for (const s of Object.values(CONTENT.species).sort((a, b) => a.id - b.id)) {
      for (const e of s.evolutions) {
        if (!e.item) continue;
        const list = evolutionsByItem.get(e.item) ?? [];
        list.push({ from: s.key, to: e.to });
        evolutionsByItem.set(e.item, list);
      }
    }
  }
  return evolutionsByItem.get(item) ?? [];
}

export function typeEffectiveness(attack: TypeKey, defenders: readonly TypeKey[]): number {
  let mult = 1;
  for (const d of defenders) mult *= CONTENT.typeChart[attack][d];
  return mult;
}

export const SHOP_SPECIES_BY_TIER: Record<Tier, string[]> = { 1: [], 2: [], 3: [], 4: [], 5: [] };
for (const s of Object.values(CONTENT.species).sort((a, b) => a.id - b.id)) {
  if (s.shop) SHOP_SPECIES_BY_TIER[s.tier].push(s.key);
}

export { IMPLEMENTED_ABILITIES } from "../battle/abilities.ts";

export { ITEMS };
export * from "./schema.ts";
export * from "./items.ts";
export * from "./champions.ts";
