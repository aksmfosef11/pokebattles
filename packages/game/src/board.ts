/**
 * Board geometry. The board is 9×7; row 0 faces the enemy. Pieces are placed on cells covered
 * by a bag. Every bag, including the 3×3 starting bag, can be moved and rotated, and carries the
 * pieces sitting on it. Items affect Pokémon that touch them orthogonally.
 */

export const BOARD_W = 9;
export const BOARD_H = 6;
/** Where the starting bag is placed in a new run. */
export const START_BAG_PLACE: Placement = { x: 3, y: 2, rot: 0 };

export type Rot = 0 | 1 | 2 | 3;

export interface Cell {
  x: number;
  y: number;
}

export interface Placement {
  x: number;
  y: number;
  rot: Rot;
}

export function cellKey(c: Cell): number {
  return c.y * BOARD_W + c.x;
}

export function cellFromKey(k: number): Cell {
  return { x: k % BOARD_W, y: Math.floor(k / BOARD_W) };
}

export function inBoard(c: Cell): boolean {
  return c.x >= 0 && c.y >= 0 && c.x < BOARD_W && c.y < BOARD_H;
}

export function rectShape(w: number, h: number): Cell[] {
  const cells: Cell[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) cells.push({ x, y });
  return cells;
}

function normalize(cells: Cell[]): Cell[] {
  let minX = Infinity;
  let minY = Infinity;
  for (const c of cells) {
    minX = Math.min(minX, c.x);
    minY = Math.min(minY, c.y);
  }
  return cells.map((c) => ({ x: c.x - minX, y: c.y - minY })).sort((a, b) => a.y - b.y || a.x - b.x);
}

/** Rotates a shape clockwise `rot` quarter turns and re-anchors it at (0,0). */
export function rotateShape(cells: Cell[], rot: Rot): Cell[] {
  let out = cells.map((c) => ({ ...c }));
  for (let i = 0; i < rot; i++) out = out.map((c) => ({ x: -c.y, y: c.x }));
  return normalize(out);
}

export function placeShape(cells: Cell[], place: Placement): Cell[] {
  return rotateShape(cells, place.rot).map((c) => ({ x: c.x + place.x, y: c.y + place.y }));
}

/** Where one local cell of `shape` lands on the board under `place` (same rotation as placeShape). */
export function placeCell(shape: Cell[], local: Cell, place: Placement): Cell {
  let cells = shape.map((c) => ({ ...c }));
  let cell = { ...local };
  for (let i = 0; i < place.rot; i++) {
    cells = cells.map((c) => ({ x: -c.y, y: c.x }));
    cell = { x: -cell.y, y: cell.x };
  }
  let minX = Infinity;
  let minY = Infinity;
  for (const c of cells) {
    minX = Math.min(minX, c.x);
    minY = Math.min(minY, c.y);
  }
  return { x: cell.x - minX + place.x, y: cell.y - minY + place.y };
}

export function shapeSize(cells: Cell[]): { w: number; h: number } {
  let w = 0;
  let h = 0;
  for (const c of cells) {
    w = Math.max(w, c.x + 1);
    h = Math.max(h, c.y + 1);
  }
  return { w, h };
}

/** Orthogonal neighbours of a cell set that are not part of it. */
export function neighbours(cells: Cell[]): Cell[] {
  const own = new Set(cells.map(cellKey));
  const seen = new Set<number>();
  const out: Cell[] = [];
  for (const c of cells) {
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const n = { x: c.x + dx, y: c.y + dy };
      const k = cellKey(n);
      if (!inBoard(n) || own.has(k) || seen.has(k)) continue;
      seen.add(k);
      out.push(n);
    }
  }
  return out;
}

export function touches(a: Cell[], b: Cell[]): boolean {
  const bk = new Set(b.map(cellKey));
  return neighbours(a).some((c) => bk.has(cellKey(c)));
}

/**
 * medic / lucky work on the Pokémon standing on the bag: 1/32 HP per pulse, +1 crit stage.
 * berry / candy / coin work on the items lying entirely on it (Backpack Battles' Potion Belt), so the
 * item still helps whichever Pokémon it touches, even one standing on another bag.
 */
