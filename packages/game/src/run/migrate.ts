import { BAGS, BOARD_H } from "../board.ts";
import { cellsOf, findFreePlacement, layoutIsValid, repairLayout } from "./layout.ts";
import type { BagPiece, ItemPiece, RunState } from "./types.ts";

export const RUN_STATE_VERSION = 5;

/**
 * Brings stored runs up to date.
 * v1 → v2: the board grew from 7×5 to 9×7 and the fixed starting bag moved from (1,1) to (2,2),
 *          so every placed piece shifts by (+1,+1).
 * v2 → v3: the starting bag became a movable piece. Old runs keep their 5×3 bag as a legacy
 *          starting bag at the same spot so nothing ends up off a bag.
 * v3 → v4: the board lost its last row (9×7 → 9×6) so a full bag is a little tight. When the front
 *          row is empty everything moves up one row; otherwise bags on the lost row move to a free spot.
 * v4 → v5: the Berry Pouch became a bag. Berry Pouch items are refunded in full, and a Berry Pouch
 *          item on offer in the shop becomes the bag.
 */
export function migrateRun(input: RunState): RunState {
  const upgraded = upgradeVersion(input);
  if (layoutIsValid(upgraded.pieces)) return upgraded;
  // Footprints can change between content versions; untangle overlaps before play continues.
  const state = upgraded === input ? structuredClone(input) : upgraded;
  for (const uid of repairLayout(state.pieces)) {
    const item = state.pieces[uid] as ItemPiece;
    state.notices = [...state.notices, { key: "notice.itemStashed", params: { item: item.item, ...(item.param ? { param: item.param } : {}) } }];
  }
  return state;
}

function upgradeVersion(input: RunState): RunState {
  const version = (input as { v: number }).v;
  if (version === RUN_STATE_VERSION) return input;
  const state = structuredClone(input) as RunState;
  if (version === 1) {
    for (const p of Object.values(state.pieces)) {
      if (p.place) p.place = { ...p.place, x: p.place.x + 1, y: p.place.y + 1 };
    }
  }
  if (version === 1 || version === 2) {
    const hasStarter = Object.values(state.pieces).some((p) => p.kind === "bag" && BAGS[p.bag]?.starter);
    if (!hasStarter) {
      const bag: BagPiece = { uid: `u${state.nextUid++}`, kind: "bag", place: { x: 2, y: 2, rot: 0 }, paid: 0, bag: "BAG_START_LEGACY" };
      state.pieces[bag.uid] = bag;
    }
  }
  if (version <= 3) {
    const placed = Object.values(state.pieces).filter((p) => p.place);
    const lowest = Math.max(...placed.map((p) => Math.max(...cellsOf(p).map((c) => c.y))), 0);
    if (lowest >= BOARD_H) {
      const topFree = placed.every((p) => cellsOf(p).every((c) => c.y > 0));
      if (topFree) {
        for (const p of placed) p.place = { ...p.place!, y: p.place!.y - 1 };
      } else {
        for (const bag of placed.filter((p) => p.kind === "bag" && cellsOf(p).some((c) => c.y >= BOARD_H))) {
          const others = Object.fromEntries(Object.entries(state.pieces).filter(([uid, p]) => uid !== bag.uid && p.kind === "bag"));
          bag.place = findFreePlacement(others, { ...bag, place: null }, bag.place!) ?? null;
        }
      }
    }
  }
  if (version <= 4) {
    for (const p of Object.values(state.pieces)) {
      if (p.kind !== "item" || p.item !== "BERRY_POUCH") continue;
      delete state.pieces[p.uid];
      state.gold += p.paid;
      state.notices = [...state.notices, { key: "notice.berryPouchRefund", params: { item: p.item, gold: p.paid } }];
    }
    for (const slot of state.shop) {
      if (slot.offer?.kind === "item" && slot.offer.item === "BERRY_POUCH") slot.offer = { kind: "bag", tier: BAGS.BERRY_POUCH!.tier, bag: "BERRY_POUCH" };
    }
  }
  state.v = RUN_STATE_VERSION;
  return state;
}
