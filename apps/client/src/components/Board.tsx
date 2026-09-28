import { forwardRef, useMemo, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import {
  BAGS,
  BOARD_H,
  BOARD_W,
  cellKey,
  cellsOf,
  computeAdjacency,
  getSpecies,
  itemReach,
  poweredByBag,
  shapeSize,
  rotateShape,
  pieceShape,
  type Cell,
  type Piece,
  type RunState,
} from "@pokebattles/game";
import { TYPE_COLORS } from "../battle/stats.ts";
import { useI18n } from "../i18n.tsx";
import { ItemIcon, PokemonSprite } from "./sprites.tsx";

export interface BoardPreview {
  cells: Cell[];
  valid: boolean;
  /** Piece that will swap places or go to the stash on drop. */
  displacedUid?: string;
}

interface BoardProps {
  state: RunState;
  cell: number;
  selected: string | null;
  highlight: Set<number>;
  preview: BoardPreview | null;
  /** Pieces being dragged (a bag drags its linked bags and what lies on them). */
  dragging: ReadonlySet<string>;
  /** Cells the focused item reaches (Backpack Battles stars). */
  stars: Set<number>;
  /** Pokémon inside that reach. */
  affected: Set<string>;
  /** Item that the dragged item would combine with. */
  recipeUid: string | null;
  onHover: (uid: string | null) => void;
  onPiecePointerDown: (e: ReactPointerEvent, uid: string) => void;
  onPieceContext: (uid: string) => void;
  onBackgroundClick: () => void;
}

/** Arrow showing where a directional item points after rotation. */
export function reachArrow(item: string, rot: number): string | null {
  const reach = itemReach(item);
  if (reach === "row") return rot % 2 === 0 ? "↔" : "↕";
  if (reach !== "front" && reach !== "line") return null;
  return ["↑", "→", "↓", "←"][rot] ?? null;
}

function box(piece: Piece): { x: number; y: number; w: number; h: number } {
  const cells = cellsOf(piece);
  const rot = rotateShape(pieceShape(piece), piece.place!.rot);
  const size = shapeSize(rot);
  const x = Math.min(...cells.map((c) => c.x));
  const y = Math.min(...cells.map((c) => c.y));
  return { x, y, w: size.w, h: size.h };
}

export const Board = forwardRef<HTMLDivElement, BoardProps>(function Board(
  { state, cell, selected, highlight, preview, dragging, stars, affected, recipeUid, onHover, onPiecePointerDown, onPieceContext, onBackgroundClick },
  ref,
) {
  const { tr } = useI18n();
  const pieces = Object.values(state.pieces).filter((p) => p.place);
  const bags = pieces.filter((p) => p.kind === "bag");
  const others = pieces.filter((p) => p.kind !== "bag");
  // Item uid → key of the bag powering it (a berry on the Berry Pouch).
  const poweredBy = useMemo(() => {
    const out = new Map<string, string>();
    for (const [uid, bag] of computeAdjacency(state.pieces).bagUnder) {
      const p = state.pieces[uid];
      if (p?.kind === "item" && poweredByBag(p.item, bag)) out.set(uid, bag);
    }
    return out;
  }, [state.pieces]);
  const previewSet = new Map((preview?.cells ?? []).map((c) => [cellKey(c), preview!.valid]));

  const bagCells: { c: Cell; uid: string }[] = [];
  for (const b of bags) for (const c of cellsOf(b)) bagCells.push({ c, uid: b.uid });
  const bagOf = new Map(bagCells.map((b) => [cellKey(b.c), b.uid]));

  const grid = [];
  for (let y = 0; y < BOARD_H; y++) {
    for (let x = 0; x < BOARD_W; x++) {
      const k = cellKey({ x, y });
      const bagUid = bagOf.get(k);
      const bag = bagUid ? (state.pieces[bagUid] as Extract<Piece, { kind: "bag" }>) : null;
      const cls = [
        "cell",
        !bag ? "no-bag" : BAGS[bag.bag]?.starter ? "bag-base" : `bag-extra ${bag.bag.toLowerCase()}`,
        highlight.has(k) ? "hl" : "",
        previewSet.has(k) ? (previewSet.get(k) ? "pv-ok" : "pv-bad") : "",
        bagUid && selected === bagUid ? "sel" : "",
      ].join(" ");
      grid.push(
        <div
          key={k}
          className={cls}
          style={{ left: x * cell, top: y * cell, width: cell, height: cell }}
          onPointerDown={bagUid ? (e) => onPiecePointerDown(e, bagUid) : undefined}
          onContextMenu={
            bagUid
              ? (e) => {
                  e.preventDefault();
                  onPieceContext(bagUid);
                }
              : undefined
          }
        />,
      );
    }
  }

  return (
    <div
      ref={ref}
      className="board"
      style={{ width: BOARD_W * cell, height: BOARD_H * cell }}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onBackgroundClick();
      }}
    >
      {grid}
      <div className="front-label">{tr.t("ui.front")} ↑</div>
      {bags.map((b) => {
        if (!BAGS[b.bag]?.realItem) return null;
        // The item's icon on the bag's last cell tells a Berry Pouch from a Candy Jar at a glance.
        const last = [...cellsOf(b)].sort((p, q) => q.y - p.y || q.x - p.x)[0]!;
        return (
          <div key={`mark-${b.uid}`} className="bag-mark" style={{ left: last.x * cell, top: last.y * cell, width: cell, height: cell }}>
            <ItemIcon item={b.bag} size={Math.round(cell * 0.6)} />
          </div>
        );
      })}
      {bags.map((b) => {
        // A handle on the bag's first cell lets you grab it even when it is full.
        const first = [...cellsOf(b)].sort((p, q) => p.y - q.y || p.x - q.x)[0]!;
        return (
          <div
            key={`handle-${b.uid}`}
            className={`bag-handle ${selected === b.uid ? "sel" : ""} ${dragging.has(b.uid) ? "dragging" : ""}`}
            title={tr.itemName(b.bag)}
            style={{ left: first.x * cell + 3, top: first.y * cell + 3 }}
            onPointerDown={(e) => {
              e.stopPropagation();
              onPiecePointerDown(e, b.uid);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              onPieceContext(b.uid);
            }}
          />
        );
      })}
      {others.map((p) => {
        const b = box(p);
        const isSel = selected === p.uid;
        return (
          <div
            key={p.uid}
            className={[
              "piece",
              `piece-${p.kind}`,
              p.kind === "item" && b.w * b.h > 1 ? "big" : "",
              isSel ? "sel" : "",
              dragging.has(p.uid) ? "dragging" : "",
              preview?.displacedUid === p.uid ? "swap" : "",
              affected.has(p.uid) ? "affected" : "",
              recipeUid === p.uid ? "recipe" : "",
            ].join(" ")}
            onPointerEnter={() => onHover(p.uid)}
            onPointerLeave={() => onHover(null)}
            style={
              {
                left: b.x * cell,
                top: b.y * cell,
                width: b.w * cell,
                height: b.h * cell,
                "--cell": `${cell}px`,
                "--tc": p.kind === "pokemon" ? TYPE_COLORS[getSpecies(p.species).types[0]!] : undefined,
              } as CSSProperties
            }
            onPointerDown={(e) => onPiecePointerDown(e, p.uid)}
            onContextMenu={(e) => {
              e.preventDefault();
              onPieceContext(p.uid);
            }}
          >
            {p.kind === "pokemon" ? (
              <>
                <PokemonSprite
                  species={p.species}
                  formKey={getSpecies(p.species).spriteForm}
                  shiny={p.shiny}
                  width={b.w * cell - 6}
                  height={b.h * cell - 12}
                  maxScale={3}
                  valign={b.h > b.w ? "middle" : "bottom"}
                />
                <span className="lv">{tr.t("ui.level", { n: p.level })}</span>
                {b.w * b.h > 1 && <span className="size-badge">{`${b.w}×${b.h}`}</span>}
                {p.shiny && <span className="shiny">✦</span>}
                {state.ace === p.uid && <span className="ace">♛</span>}
                {p.pendingEvolution && <span className="pending">⟳</span>}
              </>
            ) : p.kind === "item" ? (
              <>
                <ItemIcon item={p.item} param={p.param} size={Math.min(b.w, b.h) * cell - 16} />
                {b.w * b.h > 1 && <span className="size-badge">{`${b.w}×${b.h}`}</span>}
                {reachArrow(p.item, p.place!.rot) && <span className="reach-arrow">{reachArrow(p.item, p.place!.rot)}</span>}
                {recipeUid === p.uid && <span className="recipe-badge">★</span>}
                {poweredBy.has(p.uid) && (
                  <span className="bag-powered">
                    <ItemIcon item={poweredBy.get(p.uid)!} size={Math.round(cell * 0.3)} />
                  </span>
                )}
              </>
            ) : null}
          </div>
        );
      })}
      {[...stars].map((k) => (
        <div key={`star-${k}`} className="reach-star" style={{ left: (k % BOARD_W) * cell, top: Math.floor(k / BOARD_W) * cell, width: cell, height: cell }}>
          ★
        </div>
      ))}
    </div>
  );
});
