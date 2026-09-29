import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import {
  BAGS,
  basePrice,
  championReach,
  getSpecies,
  itemEvolutions,
  itemReach,
  itemSize,
  ITEMS,
  rerollCost,
  SHOP_SIZE_STEPS,
  shapeSize,
  slotPrice,
  type Offer,
  type RunState,
} from "@pokebattles/game";
import { useI18n } from "../i18n.tsx";
import { BagIcon, ItemIcon, PokemonSprite } from "./sprites.tsx";

export function OfferVisual({ offer, size }: { offer: Offer; size: number }) {
  if (offer.kind === "pokemon") {
    return <PokemonSprite species={offer.species} formKey={getSpecies(offer.species).spriteForm} shiny={offer.shiny} width={size} height={size} maxScale={2} />;
  }
  if (offer.kind === "item") return <ItemIcon item={offer.item} param={offer.param} size={Math.round(size * 0.7)} />;
  return <BagIcon bag={offer.bag} size={Math.round(size * 0.7)} />;
}

/** Mini grid of the cells a piece takes, so a 2×1 item never reads as a 1×1 icon. */
export function SizeChip({ w, h, label }: { w: number; h: number; label?: string }) {
  return (
    <span className={`size-chip ${w * h > 1 ? "multi" : ""}`}>
      <span className="size-glyph" style={{ gridTemplateColumns: `repeat(${w}, 6px)`, gridTemplateRows: `repeat(${h}, 6px)` }}>
        {Array.from({ length: w * h }, (_, i) => (
          <i key={i} />
        ))}
      </span>
      {label ?? `${w}×${h}`}
    </span>
  );
}

/** A bag's real outline (L, T, S…) in mini cells, so it reads as "more board" and not as a held item. */
export function BagShapeChip({ bag, label }: { bag: string; label?: string }) {
  const cells = BAGS[bag]?.cells ?? [];
  const { w, h } = shapeSize(cells);
  const on = new Set(cells.map((c) => `${c.x},${c.y}`));
  return (
    <span className="size-chip bag-shape">
      <span className="size-glyph" style={{ gridTemplateColumns: `repeat(${w}, 6px)`, gridTemplateRows: `repeat(${h}, 6px)` }}>
        {Array.from({ length: w * h }, (_, i) => (
          <i key={i} className={on.has(`${i % w},${Math.floor(i / w)}`) ? "" : "off"} />
        ))}
      </span>
      {label}
    </span>
  );
}

/** What a bag adds: its cells, and the effect for the special ones (Berry Pouch, Candy Jar…). */
export function BagOfferMeta({ bag }: { bag: string }) {
  const { tr } = useI18n();
  const def = BAGS[bag];
  if (!def) return null;
  return (
    <div className="offer-meta">
      <BagShapeChip bag={bag} label={tr.t("ui.bagCells", { n: def.cells.length })} />
      {def.effect && <span className="bag-effect">{tr.t(`ui.bagEffectShort.${def.effect}`)}</span>}
    </div>
  );
}

/** Pokémon an evolution item would evolve for this run, owned ones first; null for any other item. */
function evolutionUsers(state: RunState, item: string): { froms: string[]; owned: Set<string> } | null {
  if (ITEMS[item]?.family !== "evolution") return null;
  const reach = championReach(state);
  const owned = new Set(Object.values(state.pieces).flatMap((p) => (p.kind === "pokemon" ? [p.species] : [])));
  const froms = [...new Set(itemEvolutions(item).map((e) => e.from))].filter((k) => reach.has(k)).sort((a, b) => Number(owned.has(b)) - Number(owned.has(a)));
  return { froms, owned };
}

/** The Pokémon an evolution item on offer would evolve, so the card says it at a glance. */
function EvolutionUsers({ state, item }: { state: RunState; item: string }) {
  const { tr } = useI18n();
  const users = evolutionUsers(state, item);
  if (!users) return null;
  const { froms, owned } = users;
  if (froms.length === 0) return <div className="evo-users none">{tr.t("ui.evolvesNoneShort")}</div>;
  const shown = froms.slice(0, 3);
  return (
    <div className="evo-users" title={froms.map((k) => tr.species(k)).join(", ")}>
      {shown.map((k) => (
        <span key={k} className={owned.has(k) ? "owned" : ""}>
          <PokemonSprite species={k} formKey={getSpecies(k).spriteForm} width={22} height={22} animate={false} />
        </span>
      ))}
      {froms.length > shown.length && <span className="more">+{froms.length - shown.length}</span>}
    </div>
  );
}

