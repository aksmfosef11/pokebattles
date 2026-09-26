import { BOARD_H, BOARD_W, cellKey, inBoard, neighbours, placeShape, rotateShape, shapeSize, type Cell, type Placement } from "../board.ts";
import { itemReach, itemSize, type Reach } from "../content/items.ts";
import { pieceShape } from "./pokemon.ts";
import type { ItemPiece, Piece, PokemonPiece } from "./types.ts";

export interface Layout {
  /** Cells covered by a bag. */
  usable: Set<number>;
  /** Cell → uid of the Pokémon or item occupying it. */
  occupant: Map<number, string>;
  /** Cell → uid of the bag covering it. */
  bagAt: Map<number, string>;
  /** uid → occupied cells for placed Pokémon and items. */
  cells: Map<string, Cell[]>;
}

export function cellsOf(piece: Piece): Cell[] {
  if (!piece.place) return [];
  return placeShape(pieceShape(piece), piece.place);
}

export function computeLayout(pieces: Iterable<Piece>, ignoreUid?: string): Layout {
  const usable = new Set<number>();
  const occupant = new Map<number, string>();
  const bagAt = new Map<number, string>();
  const cells = new Map<string, Cell[]>();
  const list = [...pieces];
  for (const p of list) {
    if (p.kind !== "bag" || !p.place || p.uid === ignoreUid) continue;
    for (const c of cellsOf(p)) {
      usable.add(cellKey(c));
      bagAt.set(cellKey(c), p.uid);
    }
  }
  for (const p of list) {
    if (p.kind === "bag" || !p.place || p.uid === ignoreUid) continue;
    const cs = cellsOf(p);
    cells.set(p.uid, cs);
    for (const c of cs) occupant.set(cellKey(c), p.uid);
  }
  return { usable, occupant, bagAt, cells };
}

export type PlacementError = "out_of_board" | "no_bag" | "occupied" | "bag_overlap";

/**
 * Checks whether `piece` can sit at `place`, ignoring its own current position. A bag only needs
 * free board space: whatever sits on it moves with it (see `bagContents`).
 */
export function checkPlacement(pieces: Record<string, Piece>, piece: Piece, place: Placement): PlacementError | null {
  const target = placeShape(pieceShape(piece), place);
  if (target.some((c) => !inBoard(c))) return "out_of_board";
  const layout = computeLayout(Object.values(pieces), piece.uid);
  if (piece.kind === "bag") {
    if (target.some((c) => layout.bagAt.has(cellKey(c)))) return "bag_overlap";
    return null;
  }
  for (const c of target) {
    const k = cellKey(c);
    if (!layout.usable.has(k)) return "no_bag";
    if (layout.occupant.has(k)) return "occupied";
  }
  return null;
}

export function bagHasContents(pieces: Record<string, Piece>, bag: Piece): boolean {
  const { inside, straddling } = bagContents(pieces, bag);
  return inside.length > 0 || straddling.length > 0;
}

/** Pieces lying entirely on `bag` (they travel with it) and pieces that also rest on another bag. */
export function bagContents(pieces: Record<string, Piece>, bag: Piece): { inside: Piece[]; straddling: Piece[] } {
  const inside: Piece[] = [];
  const straddling: Piece[] = [];
  if (bag.kind !== "bag" || !bag.place) return { inside, straddling };
  const own = new Set(cellsOf(bag).map(cellKey));
  for (const p of Object.values(pieces)) {
    if (p.kind === "bag" || !p.place) continue;
    const cs = cellsOf(p).map(cellKey);
    const on = cs.filter((k) => own.has(k)).length;
    if (on === cs.length) inside.push(p);
    else if (on > 0) straddling.push(p);
  }
  inside.sort((a, b) => (a.uid < b.uid ? -1 : 1));
  return { inside, straddling };
}

export interface Adjacency {
  /** Pokémon uid → adjacent item pieces. */
  itemsOf: Map<string, ItemPiece[]>;
  /** Pokémon uid → adjacent Pokémon uids. */
  alliesOf: Map<string, string[]>;
  /** Item uid → adjacent Pokémon uids. */
  holdersOf: Map<string, string[]>;
  /** Pokémon uid → bag uids its cells sit on. */
  bagsOf: Map<string, string[]>;
  /** Item uid → key of the bag it lies entirely on (Berry Pouch, Candy Jar and Coin Case work on these items). */
  bagUnder: Map<string, string>;
  /** Pokémon uid → free usable cells next to it. */
  freeNeighbours: Map<string, Cell[]>;
}

const DIRECTION: Record<Placement["rot"], Cell> = { 0: { x: 0, y: -1 }, 1: { x: 1, y: 0 }, 2: { x: 0, y: 1 }, 3: { x: -1, y: 0 } };

