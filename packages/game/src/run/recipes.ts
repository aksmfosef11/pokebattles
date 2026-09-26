import { cellKey, placeShape, rotateShape, shapeSize, touches, type Cell, type Placement } from "../board.ts";
import { findRecipe } from "../content/items.ts";
import { cellsOf, checkPlacement } from "./layout.ts";
import { pieceShape } from "./pokemon.ts";
import type { ItemPiece, Piece, RunState } from "./types.ts";

function placedItems(pieces: Record<string, Piece>): ItemPiece[] {
  return Object.values(pieces)
    .filter((p): p is ItemPiece => p.kind === "item" && p.place !== null)
    .sort((a, b) => (a.uid < b.uid ? -1 : 1));
}

/** The item `item` would combine with where it currently sits, if any. */
export function recipePartner(pieces: Record<string, Piece>, item: ItemPiece): { partner: ItemPiece; output: string } | null {
  if (!item.place || item.param) return null;
  const mine = cellsOf(item);
  for (const other of placedItems(pieces)) {
    if (other.uid === item.uid || other.param) continue;
    const recipe = findRecipe(item.item, other.item);
    if (recipe && touches(mine, cellsOf(other))) return { partner: other, output: recipe.output };
  }
  return null;
}

/**
 * Spot for the product: over the piece the player just moved if possible (so chains line up where
 * they are aiming), otherwise over as many of the ingredients' cells as possible.
 */
function productPlacement(pieces: Record<string, Piece>, product: ItemPiece, where: Cell[], prefer: Cell[]): Placement | null {
  const shape = pieceShape(product);
  const wanted = new Set(where.map(cellKey));
  const preferred = new Set(prefer.map(cellKey));
  const minX = Math.min(...where.map((c) => c.x));
  const maxX = Math.max(...where.map((c) => c.x));
  const minY = Math.min(...where.map((c) => c.y));
  const maxY = Math.max(...where.map((c) => c.y));
  let best: Placement | null = null;
  let bestScore = -1;
  for (const rot of [0, 1] as const) {
    const { w, h } = shapeSize(rotateShape(shape, rot));
    for (let y = minY - h + 1; y <= maxY; y++) {
      for (let x = minX - w + 1; x <= maxX; x++) {
        const place: Placement = { x, y, rot };
        if (checkPlacement(pieces, product, place) !== null) continue;
        const cells = placeShape(shape, place);
        const score = cells.filter((c) => preferred.has(cellKey(c))).length * 100 + cells.filter((c) => wanted.has(cellKey(c))).length;
        if (score > bestScore) {
          best = place;
          bestScore = score;
        }
      }
    }
  }
  return best;
}

/**
 * Merges touching recipe ingredients, starting with the pieces the player just placed, until no
 * pair is left (so Poké Ball + Poké Ball → Great Ball can chain into an Ultra Ball). The product
 * takes the ingredients' spot when it fits, otherwise it goes to the stash.
 */
export function resolveRecipes(state: RunState, focus: string[]): void {
  let first = focus;
  for (let guard = 0; guard < 16; guard++) {
    const candidates = [
      ...first.map((u) => state.pieces[u]).filter((p): p is ItemPiece => p?.kind === "item" && p.place !== null),
      ...placedItems(state.pieces),
    ];
    let match: { a: ItemPiece; b: ItemPiece; output: string } | null = null;
    for (const a of candidates) {
      const found = recipePartner(state.pieces, a);
      if (found) {
        match = { a, b: found.partner, output: found.output };
        break;
      }
    }
    if (!match) return;
    const { a, b, output } = match;
    const where = [...cellsOf(a), ...cellsOf(b)];
    const prefer = first.includes(a.uid) ? cellsOf(a) : first.includes(b.uid) ? cellsOf(b) : [];
    delete state.pieces[a.uid];
    delete state.pieces[b.uid];
    const product: ItemPiece = { uid: `u${state.nextUid++}`, kind: "item", place: null, paid: a.paid + b.paid, item: output, age: 0 };
    state.pieces[product.uid] = product;
    product.place = productPlacement(state.pieces, product, where, prefer);
    state.notices.push({ key: "notice.combined", params: { a: a.item, b: b.item, out: output } });
    first = [product.uid];
  }
}