/**
 * Phone cards carry their details as badges on the picture's corners, like pieces on the board:
 * level (✦ ◆ up top) for a Pokémon, size for a bigger item, "bag" and its cells for a bag, and the
 * Pokémon an evolution item evolves. The card keeps one height whatever it sells, so a reroll never resizes the board.
 */
function OfferBadges({ state, offer }: { state: RunState; offer: Offer }) {
  const { tr } = useI18n();
  if (offer.kind === "pokemon") {
    return (
      <>
        <span className="vb vb-left">{tr.t("ui.level", { n: offer.level })}</span>
        {(offer.shiny || offer.hiddenAbility) && (
          <span className="vb vb-marks">
            {offer.shiny && <span className="shiny">✦</span>}
            {offer.hiddenAbility && <span className="hidden-ab">◆</span>}
          </span>
        )}
      </>
    );
  }
  if (offer.kind === "bag") {
    return (
      <>
        <span className="vb vb-left vb-bag">{tr.t("ui.bagTag")}</span>
        <span className="vb vb-right">{tr.t("ui.bagCells", { n: BAGS[offer.bag]?.cells.length ?? 0 })}</span>
      </>
    );
  }
  const users = evolutionUsers(state, offer.item);
  if (users) {
    const { froms, owned } = users;
    if (froms.length === 0) return <span className="vb vb-right vb-none" title={tr.t("ui.evolvesNoneShort")}>✕</span>;
    return (
      <span className={`vb vb-right vb-evo ${owned.has(froms[0]!) ? "owned" : ""}`} title={froms.map((k) => tr.species(k)).join(", ")}>
        <PokemonSprite species={froms[0]!} formKey={getSpecies(froms[0]!).spriteForm} width={16} height={16} animate={false} />
        {froms.length > 1 && `+${froms.length - 1}`}
      </span>
    );
  }
  const s = itemSize(offer.item);
  return s.w * s.h > 1 ? <span className="vb vb-right">{`${s.w}×${s.h}`}</span> : null;
}

/** The roomy card's extra line: what the badges cannot say. */
function offerExtra(tr: ReturnType<typeof useI18n>["tr"], offer: Offer): string {
  if (offer.kind === "item") return tr.t(`reach.${itemReach(offer.item)}`);
  if (offer.kind === "bag") {
    const effect = BAGS[offer.bag]?.effect;
    return effect ? tr.t(`ui.bagEffectShort.${effect}`) : "";
  }
  return "";
}

export function offerName(tr: ReturnType<typeof useI18n>["tr"], offer: Offer): string {
  if (offer.kind === "pokemon") return tr.species(offer.species);
  if (offer.kind === "item") return tr.itemName(offer.item, offer.param);
  return tr.itemName(offer.bag);
}

interface ShopProps {
  state: RunState;
  /** Phone and short layouts: compact cards (details as badges on the picture) so the whole shop fits one row or column. */
  compact?: boolean;
  /** Tall phone: bigger pictures, and the line the badges leave out (an item's reach, a bag's effect). */
  roomy?: boolean;
  selectedSlot: number | null;
  targetingShop: boolean;
  onSlotPointerDown: (e: ReactPointerEvent, slot: number) => void;
  onLock: (slot: number) => void;
  onReroll: () => void;
}