/** Board cells an item with `reach` covers when its own cells are `own` and it is turned `rot`. */
export function reachCells(own: Cell[], reach: Reach, rot: Placement["rot"]): Cell[] {
  const mine = new Set(own.map(cellKey));
  const out = new Map<number, Cell>();
  const add = (c: Cell) => {
    const k = cellKey(c);
    if (inBoard(c) && !mine.has(k)) out.set(k, c);
  };
  const orthogonal = new Set(neighbours(own).map(cellKey));
  const d = DIRECTION[rot];
  switch (reach) {
    case "adjacent":
      for (const c of neighbours(own)) add(c);
      break;
    case "around":
      for (const c of own) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) add({ x: c.x + dx, y: c.y + dy });
      break;
    case "diagonal":
      for (const c of own) {
        for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
          const n = { x: c.x + dx, y: c.y + dy };
          if (!orthogonal.has(cellKey(n))) add(n);
        }
      }
      break;
    case "front":
      for (const c of own) add({ x: c.x + d.x, y: c.y + d.y });
      break;
    case "line":
      for (const c of own) for (let k = 1; k <= 3; k++) add({ x: c.x + d.x * k, y: c.y + d.y * k });
      break;
    case "row": {
      const horizontal = rot % 2 === 0;
      const lines = new Set(own.map((c) => (horizontal ? c.y : c.x)));
      for (let y = 0; y < BOARD_H; y++) {
        for (let x = 0; x < BOARD_W; x++) if (lines.has(horizontal ? y : x)) add({ x, y });
      }
      break;
    }
  }
  return [...out.values()].sort((a, b) => a.y - b.y || a.x - b.x);
}

/** Cells a placed item affects. */
export function itemReachCells(item: ItemPiece): Cell[] {
  if (!item.place) return [];
  return reachCells(cellsOf(item), itemReach(item.item), item.place.rot);
}

export function computeAdjacency(pieces: Record<string, Piece>): Adjacency {
  const list = Object.values(pieces);
  const layout = computeLayout(list);
  const itemsOf = new Map<string, ItemPiece[]>();
  const alliesOf = new Map<string, string[]>();
  const holdersOf = new Map<string, string[]>();
  const bagsOf = new Map<string, string[]>();
  const freeNeighbours = new Map<string, Cell[]>();
  const placedMons = list.filter((p): p is PokemonPiece => p.kind === "pokemon" && p.place !== null);
  const placedItems = list
    .filter((p): p is ItemPiece => p.kind === "item" && p.place !== null)
    .sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));
  const reaches = new Map(placedItems.map((it) => [it.uid, new Set(itemReachCells(it).map(cellKey))]));
  for (const mon of placedMons) {
    const own = layout.cells.get(mon.uid) ?? [];
    const ownKeys = own.map(cellKey);
    const items = placedItems.filter((it) => ownKeys.some((k) => reaches.get(it.uid)!.has(k)));
    const allies: string[] = [];
    const free: Cell[] = [];
    for (const n of neighbours(own)) {
      const k = cellKey(n);
      const occ = layout.occupant.get(k);
      if (!occ) {
        if (layout.usable.has(k)) free.push(n);
        continue;
      }
      const other = pieces[occ]!;
      if (other.kind === "pokemon" && !allies.includes(other.uid)) allies.push(other.uid);
    }
    allies.sort();
    itemsOf.set(mon.uid, items);
    alliesOf.set(mon.uid, allies);
    freeNeighbours.set(mon.uid, free);
    for (const it of items) {
      const holders = holdersOf.get(it.uid) ?? [];
      holders.push(mon.uid);
      holdersOf.set(it.uid, holders);
    }
    const bags = new Set<string>();
    for (const c of own) {
      const b = layout.bagAt.get(cellKey(c));
      if (b) bags.add(b);
    }
    bagsOf.set(mon.uid, [...bags].sort());
  }
  for (const list of holdersOf.values()) list.sort();
  const bagUnder = new Map<string, string>();
  for (const it of placedItems) {
    const under = new Set((layout.cells.get(it.uid) ?? []).map((c) => layout.bagAt.get(cellKey(c))));
    const [bagUid] = under;
    const bag = under.size === 1 && bagUid ? pieces[bagUid] : undefined;
    if (bag?.kind === "bag") bagUnder.set(it.uid, bag.bag);
  }
  return { itemsOf, alliesOf, holdersOf, bagsOf, bagUnder, freeNeighbours };
}

/** First free placement for a piece, scanning front rows first (used for spawns and evolutions). */
export function findFreePlacement(pieces: Record<string, Piece>, piece: Piece, prefer?: Placement): Placement | null {
  const tries: Placement[] = [];
  if (prefer) {
    tries.push(prefer, { ...prefer, rot: ((prefer.rot + 1) % 4) as Placement["rot"] });
  }
  for (let y = 0; y < BOARD_H; y++) for (let x = 0; x < BOARD_W; x++) for (const rot of [0, 1] as const) tries.push({ x, y, rot });
  for (const t of tries) if (checkPlacement(pieces, piece, t) === null) return t;
  return null;
}

export type DropPlan =
  | { ok: true; displaced?: { uid: string; to: Placement | null } }
  | { ok: false; error: PlacementError | "stash_full" };