export type BagEffect = "medic" | "lucky" | "berry" | "candy" | "coin";

/** A berry on a Berry Pouch is not used up when it triggers with this chance. */
export const BERRY_POUCH_SAVE_CHANCE = 0.5;
/** Rare Candy and Rarer Candy on a Candy Jar give this many extra levels. */
export const CANDY_JAR_EXTRA_LEVELS = 2;
/** A Coin Case on the board pays this much per win by itself, so it is never a dead bag without gold items. */
export const COIN_CASE_WIN_GOLD = 1;
/** Amulet Coin and Luck Incense on a Coin Case pay this much more per win; nuggets gain this much more sell value per round. */
export const COIN_CASE_EXTRA_GOLD = 1;

export interface BagDef {
  key: string;
  cells: Cell[];
  tier: 1 | 2 | 3 | 4 | 5;
  price: number;
  effect?: BagEffect;
  /** A real Pokémon item (Berry Pouch, Candy Jar, Coin Case): its name and icon come from the item data. */
  realItem?: boolean;
  /** Starting bag: every run has one, it can be moved but not sold or bought. */
  starter?: boolean;
}

export const BAGS: Record<string, BagDef> = {
  BAG_START: { key: "BAG_START", cells: rectShape(3, 3), tier: 1, price: 0, starter: true },
  /** Runs created before the starting bag shrank keep their 5×3 bag. */
  BAG_START_LEGACY: { key: "BAG_START_LEGACY", cells: rectShape(5, 3), tier: 1, price: 0, starter: true },
  BAG_1X2: { key: "BAG_1X2", cells: rectShape(2, 1), tier: 1, price: 2 },
  BAG_1X3: { key: "BAG_1X3", cells: rectShape(3, 1), tier: 1, price: 3 },
  BAG_L: {
    key: "BAG_L",
    cells: [
      { x: 0, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
    ],
    tier: 1,
    price: 3,
  },
  BAG_2X2: { key: "BAG_2X2", cells: rectShape(2, 2), tier: 2, price: 4 },
  BAG_2X3: { key: "BAG_2X3", cells: rectShape(3, 2), tier: 2, price: 5 },
  BAG_S: {
    key: "BAG_S",
    cells: [
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
    ],
    tier: 1,
    price: 3,
  },
  BAG_3X3: { key: "BAG_3X3", cells: rectShape(3, 3), tier: 3, price: 7 },
  BAG_T: {
    key: "BAG_T",
    cells: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 1, y: 1 },
    ],
    tier: 2,
    price: 4,
  },
  BAG_MEDIC: { key: "BAG_MEDIC", cells: rectShape(2, 2), tier: 3, price: 6, effect: "medic" },
  BAG_LUCKY: { key: "BAG_LUCKY", cells: rectShape(2, 1), tier: 3, price: 5, effect: "lucky" },
  // A belt: laid between two rows of Pokémon, each berry on it touches the Pokémon on both sides.
  BERRY_POUCH: { key: "BERRY_POUCH", cells: rectShape(3, 1), tier: 2, price: 5, effect: "berry", realItem: true },
  CANDY_JAR: { key: "CANDY_JAR", cells: rectShape(2, 1), tier: 2, price: 4, effect: "candy", realItem: true },
  COIN_CASE: { key: "COIN_CASE", cells: rectShape(2, 1), tier: 2, price: 4, effect: "coin", realItem: true },
};

/** The bag effect that works on an item: berries, Rare Candies, and gold items. */
export function bagEffectFor(item: string): BagEffect | null {
  if (item.endsWith("_BERRY")) return "berry";
  if (item === "RARE_CANDY" || item === "RARER_CANDY") return "candy";
  if (item === "AMULET_COIN" || item === "LUCK_INCENSE" || item === "NUGGET" || item === "BIG_NUGGET") return "coin";
  return null;
}

/** Whether `item`, lying entirely on a bag of key `bagKey` (see `Adjacency.bagUnder`), gets that bag's effect. */
export function poweredByBag(item: string, bagKey: string | undefined): boolean {
  const effect = bagEffectFor(item);
  return effect !== null && !!bagKey && BAGS[bagKey]?.effect === effect;
}
