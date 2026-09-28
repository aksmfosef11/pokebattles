import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import {
  applyAction,
  BOARD_H,
  BOARD_W,
  CHAMPIONS,
  cellKey,
  cellsOf,
  checkPlacement,
  itemReach,
  itemReachCells,
  planDrop,
  reachCells,
  recipePartner,
  STASH_LIMIT,
  computeAdjacency,
  computeLayout,
  GameError,
  getSpecies,
  MAX_ROUNDS,
  PARTY_CAP_STEPS,
  partyCap,
  partyCount,
  pieceShape,
  placeShape,
  rotationSpot,
  sellValue,
  shapeSize,
  rotateShape,
  WINS_TO_CLEAR,
  type Action,
  type Cell,
  type Offer,
  type Piece,
  type Placement,
  type Rot,
  type RunState,
  type TurnResponse,
} from "@pokebattles/game";
import type { GameApi } from "../api.ts";
import { sound } from "../audio.ts";
import { Board, type BoardPreview } from "../components/Board.tsx";
import { Detail, type DetailTarget } from "../components/Detail.tsx";
import { RecipeBook } from "../components/RecipeBook.tsx";
import { Shop } from "../components/Shop.tsx";
import { SoundButton } from "../components/SoundButton.tsx";
import { BagIcon, ItemIcon, PokemonSprite, ShinyLines, TrainerSprite } from "../components/sprites.tsx";
import { TYPE_COLORS } from "../battle/stats.ts";
import { useI18n } from "../i18n.tsx";

function isRotateKey(e: KeyboardEvent): boolean {
  return e.code === "KeyR" || e.key === "r" || e.key === "R" || e.key === "ㄱ";
}

type DragSource = { kind: "piece"; uid: string } | { kind: "shop"; slot: number };

interface DragState {
  source: DragSource;
  rot: Rot;
  x: number;
  y: number;
  started: boolean;
  startX: number;
  startY: number;
  /** Only this pointer moves or drops the piece; on touch a second finger's tap rotates it. */
  pointerId: number;
  touch: boolean;
  /** On touch the piece floats this far above the finger so the finger does not hide where it lands. */
  lift: number;
}

/** Below this width the run screen switches to the phone layout. */
const COMPACT_WIDTH = 700;
/** Below this height (a phone on its side) the shop moves beside the board. */
const SHORT_HEIGHT = 600;
/** Portrait phones lower than this get a one-row dock. */
const TIGHT_HEIGHT = 620;

/**
 * phone: portrait phone, everything stacked with a dock at the bottom. short: wide but low (a phone
 * held sideways), shop | board | dock side by side. Both fill exactly one screen, so nothing needs
 * scrolling (a drag cannot scroll the page to reach the stash or the sell zone). desktop: as before.
 */
type Layout = "phone" | "short" | "desktop";

function layoutFor(w: number, h: number): Layout {
  if (w < COMPACT_WIDTH) return "phone";
  return h < SHORT_HEIGHT ? "short" : "desktop";
}

function boardCell(width: number): number {
  // Phone before the board area is measured: the board spans the screen (6px frame on each side).
  if (width < COMPACT_WIDTH) return Math.max(30, Math.min(56, Math.floor((width - 28) / BOARD_W)));
  return width < 900 ? 38 : width < 1280 ? 50 : 60;
}

/** Largest cell that fits the measured board area (phone and short layouts). */
function fitCell(area: { w: number; h: number }): number {
  return Math.max(22, Math.min(64, Math.floor(Math.min(area.w / BOARD_W, area.h / BOARD_H))));
}

/** A sale that nothing has happened after yet: taking it back restores the state and action log from before it. */
interface UndoSell {
  state: RunState;
  actions: Action[];
  name: string;
  gold: number;
}

/** An item waiting for the Pokémon it is used on (TM, Mint, Bottle Cap) or the shop slot (Master Ball). */
type Targeting = { kind: "pokemon"; uid: string } | { kind: "masterBall"; uid: string } | null;

const USED_ON_POKEMON = new Set(["TM", "MINT", "BOTTLE_CAP"]);

function pendingKey(state: RunState) {
  return `pokebattles.pending.${state.runId}.${state.round}`;
}

function loadPending(initial: RunState): { state: RunState; actions: Action[] } {
  try {
    const raw = localStorage.getItem(pendingKey(initial));
    if (raw) {
      const actions = JSON.parse(raw) as Action[];
      let s = initial;
      for (const a of actions) s = applyAction(s, a);
      return { state: s, actions };
    }
  } catch {
    /* stale or invalid log: start clean */
  }
  return { state: initial, actions: [] };
}