/**
 * What happens when `piece` is dropped at `place` (Backpack Battles style): if exactly one other
 * piece is in the way, it swaps into the dropped piece's old spot. An item that does not fit there
 * goes to the stash; a Pokémon never gets pushed out of the party, so that drop is refused.
 * Used by the reducer and by the client's drop preview.
 */
export function planDrop(pieces: Record<string, Piece>, piece: Piece, place: Placement, stashHasRoom: boolean): DropPlan {
  const err = checkPlacement(pieces, piece, place);
  if (!err) return { ok: true };
  if (err !== "occupied" || piece.kind === "bag") return { ok: false, error: err };
  const layout = computeLayout(Object.values(pieces), piece.uid);
  const target = placeShape(pieceShape(piece), place);
  const blockers = new Set<string>();
  for (const c of target) {
    const occ = layout.occupant.get(cellKey(c));
    if (occ) blockers.add(occ);
  }
  if (blockers.size !== 1) return { ok: false, error: "occupied" };
  const other = pieces[[...blockers][0]!]!;
  const without = { ...pieces };
  delete without[other.uid];
  const fits = checkPlacement(without, piece, place);
  if (fits) return { ok: false, error: fits };
  if (piece.place && other.place) {
    const after = { ...without, [piece.uid]: { ...piece, place } as Piece };
    const from = piece.place;
    for (const rot of [other.place.rot, ((other.place.rot + 1) % 4) as Placement["rot"]]) {
      const cand: Placement = { x: from.x, y: from.y, rot };
      if (checkPlacement(after, other, cand) === null) return { ok: true, displaced: { uid: other.uid, to: cand } };
    }
  }
  if (other.kind === "pokemon") return { ok: false, error: "occupied" };
  if (!stashHasRoom) return { ok: false, error: "stash_full" };
  return { ok: true, displaced: { uid: other.uid, to: null } };
}

export interface Claim {
  place: Placement;
  /** Items that sit where the piece will go; the caller moves them to the stash. */
  displaced: string[];
}

/**
 * Where a Pokémon that grew (evolution) or no longer fits should go. Placements that keep covering
 * its current top-left cell come first, then anything on the bags. It may land on items (they are
 * moved out) but never on another Pokémon. The fewest displaced items wins; ties keep scan order.
 */
export function claimPlacement(pieces: Record<string, Piece>, piece: Piece, around: Placement | null): Claim | null {
  const shape = pieceShape(piece);
  const layout = computeLayout(Object.values(pieces), piece.uid);
  const pick = (candidates: Placement[]): Claim | null => {
    let best: Claim | null = null;
    for (const place of candidates) {
      const cells = placeShape(shape, place);
      if (cells.some((c) => !inBoard(c) || !layout.usable.has(cellKey(c)))) continue;
      const displaced = new Set<string>();
      let blocked = false;
      for (const c of cells) {
        const occ = layout.occupant.get(cellKey(c));
        if (!occ) continue;
        if (pieces[occ]?.kind === "pokemon") blocked = true;
        displaced.add(occ);
      }
      if (blocked) continue;
      if (!best || displaced.size < best.displaced.length) best = { place, displaced: [...displaced].sort() };
      if (best.displaced.length === 0) break;
    }
    return best;
  };
  const local: Placement[] = [];
  if (around) {
    for (const rot of [around.rot, ((around.rot + 1) % 4) as Placement["rot"]]) {
      const { w, h } = shapeSize(rotateShape(shape, rot));
      for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) local.push({ x: around.x - dx, y: around.y - dy, rot });
    }
  }
  const everywhere: Placement[] = [];
  for (let y = 0; y < BOARD_H; y++) for (let x = 0; x < BOARD_W; x++) for (const rot of [0, 1] as const) everywhere.push({ x, y, rot });
  return pick(local) ?? pick(everywhere);
}

/** True when every placed Pokémon and item sits on bags without overlapping anything. */
export function layoutIsValid(pieces: Record<string, Piece>): boolean {
  return Object.values(pieces).every((p) => p.kind === "bag" || !p.place || checkPlacement(pieces, p, p.place) === null);
}

/**
 * Fixes boards that became invalid (e.g. a footprint changed between versions): Pokémon keep or
 * claim a spot first, then items that no longer fit go to the stash. Returns the stashed item uids.
 */
export function repairLayout(pieces: Record<string, Piece>): string[] {
  const all = Object.values(pieces).sort((a, b) => (a.uid < b.uid ? -1 : 1));
  const kept: Record<string, Piece> = {};
  for (const p of all) if (p.kind === "bag" && p.place) kept[p.uid] = p;
  for (const p of all) {
    if (p.kind !== "pokemon" || !p.place) continue;
    if (checkPlacement(kept, p, p.place) !== null) p.place = claimPlacement(kept, p, p.place)?.place ?? null;
    kept[p.uid] = p;
  }
  const stashed: string[] = [];
  for (const p of all) {
    if (p.kind !== "item" || !p.place) continue;
    if (checkPlacement(kept, p, p.place) !== null) {
      p.place = null;
      stashed.push(p.uid);
    }
    kept[p.uid] = p;
  }
  return stashed;
}
