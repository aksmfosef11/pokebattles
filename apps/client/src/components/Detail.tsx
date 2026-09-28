import { useState, type ReactNode } from "react";
import {
  battleHpMultiplier,
  BAGS,
  calcStats,
  CHAMPION_RULES,
  championReach,
  chooseMoves,
  computeAdjacency,
  CONTENT,
  evolutionLevel,
  getSpecies,
  IMPLEMENTED_ABILITIES,
  isStarterBag,
  itemEvolutions,
  itemReach,
  ITEMS,
  itemSize,
  reachCells,
  RECIPES,
  type Cell,
  moveSlotsFor,
  natureEffect,
  sellValue,
  STAT_KEYS,
  type EvolutionDef,
  type Nature,
  type PokemonPiece,
  type RunState,
  type Stats,
} from "@pokebattles/game";
import { useI18n } from "../i18n.tsx";
import { BagShapeChip, SizeChip } from "./Shop.tsx";
import { BagIcon, ItemIcon, PokemonSprite, TypeBadge } from "./sprites.tsx";

export type DetailTarget = { kind: "piece"; uid: string } | { kind: "offer"; slot: number } | null;

interface DetailProps {
  state: RunState;
  target: DetailTarget;
  /** Shown when nothing is selected. */
  hint: string;
  /** Hidden while a drag or a target pick needs the screen (narrow layouts show Detail as a bottom sheet). */
  suppressed?: boolean;
  onClose: () => void;
  onSetAce: (uid: string) => void;
  onRotate: (uid: string) => void;
  onUse: (uid: string) => void;
  onSell: (uid: string) => void;
}

interface MonView {
  species: string;
  level: number;
  ivs: Stats;
  nature: Nature;
  ability: string;
  hiddenAbility: boolean;
  shiny: boolean;
  moves: string[];
  disabled: string[];
  uid?: string;
  battles?: number;
  pendingEvolution?: string | null;
  aceBonus?: number;
  nickname?: string;
}

function EvolutionLines({ state, mon }: { state: RunState; mon: MonView }) {
  const { tr } = useI18n();
  const evos = getSpecies(mon.species).evolutions;
  if (evos.length === 0) return null;
  const line = (e: EvolutionDef) => {
    const to = tr.species(e.to);
    if (e.item) return tr.t("ui.evolvesWithItem", { item: tr.itemName(e.item), to });
    if (e.adjacentType) return tr.t("ui.evolvesNextToType", { type: tr.type(e.adjacentType), to });
    if (e.onResult === "win") return tr.t("ui.evolvesOnWin", { battles: e.battles ?? 0, to });
    if (e.onResult === "loss") return tr.t("ui.evolvesOnLoss", { battles: e.battles ?? 0, to });
    if (e.battles !== undefined) return tr.t("ui.evolvesByBattles", { battles: e.battles, to });
    const lvl = evolutionLevel(state, { species: mon.species } as PokemonPiece, e);
    return tr.t("ui.evolvesAtLevel", { level: lvl ?? "?", to });
  };
  return (
    <div className="detail-block">
      <div className="label">{tr.t("ui.evolution")}</div>
      {mon.pendingEvolution && <div className="warn small">{tr.t("ui.evolutionPending")}</div>}
      <ul className="evo-list">
        {evos.map((e, i) => (
          <li key={i}>{line(e)}</li>
        ))}
      </ul>
    </div>
  );
}

