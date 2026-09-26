import type { PointerEvent as ReactPointerEvent } from "react";
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

/** Pokémon an evolution item on offer would evolve for this run (owned ones first), so the card says it at a glance. */
function EvolutionUsers({ state, item }: { state: RunState; item: string }) {
  const { tr } = useI18n();
  if (ITEMS[item]?.family !== "evolution") return null;
  const reach = championReach(state);
  const owned = new Set(Object.values(state.pieces).flatMap((p) => (p.kind === "pokemon" ? [p.species] : [])));
  const froms = [...new Set(itemEvolutions(item).map((e) => e.from))].filter((k) => reach.has(k)).sort((a, b) => Number(owned.has(b)) - Number(owned.has(a)));
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

export function offerName(tr: ReturnType<typeof useI18n>["tr"], offer: Offer): string {
  if (offer.kind === "pokemon") return tr.species(offer.species);
  if (offer.kind === "item") return tr.itemName(offer.item, offer.param);
  return tr.itemName(offer.bag);
}

interface ShopProps {
  state: RunState;
  /** Phone layout: smaller cards so all five fit in one row. */
  compact?: boolean;
  selectedSlot: number | null;
  targetingShop: boolean;
  onSlotPointerDown: (e: ReactPointerEvent, slot: number) => void;
  onLock: (slot: number) => void;
  onReroll: () => void;
}

export function Shop({ state, compact, selectedSlot, targetingShop, onSlotPointerDown, onLock, onReroll }: ShopProps) {
  const { tr } = useI18n();
  const cost = rerollCost(state);
  return (
    <section className="shop panel">
      <div className="panel-title">
        <span>{tr.t("ui.shop")}</span>
        <button className="btn btn-small" data-sfx="ui/menu_open" disabled={state.gold < cost || state.phase !== "shop"} onClick={onReroll}>
          ⟳ {tr.t("ui.reroll")} <b className="gold">{cost}G</b>
        </button>
      </div>
      <div className="shop-slots">
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
          ].join(" ");
          return (
            <div key={i} className={cls} onPointerDown={(e) => onSlotPointerDown(e, i)}>
              {slot.sale && <span className="sale-tag">{tr.t("ui.sale")}</span>}
              <div className="tier-pips">{"★".repeat(offer.tier)}</div>
              <div className="offer-visual">
                <OfferVisual offer={offer} size={compact ? 44 : 64} />
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
              <button
                className={`lock ${slot.locked ? "on" : ""}`}
                data-sfx="se/pb_lock"
                title={tr.t(slot.locked ? "ui.locked" : "ui.lock")}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onLock(i);
                }}
              >
                {slot.locked ? "🔒" : "🔓"}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