export function Shop({ state, compact, roomy, selectedSlot, targetingShop, onSlotPointerDown, onLock, onReroll }: ShopProps) {
  const { tr } = useI18n();
  const cost = rerollCost(state);
  const growth = SHOP_SIZE_STEPS.find(([from]) => from > state.round);
  return (
    <section className="shop panel">
      <div className="panel-title">
        <span>
          {tr.t("ui.shop")}
          {growth && (
            <span className="muted small shop-next" title={tr.t("ui.shopGrowth", { round: growth[0], n: growth[1] })}>
              {" "}
              · {tr.t("ui.shopNext", { round: growth[0], n: growth[1] })}
            </span>
          )}
        </span>
        <button className="btn btn-small" data-sfx="ui/menu_open" disabled={state.gold < cost || state.phase !== "shop"} onClick={onReroll}>
          ⟳ {tr.t("ui.reroll")} <b className="gold">{cost}G</b>
        </button>
      </div>
      <div className="shop-slots" style={{ "--slots": Math.max(1, state.shop.length) } as CSSProperties}>
        {state.shop.map((slot, i) => {
          const offer = slot.offer;
          if (!offer) {
            return (
              <div key={i} className="shop-card empty">
                {tr.t("ui.soldOut")}
              </div>
            );
          }
          const price = slotPrice(slot, state);
          const cls = [
            "shop-card",
            `tier-${offer.tier}`,
            selectedSlot === i ? "sel" : "",
            price > state.gold ? "poor" : "",
            targetingShop && offer.kind === "pokemon" ? "target" : "",
            offer.kind === "bag" ? "bag-offer" : "",
            slot.sale ? "on-sale" : "",
            slot.locked ? "locked" : "",
          ].join(" ");
          if (compact) {
            return (
              <div key={i} className={cls} onPointerDown={(e) => onSlotPointerDown(e, i)}>
                <div className="tier-pips">{"★".repeat(offer.tier)}</div>
                <div className="offer-visual">
                  <OfferVisual offer={offer} size={roomy ? 52 : 40} />
                  <OfferBadges state={state} offer={offer} />
                </div>
                <div className="offer-name">
                  <span>{offerName(tr, offer)}</span>
                </div>
                {roomy && <div className="offer-extra">{offerExtra(tr, offer)}</div>}
                <div className="price" title={slot.sale ? tr.t("ui.sale") : undefined}>
                  {slot.sale && <s>{basePrice(offer, state)}</s>}
                  <b>{price}G</b>
                </div>
                <LockButton locked={slot.locked} onLock={() => onLock(i)} />
              </div>
            );
          }
          return (
            <div key={i} className={cls} onPointerDown={(e) => onSlotPointerDown(e, i)}>
              {slot.sale && <span className="sale-tag">{tr.t("ui.sale")}</span>}
              <div className="tier-pips">{"★".repeat(offer.tier)}</div>
              <div className="offer-visual">
                <OfferVisual offer={offer} size={64} />
              </div>
              {offer.kind === "bag" && <div className="bag-tag">🎒 {tr.t("ui.bagTag")}</div>}
              <div className="offer-name">{offerName(tr, offer)}</div>
              {offer.kind === "item" && (
                <div className="offer-meta">
                  {(() => {
                    const s = itemSize(offer.item);
                    return s.w * s.h > 1 ? <SizeChip w={s.w} h={s.h} /> : null;
                  })()}
                  {tr.t(`reach.${itemReach(offer.item)}`)}
                </div>
              )}
              {offer.kind === "item" && <EvolutionUsers state={state} item={offer.item} />}
              {offer.kind === "bag" && <BagOfferMeta bag={offer.bag} />}
              {offer.kind === "pokemon" && (
                <div className="offer-meta">
                  {tr.t("ui.level", { n: offer.level })}
                  {offer.shiny && <span className="shiny"> ✦</span>}
                  {offer.hiddenAbility && <span className="hidden-ab"> ◆</span>}
                </div>
              )}
              <div className="price">
                {slot.sale && <s className="muted">{basePrice(offer, state)}G</s>} <b className="gold">{price}G</b>
              </div>
              <LockButton locked={slot.locked} onLock={() => onLock(i)} />
            </div>
          );
        })}
      </div>
    </section>
  );
}

function LockButton({ locked, onLock }: { locked: boolean; onLock: () => void }) {
  const { tr } = useI18n();
  return (
    <button
      className={`lock ${locked ? "on" : ""}`}
      data-sfx="se/pb_lock"
      title={tr.t(locked ? "ui.locked" : "ui.lock")}
      aria-label={tr.t(locked ? "ui.locked" : "ui.lock")}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onLock();
      }}
    >
      {locked ? "🔒" : "🔓"}
    </button>
  );
}