function offerProbe(offer: Offer): Piece {
  if (offer.kind === "pokemon") {
    return { uid: "__probe", kind: "pokemon", place: null, paid: 0, species: offer.species, level: 1, ivs: offer.ivs, nature: offer.nature, ability: offer.ability, hiddenAbility: false, shiny: false, moves: [], disabled: [], taught: [], battles: 0, aceBonus: 0, pendingEvolution: null };
  }
  if (offer.kind === "bag") return { uid: "__probe", kind: "bag", place: null, paid: 0, bag: offer.bag };
  return { uid: "__probe", kind: "item", place: null, paid: 0, item: offer.item, age: 0, ...(offer.param ? { param: offer.param } : {}) };
}

export function RunScreen({
  api,
  initial,
  onBattle,
  onQuit,
}: {
  api: GameApi;
  initial: RunState;
  onBattle: (turn: TurnResponse, before: RunState) => void;
  onQuit: () => void;
}) {
  const { tr } = useI18n();
  const restored = useMemo(() => loadPending(initial), [initial]);
  const [state, setState] = useState<RunState>(restored.state);
  const [actions, setActions] = useState<Action[]>(restored.actions);
  const [target, setTarget] = useState<DetailTarget>(null);
  const [drag, setDragState] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const setDrag = (d: DragState | null) => {
    dragRef.current = d;
    setDragState(d);
  };
  const [toast, setToast] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [showRecipes, setShowRecipes] = useState(false);
  const [targeting, setTargeting] = useState<Targeting>(null);
  const [busy, setBusy] = useState(false);
  /** A reroll, Poké Ball or subclass choice is being committed by the server; the board waits for it. */
  const [waiting, setWaiting] = useState(false);
  const waitingRef = useRef(false);
  const [notices, setNotices] = useState(initial.notices);
  const [undo, setUndo] = useState<UndoSell | null>(null);
  const [view, setView] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const layout = layoutFor(view.w, view.h);
  const compact = layout !== "desktop";
  /** A short phone (SE-size, or with the browser bars showing): the dock folds into one row to leave the board room. */
  const tight = layout === "phone" && view.h < TIGHT_HEIGHT;
  const [area, setArea] = useState<{ w: number; h: number } | null>(null);
  const cell = compact && area ? fitCell(area) : boardCell(view.w);
  /** Detail is a sheet over the board (.detail-sheet) rather than a column beside it. */
  const sheetDetail = view.w <= 1100 || layout === "short";
  const coarse = useMemo(() => window.matchMedia?.("(pointer: coarse)").matches ?? false, []);
  const boardRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const stashRef = useRef<HTMLDivElement>(null);
  const sellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const fit = () => setView({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", fit);
    window.addEventListener("orientationchange", fit);
    return () => {
      window.removeEventListener("resize", fit);
      window.removeEventListener("orientationchange", fit);
    };
  }, []);

  // Phone and short layouts give the board whatever the screen has left; the cell size follows it.
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!compact || !el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]!.contentRect;
      setArea((a) => (a && a.w === r.width && a.h === r.height ? a : { w: r.width, h: r.height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [compact]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  /** Unsent actions of this round survive a reload (the server already has everything before them). */
  const saveLog = useCallback(
    (log: Action[]) => {
      try {
        localStorage.setItem(pendingKey(initial), JSON.stringify(log));
      } catch {
        /* ignore */
      }
    },
    [initial],
  );

  const showCombined = useCallback(
    (next: RunState) => {
      const combined = next.notices.filter((n) => n.key === "notice.combined");
      if (combined.length > 0) setToast(combined.map((n) => noticeText(tr, n)).join("  "));
    },
    [tr],
  );

  const errorToast = useCallback(
    (e: unknown) => {
      sound.playSe("ui/error");
      setToast(tr.t(`error.${e instanceof GameError ? e.code : "default"}`, { max: partyCap(state) }));
    },
    [tr, state],
  );

  /**
   * Online the seed stays on the server, so rerolls, Poké Balls and the subclass shop are resolved
   * there: the actions so far plus this one are committed, and the returned state replaces ours.
   */
  const commit = useCallback(
    async (a: Action) => {
      waitingRef.current = true;
      setWaiting(true);
      setUndo(null);
      try {
        const next = await api.act(state.runId, initial.round, [...actions, a]);
        setState(next);
        setActions([]);
        saveLog([]);
        showCombined(next);
        actionSound(a, state, next);
      } catch (e) {
        errorToast(e);
      } finally {
        waitingRef.current = false;
        setWaiting(false);
      }
    },
    [api, state, actions, initial, saveLog, showCombined, errorToast],
  );

  const act = useCallback(
    (a: Action): boolean => {
      if (waitingRef.current) return false;
      try {
        const next = applyAction(state, a);
        const log = [...actions, a];
        setState(next);
        showCombined(next);
        setActions(log);
        saveLog(log);
        actionSound(a, state, next);
        // Only a sale can be taken back, and only until the next action.
        if (a.t === "sell") {
          const p = state.pieces[a.uid]!;
          const name = p.kind === "pokemon" ? tr.species(p.species) : p.kind === "item" ? tr.itemName(p.item, p.param) : tr.itemName(p.bag);
          setUndo({ state, actions, name, gold: next.gold - state.gold });
        } else setUndo(null);
        return true;
      } catch (e) {
        if (e instanceof GameError && e.code === "needs_server") {
          void commit(a);
          return true;
        }
        errorToast(e);
        return false;
      }
    },
    [state, actions, commit, saveLog, showCombined, errorToast, tr],
  );

  const undoSell = useCallback(() => {
    if (!undo || waitingRef.current) return;
    setState(undo.state);
    setActions(undo.actions);
    saveLog(undo.actions);
    setUndo(null);
    setTarget(null);
  }, [undo, saveLog]);

  // Ctrl+Z / ⌘Z takes a sale back on a keyboard.
  useEffect(() => {
    if (!undo) return;
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z" || e.code === "KeyZ") && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        sound.playSe("ui/select");
        undoSell();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [undo, undoSell]);

  // ── drag & drop
  const dragShape = (d: DragState): Cell[] => {
    if (d.source.kind === "piece") {
      const p = state.pieces[d.source.uid];
      return p ? pieceShape(p) : [];
    }
    const offer = state.shop[d.source.slot]?.offer;
    return offer ? pieceShape(offerProbe(offer)) : [];
  };

  const hoverPlacement = (d: DragState): Placement | null => {
    const el = boardRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (d.x < r.left || d.x > r.right || d.y < r.top || d.y > r.bottom) return null;
    const shape = dragShape(d);
    const size = shapeSize(rotateShape(shape, d.rot));
    // Centre the piece on the cursor, but keep it on the board near the edges.
    const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v));
    const fx = (d.x - r.left) / cell - size.w / 2;
    const fy = (d.y - r.top) / cell - size.h / 2;
    const centred: Placement = { x: clamp(Math.round(fx), BOARD_W - size.w), y: clamp(Math.round(fy), BOARD_H - size.h), rot: d.rot };
    const probe = probeFor(d);
    if (!probe || probe.kind === "bag") return centred;
    const onBags = computeLayout(Object.values(state.pieces), probe.uid).usable;
    if (placeShape(shape, centred).every((c) => onBags.has(cellKey(c)))) return centred;
    // Turned near a bag's edge the centred footprint hangs off the bag: slide to the closest spot
    // that still covers the cursor's cell and fits without pushing anything aside.
    const under = { x: Math.floor((d.x - r.left) / cell), y: Math.floor((d.y - r.top) / cell) };
    let best: Placement | null = null;
    let bestDist = Infinity;
    for (let y = under.y - size.h + 1; y <= under.y; y++) {
      for (let x = under.x - size.w + 1; x <= under.x; x++) {
        const place: Placement = { x, y, rot: d.rot };
        const dist = (x - fx) ** 2 + (y - fy) ** 2;
        if (dist >= bestDist || checkPlacement(state.pieces, probe, place) !== null) continue;
        if (!placeShape(shape, place).some((c) => c.x === under.x && c.y === under.y)) continue;
        best = place;
        bestDist = dist;
      }
    }
    return best ?? centred;
  };

  const over = (ref: RefObject<HTMLDivElement | null>, d: DragState) => {
    const el = ref.current;
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return d.x >= r.left && d.x <= r.right && d.y >= r.top && d.y <= r.bottom;
  };

  const probeFor = (d: DragState): Piece | null => {
    if (d.source.kind === "piece") return state.pieces[d.source.uid] ?? null;
    const offer = state.shop[d.source.slot]?.offer;
    return offer ? offerProbe(offer) : null;
  };

  const preview: BoardPreview | null = useMemo(() => {
    if (!drag?.started) return null;
    const place = hoverPlacement(drag);
    const probe = probeFor(drag);
    if (!place || !probe) return null;
    const pieces = drag.source.kind === "shop" ? { ...state.pieces, __probe: probe } : state.pieces;
    const cells = placeShape(dragShape(drag), place);
    if (probe.kind === "bag") return { cells, valid: checkPlacement(pieces, probe, place) === null };
    const stashed = Object.values(state.pieces).filter((p) => p.place === null).length - (drag.source.kind === "piece" && !probe.place ? 1 : 0);
    const plan = planDrop(pieces, probe, place, stashed < STASH_LIMIT);
    return { cells, valid: plan.ok, ...(plan.ok && plan.displaced ? { displacedUid: plan.displaced.uid } : {}) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, state, cell]);

  /**
   * What the focused item reaches (★ cells and the Pokémon inside them), and which item a dragged
   * item would combine with. Dragging a Pokémon instead lights up the items that would reach it.
   */
  const focus = useMemo(() => {
    const out = { stars: new Set<number>(), affected: new Set<string>(), recipeUid: null as string | null, recipeOut: null as string | null, itemCells: new Set<number>() };
    const markAffected = (skip: string | null) => {
      for (const p of Object.values(state.pieces)) {
        if (p.kind === "pokemon" && p.place && p.uid !== skip && cellsOf(p).some((c) => out.stars.has(cellKey(c)))) out.affected.add(p.uid);
      }
    };
    if (drag?.started) {
      const place = hoverPlacement(drag);
      const probe = probeFor(drag);
      if (!place || !probe) return out;
      const own = placeShape(pieceShape(probe), place);
      if (probe.kind === "item") {
        for (const c of reachCells(own, itemReach(probe.item), place.rot)) out.stars.add(cellKey(c));
        markAffected(null);
        const moved = { ...probe, place };
        const found = preview?.valid ? recipePartner({ ...state.pieces, [moved.uid]: moved }, moved) : null;
        if (found) {
          out.recipeUid = found.partner.uid;
          out.recipeOut = found.output;
        }
      } else if (probe.kind === "pokemon") {
        const ownKeys = new Set(own.map(cellKey));
        for (const p of Object.values(state.pieces)) {
          if (p.kind === "item" && p.place && itemReachCells(p).some((c) => ownKeys.has(cellKey(c)))) for (const c of cellsOf(p)) out.itemCells.add(cellKey(c));
        }
      }
      return out;
    }
    const uid = hovered ?? (target?.kind === "piece" ? target.uid : null);
    const p = uid ? state.pieces[uid] : undefined;
    if (p?.kind === "item" && p.place) {
      for (const c of itemReachCells(p)) out.stars.add(cellKey(c));
      markAffected(null);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, state, hovered, target, preview, cell]);

  const finishDrag = useCallback(
    (d: DragState) => {
      if (!d.started) {
        // A click: select, or resolve a pending target pick.
        if (d.source.kind === "piece") {
          const uid = d.source.uid;
          if (targeting?.kind === "pokemon") {
            if (act({ t: "use", uid: targeting.uid, target: uid })) setTarget({ kind: "piece", uid });
            setTargeting(null);
            return;
          }
          sound.playSe("ui/select");
          setTarget({ kind: "piece", uid });
        } else {
          if (targeting?.kind === "masterBall") {
            act({ t: "use", uid: targeting.uid, slot: d.source.slot });
            setTargeting(null);
            return;
          }
          sound.playSe("ui/select");
          setTarget({ kind: "offer", slot: d.source.slot });
        }
        return;
      }
      const place = hoverPlacement(d);
      if (over(sellRef, d) && d.source.kind === "piece") {
        act({ t: "sell", uid: d.source.uid });
        setTarget(null);
        return;
      }
      if (over(stashRef, d)) {
        if (d.source.kind === "shop") act({ t: "buy", slot: d.source.slot });
        else act({ t: "move", uid: d.source.uid, place: null });
        return;
      }
      if (place) {
        if (d.source.kind === "shop") {
          const uid = `u${state.nextUid}`;
          // Beside the board the detail panel follows the purchase; as a bottom sheet it would cover the board.
          if (act({ t: "buy", slot: d.source.slot, place }) && !sheetDetail) setTarget({ kind: "piece", uid });
        } else act({ t: "move", uid: d.source.uid, place });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [act, state, targeting, cell, sheetDetail],
  );

  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d || e.pointerId !== d.pointerId) return;
      // A finger wobbles more than a mouse, so a tap needs more slack before it turns into a drag.
      const started = d.started || Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > (d.touch ? 10 : 5);
      setDrag({ ...d, x: e.clientX, y: e.clientY - (started ? d.lift : 0), started });
    };
    const up = (e: PointerEvent) => {
      const d = dragRef.current;
      if (e.button !== 0 || (d && e.pointerId !== d.pointerId)) return;
      setDrag(null);
      if (d) finishDrag(d);
    };
    // The browser took the touch over (system gesture, scroll): drop nothing.
    const cancel = (e: PointerEvent) => {
      if (dragRef.current?.pointerId === e.pointerId) setDrag(null);
    };
    const rotate = () => {
      const d = dragRef.current;
      if (d) setDrag({ ...d, rot: ((d.rot + 1) % 4) as Rot, started: true, y: d.started ? d.y : d.y - d.lift });
    };
    const secondFinger = (e: PointerEvent) => {
      const d = dragRef.current;
      if (d?.touch && e.pointerId !== d.pointerId) rotate();
    };
    // That tap only rotates: it must not also press the button it landed on (Fight, a shop lock…).
    const swallowClick = (e: MouseEvent) => {
      if (dragRef.current?.touch) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const key = (e: KeyboardEvent) => {
      // e.code is the physical key, so R rotates even with the Korean IME on (e.key would be "ㄱ").
      if (isRotateKey(e)) rotate();
      if (e.key === "Escape") setDrag(null);
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      rotate();
    };
    // A right-click while the left button is held does not fire pointerdown, but mousedown fires.
    const down = (e: MouseEvent) => {
      if (e.button === 2) rotate();
    };
    const noMenu = (e: MouseEvent) => e.preventDefault();
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("pointerdown", secondFinger);
    window.addEventListener("click", swallowClick, true);
    window.addEventListener("keydown", key);
    window.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("mousedown", down);
    window.addEventListener("contextmenu", noMenu);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("pointerdown", secondFinger);
      window.removeEventListener("click", swallowClick, true);
      window.removeEventListener("keydown", key);
      window.removeEventListener("wheel", wheel);
      window.removeEventListener("mousedown", down);
      window.removeEventListener("contextmenu", noMenu);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging, finishDrag]);

  const startDrag = (e: ReactPointerEvent, source: DragSource) => {
    if (e.button !== 0 || state.phase !== "shop") return;
    // A second finger landing on a piece rotates the one being dragged (window listener) instead.
    const active = dragRef.current;
    if (active?.touch && active.pointerId !== e.pointerId) return;
    e.preventDefault();
    const rot = source.kind === "piece" ? (state.pieces[source.uid]?.place?.rot ?? 0) : 0;
    const touch = e.pointerType === "touch";
    setDrag({ source, rot, x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, started: false, pointerId: e.pointerId, touch, lift: touch ? Math.round(cell * 0.9) : 0 });
  };

  // Highlight what the selection touches.
  const highlight = useMemo(() => {
    const out = new Set<number>();
    if (!target || target.kind !== "piece") return out;
    const piece = state.pieces[target.uid];
    if (!piece?.place) return out;
    const adj = computeAdjacency(state.pieces);
    const cellsOfUid = (uid: string) => {
      const p = state.pieces[uid];
      return p?.place ? placeShape(pieceShape(p), p.place) : [];
    };
    const related = piece.kind === "pokemon" ? (adj.itemsOf.get(piece.uid) ?? []).map((i) => i.uid) : (adj.holdersOf.get(piece.uid) ?? []);
    for (const uid of related) for (const c of cellsOfUid(uid)) out.add(cellKey(c));
    return out;
  }, [target, state]);
  const boardHighlight = useMemo(() => new Set([...highlight, ...focus.itemCells]), [highlight, focus]);

  const fight = async () => {
    setBusy(true);
    try {
      const turn = await api.playTurn(state.runId, initial.round, actions);
      try {
        localStorage.removeItem(pendingKey(initial));
      } catch {
        /* ignore */
      }
      onBattle(turn, state);
    } catch (e) {
      const code = e instanceof GameError ? e.code : "default";
      setToast(tr.t(`error.${code}`));
      setBusy(false);
      if (code === "round_mismatch") {
        const fresh = await api.getRun(state.runId);
        setState(fresh);
        setActions([]);
        saveLog([]);
        setUndo(null);
      }
    }
  };

  /** Rotates a placed piece a quarter turn around its centre, sliding it to the nearest spot that fits. */
  const rotateInPlace = useCallback(
    (uid: string) => {
      const p = state.pieces[uid];
      if (!p?.place) return;
      // No spot fits: try the plain turn anyway so the toast explains why.
      act({ t: "move", uid, place: rotationSpot(state, uid) ?? { ...p.place, rot: ((p.place.rot + 1) % 4) as Rot } });
    },
    [state, act],
  );

  // R without dragging rotates the piece under the mouse, or else the selected piece.
  useEffect(() => {
    if (dragging) return;
    const key = (e: KeyboardEvent) => {
      if (!isRotateKey(e) || e.target instanceof HTMLInputElement) return;
      const uid = hovered ?? (target?.kind === "piece" ? target.uid : null);
      if (uid) rotateInPlace(uid);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [dragging, hovered, target, rotateInPlace]);

  const useItem = (uid: string) => {
    const p = state.pieces[uid];
    if (!p || p.kind !== "item") return;
    if (USED_ON_POKEMON.has(p.item)) setTargeting({ kind: "pokemon", uid });
    else if (p.item === "MASTER_BALL") setTargeting({ kind: "masterBall", uid });
    else if (act({ t: "use", uid })) setTarget(null);
  };

  const stash = Object.values(state.pieces).filter((p) => p.place === null);
  const champ = CHAMPIONS[state.champion];
  // The ghost shows the rotated footprint with the sprite kept upright.
  const dragVisual = (() => {
    if (!drag?.started) return null;
    const cells = rotateShape(dragShape(drag), drag.rot);
    const { w, h } = shapeSize(cells);
    let species: string | null = null;
    let shiny = false;
    let item: { item: string; param?: string } | null = null;
    if (drag.source.kind === "shop") {
      const offer = state.shop[drag.source.slot]?.offer;
      if (!offer) return null;
      if (offer.kind === "pokemon") {
        species = offer.species;
        shiny = offer.shiny;
      } else if (offer.kind === "item") item = offer;
    } else {
      const p = state.pieces[drag.source.uid];
      if (!p) return null;
      if (p.kind === "pokemon") {
        species = p.species;
        shiny = p.shiny;
      } else if (p.kind === "item") item = p;
    }
    return (
      <div className="ghost-box" style={{ width: w * cell, height: h * cell }}>
        {species === null &&
          !item &&
          cells.map((c) => <div key={`${c.x}-${c.y}`} className="ghost-bag-cell" style={{ left: c.x * cell, top: c.y * cell, width: cell, height: cell }} />)}
        {species !== null && (
          <div
            className="ghost-fp"
            style={{ "--tc": TYPE_COLORS[getSpecies(species).types[0]!], "--cell": `${cell}px` } as React.CSSProperties}
          >
            <PokemonSprite
              species={species}
              formKey={getSpecies(species).spriteForm}
              shiny={shiny}
              width={w * cell - 6}
              height={h * cell - 12}
              maxScale={3}
              animate={false}
              valign={h > w ? "middle" : "bottom"}
            />
            {w * h > 1 && <span className="size-badge">{`${w}×${h}`}</span>}
          </div>
        )}
        {item && (
          <div className={`ghost-item ${w * h > 1 ? "big" : ""}`} style={{ "--cell": `${cell}px` } as React.CSSProperties}>
            <ItemIcon item={item.item} param={item.param} size={Math.min(w, h) * cell - 16} />
            {w * h > 1 && <span className="size-badge">{`${w}×${h}`}</span>}
          </div>
        )}
        {focus.recipeOut && <span className="ghost-recipe">★ {tr.itemName(focus.recipeOut)}</span>}
      </div>
    );
  })();

  const hint = coarse ? tr.t("ui.touchHint") : tr.t("ui.controlsHint");
  const nextCap = PARTY_CAP_STEPS.find(([from]) => from > state.round);

  return (
    <ShinyLines.Provider value={state.cosmetics?.shinyLines}>
      <div className={`run-screen layout-${layout} ${tight ? "tight" : ""} ${sheetDetail ? "detail-sheet" : ""}`}>
        <header className="top-bar panel">
          <TrainerSprite champion={state.champion} width={48} height={56} />
          <div className="who">
            <b>{state.playerName}</b>
            <span className="muted small">
              {tr.trainer(state.champion)}
              {state.subclass ? ` · ${tr.t(`subclass.${state.subclass}.name`)}` : ""}
            </span>
          </div>
          <div className="stat-chip">{compact ? tr.t("ui.roundShort", { n: state.round }) : tr.t("ui.roundOf", { n: state.round, max: MAX_ROUNDS })}</div>
          <div className="stat-chip gold" title={tr.t("ui.gold")}>
            ◎ {state.gold}G
          </div>
          <div className="stat-chip lives" title={tr.t("ui.lives")}>
            {compact ? `♥${Math.max(0, state.lives)}` : "♥".repeat(Math.max(0, state.lives))}
          </div>
          <div className={`stat-chip ${partyCount(state) >= partyCap(state) ? "full" : ""}`} title={tr.t("ui.partyGrowth")}>
            {tr.t("ui.party", { n: partyCount(state), max: partyCap(state) })}
            {nextCap && !compact && (
              <span className="muted small"> · {tr.t("ui.partyNext", { round: nextCap[0], max: partyCap({ ...state, round: nextCap[0] }) })}</span>
            )}
          </div>
          <div className="stat-chip">🏆 {compact ? `${state.wins}/${WINS_TO_CLEAR}` : tr.t("ui.wins", { n: state.wins, max: WINS_TO_CLEAR })}</div>
          {state.streak > 1 && <div className="stat-chip streak">{tr.t("ui.streak", { n: state.streak })}</div>}
          <div className="spacer" />
          {state.ranked ? (
            <div className="mode-tag ranked">{tr.t("ui.rankedTag")}</div>
          ) : (
            <div className={`mode-tag ${api.mode}`}>{api.mode === "online" ? tr.t("ui.online") : tr.t("ui.offline")}</div>
          )}
          {compact && (
            <button
              className="btn btn-small icon-btn"
              data-sfx="ui/menu_open"
              aria-label={tr.t("ui.recipes")}
              title={tr.t("ui.recipes")}
              onClick={() => setShowRecipes(true)}
            >
              📖
            </button>
          )}
          <SoundButton />
          <button className={`btn btn-small ${compact ? "icon-btn" : ""}`} aria-label={tr.t("ui.backToTitle")} title={tr.t("ui.backToTitle")} onClick={onQuit}>
            {compact ? "⌂" : tr.t("ui.backToTitle")}
          </button>
        </header>

        <main className="run-main">
          <div className="left-col">
            <Shop
              state={state}
              compact={compact}
              selectedSlot={target?.kind === "offer" ? target.slot : null}
              targetingShop={targeting?.kind === "masterBall"}
              onSlotPointerDown={(e, slot) => startDrag(e, { kind: "shop", slot })}
              onLock={(slot) => act({ t: "lock", slot })}
              onReroll={() => act({ t: "reroll" })}
            />
            <div className="board-wrap">
              <div ref={areaRef} className="board-area">
                <Board
                  ref={boardRef}
                  state={state}
                  cell={cell}
                  selected={target?.kind === "piece" ? target.uid : null}
                  highlight={boardHighlight}
                  preview={preview}
                  draggingUid={drag?.started && drag.source.kind === "piece" ? drag.source.uid : null}
                  stars={focus.stars}
                  affected={focus.affected}
                  recipeUid={focus.recipeUid}
                  onHover={(uid) => {
                    if (!dragRef.current) setHovered(uid);
                  }}
                  onPiecePointerDown={(e, uid) => startDrag(e, { kind: "piece", uid })}
                  onPieceContext={(uid) => {
                    // A right-click while dragging rotates the dragged piece; it must not sell what lies under it.
                    if (dragRef.current) return;
                    const p = state.pieces[uid];
                    if (p && act({ t: "sell", uid })) setToast(tr.t("ui.sellFor", { gold: sellValue(state, p) }));
                    setTarget(null);
                  }}
                  onBackgroundClick={() => setTarget(null)}
                />
              </div>
              <div className="board-side">
                <div ref={stashRef} className={`stash panel ${drag?.started ? "drop" : ""}`}>
                  <div className="panel-title">
                    <span>
                      {tr.t("ui.stash")} <span className="muted small">{`${stash.length}/${STASH_LIMIT}`}</span>
                    </span>
                    <span className="muted small stash-hint">{tr.t("ui.stashHint")}</span>
                  </div>
                  <div className="stash-items">
                    {stash.length === 0 && compact && <span className="stash-empty muted small">{hint}</span>}
                    {stash.map((p) => (
                      <div
                        key={p.uid}
                        className={`stash-item ${target?.kind === "piece" && target.uid === p.uid ? "sel" : ""}`}
                        onPointerDown={(e) => startDrag(e, { kind: "piece", uid: p.uid })}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          // A long press on a touch screen also opens the context menu; it must not sell.
                          if (dragRef.current) return;
                          act({ t: "sell", uid: p.uid });
                        }}
                      >
                        {p.kind === "pokemon" ? (
                          <PokemonSprite
                            species={p.species}
                            formKey={getSpecies(p.species).spriteForm}
                            shiny={p.shiny}
                            width={compact ? 38 : 52}
                            height={compact ? 38 : 52}
                            animate={false}
                          />
                        ) : p.kind === "item" ? (
                          <ItemIcon item={p.item} param={p.param} size={compact ? 30 : 40} />
                        ) : (
                          <>
                            <BagIcon bag={p.bag} size={compact ? 30 : 40} />
                            {/* A Berry Pouch in the stash would otherwise look like any held item. */}
                            <span className="stash-bag-tag" title={tr.t("ui.bagTag")}>
                              🎒
                            </span>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
                <div
                  ref={sellRef}
                  className={`sell-zone ${drag?.started && drag.source.kind === "piece" ? "active" : ""} ${undo && !drag?.started ? "has-undo" : ""}`}
                >
                  {undo && !drag?.started ? (
                    <button className="undo-btn" onClick={undoSell}>
                      <span>↶ {tr.t("ui.undoSell")}</span>
                      <span className="undo-what">{tr.t("ui.undoSellHint", { name: undo.name, gold: undo.gold })}</span>
                    </button>
                  ) : (
                    <>🗑 {compact ? tr.t("ui.sellShort") : tr.t("ui.sellZone")}</>
                  )}
                </div>
                <button className="btn btn-primary fight-btn" data-sfx="se/pb_throw" disabled={busy || waiting || state.phase !== "shop"} onClick={fight}>
                  {busy ? tr.t("ui.matching") : `⚔ ${tr.t("ui.fight")}`}
                </button>
                {!compact && (
                  <button className="btn btn-small" data-sfx="ui/menu_open" onClick={() => setShowRecipes(true)}>
                    📖 {tr.t("ui.recipes")}
                  </button>
                )}
                {!compact && <div className="muted small hint">{hint}</div>}
              </div>
            </div>
          </div>
          <Detail
            state={state}
            target={target}
            hint={hint}
            suppressed={!!drag?.started || targeting !== null}
            onClose={() => setTarget(null)}
            onSetAce={(uid) => act({ t: "setAce", uid })}
            onRotate={rotateInPlace}
            onUse={useItem}
            onSell={(uid) => {
              if (act({ t: "sell", uid })) setTarget(null);
            }}
          />
        </main>

        {showRecipes && <RecipeBook champion={state.champion} onClose={() => setShowRecipes(false)} />}
        {targeting && (
          <div className="targeting-bar">
            {targeting.kind === "pokemon" ? tr.t("ui.pickTarget") : tr.t("ui.pickShopSlot")}
            <button className="btn btn-small" onClick={() => setTargeting(null)}>
              {tr.t("ui.cancel")}
            </button>
          </div>
        )}

        {state.phase === "subclass" && (
          <div className="modal-back">
            <div className="modal panel">
              <h2>{tr.t("ui.subclassTitle")}</h2>
              <p className="muted small">{tr.t("ui.subclassHint")}</p>
              <div className="subclass-options">
                {champ.subclasses.map((s) => (
                  <button key={s} className="subclass-card" data-sfx="none" onClick={() => act({ t: "chooseSubclass", subclass: s })}>
                    <b>{tr.t(`subclass.${s}.name`)}</b>
                    <span>{tr.t(`subclass.${s}.desc`)}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {notices.length > 0 && (
          <div className="notices panel" onClick={() => setNotices([])}>
            {notices.map((n, i) => (
              <div key={i}>{noticeText(tr, n)}</div>
            ))}
          </div>
        )}

        {toast && <div className="toast">{toast}</div>}
        {drag?.started && drag.touch && <div className="rotate-pill">↻ {tr.t("ui.rotateTap")}</div>}
        {dragVisual && (
          <div className="drag-ghost" style={{ left: drag!.x, top: drag!.y, transform: "translate(-50%, -50%)" }}>
            {dragVisual}
          </div>
        )}
      </div>
    </ShinyLines.Provider>
  );
}

/** The sound for an action that went through (buttons already click on their own). */
function actionSound(a: Action, before: RunState, after: RunState): void {
  const notice = (key: string) => after.notices.some((n) => n.key === key);
  if (notice("notice.combined")) sound.playSe("se/sparkle");
  else if (notice("notice.evolved") || notice("notice.candy")) sound.playSe("se/level_up");
  switch (a.t) {
    case "buy":
      sound.playSe("se/buy");
      break;
    case "sell":
      // The till again, a little lower: money coming back.
      sound.playSe("se/buy", { rate: 0.88 });
      break;
    case "move":
      sound.playSe("se/pb_move");
      break;
    case "use": {
      // A Poké Ball, voucher or fossil hands over a Pokémon.
      const mons = (s: RunState) => Object.values(s.pieces).filter((p) => p.kind === "pokemon").length;
      sound.playSe(mons(after) > mons(before) ? "se/pb_rel" : "se/restore");
      break;
    }
    case "chooseSubclass":
      sound.playSe("se/level_up");
      break;
    default:
      break;
  }
}

export function noticeText(tr: ReturnType<typeof useI18n>["tr"], n: { key: string; params?: Record<string, string | number> }): string {
  const p: Record<string, string | number> = { ...(n.params ?? {}) };
  for (const k of ["from", "to", "species"]) if (typeof p[k] === "string") p[k] = tr.species(p[k] as string);
  for (const k of ["a", "b", "out"]) if (typeof p[k] === "string") p[k] = tr.itemName(p[k] as string);
  if (typeof p.item === "string") p.item = tr.itemName(p.item, typeof p.param === "string" ? p.param : undefined);
  if (typeof p.nature === "string") p.nature = tr.nature(p.nature);
  if (n.key === "notice.income") {
    const parts = Object.entries(n.params ?? {})
      .filter(([k]) => k !== "total")
      .map(([k, v]) => `${tr.t(`incomePart.${k}`)} +${v}`)
      .join(" · ");
    return `${tr.t("notice.income", { total: p.total ?? 0 })} (${parts})`;
  }
  return tr.t(n.key, p);
}
