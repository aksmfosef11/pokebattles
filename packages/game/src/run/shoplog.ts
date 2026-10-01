import { applyAction } from "./reducer.ts";
import type { Action, Offer, Piece, RunState, ShopSlot } from "./types.ts";

/** What one shop phase offered and what the player did with it (server `battles.shop`, balance statistics). */
export interface ShopLog {
  /** Gold when the shop opened (this round's income included) and when the player went to battle. */
  goldStart: number;
  goldEnd: number;
  rerolls: number;
  rerollGold: number;
  /** Gold paid for purchases, and gold back from sales. */
  spent: number;
  sellGold: number;
  /** Every offer the player saw: the opening shop and each shop after a reroll or the subclass choice. */
  offered: string[];
  /** Offers taken, by gold or by Master Ball. */
  bought: string[];
  sold: string[];
  /** Items used from the stash (balls, TMs, Mint, Bottle Cap, ...). */
  used: string[];
  /** Arranging actions (move / rotate); a rough measure of how much the board was reworked. */
  arranged: number;
}

/** `mon:PIKACHU`, `item:LEFTOVERS`, `bag:BAG_2X2`: one key space for offers, purchases and sales. */
export function offerKey(offer: Offer): string {
  return offer.kind === "pokemon" ? `mon:${offer.species}` : offer.kind === "item" ? `item:${offer.item}` : `bag:${offer.bag}`;
}

export function pieceKey(piece: Piece): string {
  return piece.kind === "pokemon" ? `mon:${piece.species}` : piece.kind === "item" ? `item:${piece.item}` : `bag:${piece.bag}`;
}

const shown = (shop: readonly ShopSlot[]) => shop.flatMap((slot) => (slot.offer ? [offerKey(slot.offer)] : []));

/** applyActions that also writes the shop log. Throws exactly where applyActions would. */
export function replayShop(start: RunState, actions: readonly Action[]): { state: RunState; log: ShopLog } {
  const log: ShopLog = {
    goldStart: start.gold,
    goldEnd: start.gold,
    rerolls: 0,
    rerollGold: 0,
    spent: 0,
    sellGold: 0,
    offered: start.phase === "shop" ? shown(start.shop) : [],
    bought: [],
    sold: [],
    used: [],
    arranged: 0,
  };
  let s = start;
  for (const action of actions) {
    const before = s;
    s = applyAction(s, action);
    switch (action.t) {
      case "buy": {
        const offer = before.shop[action.slot]?.offer;
        if (offer) log.bought.push(offerKey(offer));
        log.spent += before.gold - s.gold;
        break;
      }
      case "sell": {
        const piece = before.pieces[action.uid];
        if (piece) log.sold.push(pieceKey(piece));
        log.sellGold += s.gold - before.gold;
        break;
      }
      case "reroll":
        log.rerolls++;
        log.rerollGold += before.gold - s.gold;
        log.offered.push(...shown(s.shop));
        break;
      case "chooseSubclass":
        log.offered.push(...shown(s.shop));
        break;
      case "use": {
        const piece = before.pieces[action.uid];
        if (piece?.kind === "item") {
          log.used.push(piece.item);
          const slot = action.slot !== undefined ? before.shop[action.slot] : undefined;
          if (piece.item === "MASTER_BALL" && slot?.offer) log.bought.push(offerKey(slot.offer));
        }
        break;
      }
      case "move":
      case "choice":
        log.arranged++;
        break;
    }
  }
  log.goldEnd = s.gold;
  return { state: s, log };
}