function PokemonDetail({ state, mon, onSetAce, onSell, onRotate, placedUid }: { state: RunState; mon: MonView; placedUid?: string } & Pick<DetailProps, "onSetAce" | "onSell" | "onRotate">) {
  const { tr } = useI18n();
  const [openMove, setOpenMove] = useState<string | null>(null);
  const species = getSpecies(mon.species);
  const stats = calcStats(species.baseStats, mon.ivs, mon.level, mon.nature);
  const hpMult = battleHpMultiplier(state.round);
  const { up, down } = natureEffect(mon.nature);
  const ivSum = STAT_KEYS.reduce((s, k) => s + mon.ivs[k], 0);
  const implemented = IMPLEMENTED_ABILITIES.has(mon.ability);
  const adjacentItems = placedUid ? (computeAdjacency(state.pieces).itemsOf.get(placedUid) ?? []) : [];
  const piece = mon.uid ? (state.pieces[mon.uid] as PokemonPiece | undefined) : undefined;

  return (
    <>
      <div className="detail-head">
        <PokemonSprite species={mon.species} formKey={species.spriteForm} shiny={mon.shiny} width={112} height={112} maxScale={2.5} />
        <div>
          <h3>
            {mon.nickname ? (
              <>
                {mon.nickname} <span className="muted small">{tr.species(mon.species)}</span>
              </>
            ) : (
              tr.species(mon.species)
            )}{" "}
            {mon.shiny && <span className="shiny" title={tr.t("ui.shiny")}>✦</span>}
          </h3>
          <div>{tr.t("ui.level", { n: mon.level })}</div>
          <div className="types">
            {species.types.map((t) => (
              <TypeBadge key={t} type={t} />
            ))}
          </div>
          <div className="muted small">
            {tr.t("ui.tier", { n: species.tier })} · {tr.t("ui.size", { w: species.footprint.w, h: species.footprint.h })}
          </div>
          {state.ace === mon.uid && (
            <div className="ace-tag">
              ♛ {tr.t("ui.ace")} · {tr.t("ui.aceBonus", { pct: Math.round((mon.aceBonus ?? 0) * 100) })}
            </div>
          )}
        </div>
      </div>
      <div className="detail-block">
        <div className="label">
          {tr.t(mon.hiddenAbility ? "ui.hiddenAbility" : "ui.ability")} · <b>{tr.ability(mon.ability)}</b>
        </div>
        <p className="small">{tr.abilityDesc(mon.ability)}</p>
        {tr.has(`abilityNote.${mon.ability}`) && <p className="small note">※ {tr.t(`abilityNote.${mon.ability}`)}</p>}
        {!implemented && <p className="small muted">※ {tr.t("ui.abilityInactive")}</p>}
      </div>
      <div className="detail-block">
        <div className="label">
          {tr.t("ui.nature")} · <b>{tr.nature(mon.nature)}</b> · {tr.t("ui.ivs")} {ivSum}/186
        </div>
        <table className="stat-table">
          <tbody>
            {STAT_KEYS.map((k) => (
              <tr key={k} className={k === up ? "up" : k === down ? "down" : ""}>
                <td>{tr.stat(k)}</td>
                <td>{k === "hp" ? Math.floor(stats.hp * hpMult) : stats[k]}</td>
                <td className="bar">
                  <span style={{ width: `${Math.min(100, (species.baseStats[k] / 180) * 100)}%` }} />
                </td>
                <td className="muted small">{mon.ivs[k]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="detail-block">
        <div className="label">{tr.t("ui.moves")}</div>
        <ul className="move-list">
          {mon.moves.map((key) => {
            const m = CONTENT.moves[key];
            if (!m) return null;
            return (
              <li key={key} className="move clickable" title={tr.moveEffect(key)} onClick={() => setOpenMove(openMove === key ? null : key)}>
                <TypeBadge type={m.type} scale={1.5} />
                <span className="move-name">{tr.move(key)}</span>
                <span className="muted small">{tr.t(`ui.category.${m.category}`)}</span>
                <span className="small">{m.power > 0 ? m.power : "—"}</span>
                <span className="small">{m.accuracy ?? "—"}</span>
                <span className="small muted">{m.pp}</span>
                {openMove === key && tr.moveEffect(key) && <span className="move-effect small muted">{tr.moveEffect(key)}</span>}
              </li>
            );
          })}
        </ul>
      </div>
      <EvolutionLines state={state} mon={mon} />
      {adjacentItems.length > 0 && (
        <div className="detail-block">
          <div className="item-row">
            {adjacentItems.map((it) => (
              <span key={it.uid} className="item-chip" title={tr.itemEffect(it.item, it.param)}>
                <ItemIcon item={it.item} param={it.param} size={24} /> {tr.itemName(it.item, it.param)}
              </span>
            ))}
          </div>
        </div>
      )}
      {piece && (
        <div className="detail-actions">
          {piece.place && species.footprint.w !== species.footprint.h && (
            <button className="btn btn-small" data-sfx="none" onClick={() => onRotate(piece.uid)}>
              ↻ {tr.t("ui.rotate")}
            </button>
          )}
          {state.champion === "red" && state.ace !== piece.uid && (
            <button className="btn btn-small" onClick={() => onSetAce(piece.uid)}>
              ♛ {tr.t("ui.setAce")}
            </button>
          )}
          <button className="btn btn-small btn-danger" data-sfx="none" onClick={() => onSell(piece.uid)}>
            {tr.t("ui.sellFor", { gold: sellValue(state, piece) })}
          </button>
        </div>
      )}
    </>
  );
}

export function Detail({ state, target, hint, suppressed, onClose, onSetAce, onUse, onSell, onRotate }: DetailProps) {
  const { tr } = useI18n();
  const empty = <aside className="detail panel empty-detail">{hint}</aside>;
  const sheet = (children: ReactNode) => (
    <aside className={`detail panel ${suppressed ? "suppressed" : ""}`}>
      <button className="detail-close" aria-label={tr.t("ui.close")} onClick={onClose}>
        ✕
      </button>
      {children}
    </aside>
  );
  if (!target) return empty;

  if (target.kind === "offer") {
    const slot = state.shop[target.slot];
    const offer = slot?.offer;
    if (!offer) return empty;
    if (offer.kind === "pokemon") {
      const mon: MonView = { ...offer, moves: chooseMoves(offer.species, offer.level, [], moveSlotsFor(state.subclass)), disabled: [] };
      return sheet(<PokemonDetail state={state} mon={mon} onSetAce={onSetAce} onSell={onSell} onRotate={onRotate} />);
    }
    const key = offer.kind === "item" ? offer.item : offer.bag;
    const param = offer.kind === "item" ? offer.param : undefined;
    return sheet(<ItemDetail state={state} item={key} param={param} />);
  }

  const piece = state.pieces[target.uid];
  if (!piece) return empty;
  if (piece.kind === "pokemon") {
    return sheet(
      <PokemonDetail
        state={state}
        mon={piece}
        placedUid={piece.place ? piece.uid : undefined}
        onSetAce={onSetAce}
        onRotate={onRotate}
        onSell={onSell}
      />,
    );
  }
  const usable = piece.kind === "item" && ["TM", "MINT", "BOTTLE_CAP", "MASTER_BALL", "POKE_BALL", "VOUCHER", "ROOT_FOSSIL", "CLAW_FOSSIL"].includes(piece.item);
  const sellable = !isStarterBag(piece);
  const holders = piece.kind === "item" && piece.place ? (computeAdjacency(state.pieces).holdersOf.get(piece.uid) ?? []) : [];
  // Turning matters for bags, long items and items that point somewhere; touch screens have no R key.
  const rotatable =
    piece.place !== null &&
    (piece.kind === "bag" || itemSize(piece.item).w !== itemSize(piece.item).h || ["front", "line", "row"].includes(itemReach(piece.item)));
  return sheet(
    <>
      <ItemDetail state={state} item={piece.kind === "item" ? piece.item : piece.bag} param={piece.kind === "item" ? piece.param : undefined} />
      {holders.length > 0 && (
        <div className="item-row">
          {holders.map((u) => {
            const h = state.pieces[u] as PokemonPiece;
            return (
              <span key={u} className="item-chip">
                <PokemonSprite species={h.species} formKey={getSpecies(h.species).spriteForm} width={28} height={28} animate={false} /> {tr.species(h.species)}
              </span>
            );
          })}
        </div>
      )}
      <div className="detail-actions">
        {rotatable && (
          <button className="btn btn-small" data-sfx="none" onClick={() => onRotate(piece.uid)}>
            ↻ {tr.t("ui.rotate")}
          </button>
        )}
        {usable && (
          <button className="btn btn-small btn-primary" onClick={() => onUse(piece.uid)}>
            {piece.kind === "item" && piece.item === "TM" ? tr.t("ui.teach") : tr.t("ui.use")}
          </button>
        )}
        {sellable && (
          <button className="btn btn-small btn-danger" data-sfx="none" onClick={() => onSell(piece.uid)}>
            {tr.t("ui.sellFor", { gold: sellValue(state, piece) })}
          </button>
        )}
      </div>
    </>,
  );
}

/** 7×7 sketch of an item (rotation 0, pointing at the enemy) with ★ on the cells it affects. */
function ReachDiagram({ item }: { item: string }) {
  const { w, h } = itemSize(item);
  const ox = 3 - Math.floor((w - 1) / 2);
  const oy = 3 - Math.floor((h - 1) / 2);
  const own: Cell[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) own.push({ x: ox + x, y: oy + y });
  const ownSet = new Set(own.map((c) => `${c.x},${c.y}`));
  // reachCells works on the real board; the sketch reuses it on a 7×7 window near the top-left.
  const stars = new Set(reachCells(own, itemReach(item), 0).map((c) => `${c.x},${c.y}`));
  const cells = [];
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 7; x++) {
      const k = `${x},${y}`;
      cells.push(<span key={k} className={ownSet.has(k) ? "own" : stars.has(k) ? "star" : ""}>{stars.has(k) ? "★" : ""}</span>);
    }
  }
  return <div className="reach-diagram">{cells}</div>;
}

/** Exactly which Pokémon an evolution item evolves, limited to what this champion's run can hold. */
function EvolutionTargets({ state, item }: { state: RunState; item: string }) {
  const { tr } = useI18n();
  if (ITEMS[item]?.family !== "evolution") return null;
  const all = itemEvolutions(item);
  const reach = championReach(state);
  const owned = new Set(Object.values(state.pieces).flatMap((p) => (p.kind === "pokemon" ? [p.species] : [])));
  const mine = all.filter((e) => reach.has(e.from)).sort((a, b) => Number(owned.has(b.from)) - Number(owned.has(a.from)));
  const sprite = (key: string) => <PokemonSprite species={key} formKey={getSpecies(key).spriteForm} width={32} height={32} animate={false} />;
  return (
    <div className="detail-block">
      <div className="label">{tr.t("ui.evolvesWhich")}</div>
      {mine.length === 0 ? (
        <p className="small warn">{tr.t("ui.evolvesNone")}</p>
      ) : (
        <ul className="evo-targets">
          {mine.map((e) => (
            <li key={`${e.from}-${e.to}`} className={owned.has(e.from) ? "owned" : ""}>
              {sprite(e.from)}
              <span>{tr.species(e.from)}</span>
              <span className="muted">→</span>
              {sprite(e.to)}
              <span>{tr.species(e.to)}</span>
              {owned.has(e.from) && <span className="owned-tag">{tr.t("ui.owned")}</span>}
            </li>
          ))}
        </ul>
      )}
      {all.length > mine.length && <p className="small muted">{tr.t("ui.evolvesOthers", { n: all.length - mine.length })}</p>}
      {state.champion === "steven" && ITEMS[item]?.stone && (
        <p className="small note">※ {tr.t("ui.stevenStoneNote", { pct: Math.round(CHAMPION_RULES.steven.stoneDefenseBonus * 100) })}</p>
      )}
    </div>
  );
}

function ItemDetail({ state, item, param }: { state: RunState; item: string; param?: string }) {
  const { tr } = useI18n();
  const isBag = !!BAGS[item];
  const def = ITEMS[item];
  const size = itemSize(item);
  const recipes = RECIPES.filter((r) => r.inputs.includes(item) || r.output === item);
  return (
    <>
      <div className="detail-head">
        {isBag ? <BagIcon bag={item} size={64} /> : <ItemIcon item={item} param={param} size={64} />}
        <div>
          {isBag && <div className="bag-tag">🎒 {tr.t("ui.bagTag")}</div>}
          <h3>{tr.itemName(item, param)}</h3>
          {(def || isBag) && <div className="muted small">{tr.t("ui.tier", { n: def?.tier ?? BAGS[item]!.tier })}</div>}
          {isBag ? (
            <BagShapeChip bag={item} label={tr.t("ui.bagCells", { n: BAGS[item]!.cells.length })} />
          ) : (
            <SizeChip w={size.w} h={size.h} label={tr.t("ui.size", { w: size.w, h: size.h })} />
          )}
        </div>
      </div>
      <div className="detail-block">
        <p>{tr.itemEffect(item, param)}</p>
        {isBag && <p className="small muted">{tr.t("ui.bagKindHint")}</p>}
        {!isBag && item !== "TM" && item !== "TERA_SHARD" && tr.itemFlavor(item) && <p className="small muted">{tr.itemFlavor(item)}</p>}
        {item === "TM" && param && <p className="small muted">{tr.moveEffect(param)}</p>}
      </div>
      <EvolutionTargets state={state} item={item} />
      {!isBag && (
        <div className="detail-block reach-block">
          <ReachDiagram item={item} />
          <div className="small">
            <div>
              {tr.t("ui.reachLabel")}: <b>{tr.t(`reach.${itemReach(item)}`)}</b>
            </div>
            {["front", "line", "row"].includes(itemReach(item)) && <div className="muted">{tr.t("ui.reachRotateHint")}</div>}
          </div>
        </div>
      )}
      {recipes.length > 0 && (
        <div className="detail-block">
          <div className="label">{tr.t("ui.recipes")}</div>
          {recipes.map((r) => (
            <div key={r.inputs.join("+")} className="recipe-line small">
              <ItemIcon item={r.inputs[0]} size={20} /> + <ItemIcon item={r.inputs[1]} size={20} /> → <ItemIcon item={r.output} size={20} /> {tr.itemName(r.output)}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
