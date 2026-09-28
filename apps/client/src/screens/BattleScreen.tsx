import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  battleArena,
  BOARD_H,
  BOARD_W,
  cellsOf,
  CONTENT,
  ITEMS,
  looksShiny,
  simulateBattle,
  touches,
  type Cell,
  type BattleEvent,
  type BattleResult,
  type RunState,
  type TurnResponse,
} from "@pokebattles/game";
import { preloadPokemonSprites, type SpriteRef } from "../assets.ts";
import { BGM, sound } from "../audio.ts";
import { battleStats, TYPE_COLORS } from "../battle/stats.ts";
import { SoundButton } from "../components/SoundButton.tsx";
import { ItemIcon, PokemonSprite, TrainerSprite } from "../components/sprites.tsx";
import { useI18n } from "../i18n.tsx";
import { noticeText } from "./RunScreen.tsx";

const FX_LIFE = 1100;
const TRAIL_LIFE = 450;

interface Fx {
  id: number;
  battler: number;
  text: string;
  cls: string;
  item?: string;
  born: number;
}

interface Trail {
  id: number;
  from: number;
  to: number[];
  color: string;
  big: boolean;
  born: number;
}

interface LogLine {
  id: number;
  cls: string;
  text: string;
}

interface Vis {
  tick: number;
  hp: number[];
  maxHp: number[];
  gauge: number[];
  alive: boolean[];
  status: (string | null)[];
  species: string[];
  formKey: string[];
  big: boolean[];
  tera: (string | null)[];
  weather: string | null;
  terrain: string | null;
  sudden: boolean;
}

/** Every sprite the playback will show: both teams (back sprites for our side) and mid-battle form changes. */
function battleSprites(r: BattleResult, shiny: readonly boolean[]): SpriteRef[] {
  const refs: SpriteRef[] = [];
  for (const b of r.initial) {
    refs.push({ species: b.species, formKey: b.formKey, back: b.side === 0, shiny: shiny[b.id]! });
    refs.push({ species: b.species, formKey: b.formKey, back: false, shiny: shiny[b.id]! });
  }
  for (const e of r.events) {
    if (e.k !== "form") continue;
    const b = r.initial[e.target]!;
    refs.push({ species: e.species, formKey: e.formKey, back: b.side === 0, shiny: shiny[b.id]! });
  }
  return refs;
}

function initialVis(r: BattleResult): Vis {
  return {
    tick: 0,
    hp: r.initial.map((b) => b.hp),
    maxHp: r.initial.map((b) => b.maxHp),
    gauge: r.initial.map(() => 0),
    alive: r.initial.map(() => true),
    status: r.initial.map(() => null),
    species: r.initial.map((b) => b.species),
    formKey: r.initial.map((b) => b.formKey),
    big: r.initial.map(() => false),
    tera: r.initial.map(() => null),
    weather: null,
    terrain: null,
    sudden: false,
  };
}

/** A bag cell or item on either side's board, drawn under the Pokémon. */
interface BoardThing {
  uid: string;
  side: 0 | 1;
  kind: "bag" | "item";
  cells: Cell[];
  item?: string;
  param?: string;
}

interface Box {
  left: number;
  top: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
}

export function BattleScreen({ turn, before, onDone }: { turn: TurnResponse; before: RunState; onDone: () => void }) {
  const { tr } = useI18n();
  const result = useMemo(() => simulateBattle({ seed: turn.battle.seed, teams: turn.battle.teams }, { recordFrames: true }), [turn]);
  const byTick = useMemo(() => {
    const m = new Map<number, BattleEvent[]>();
    for (const e of result.events) {
      const list = m.get(e.t) ?? [];
      list.push(e);
      m.set(e.t, list);
    }
    return m;
  }, [result]);
  const stats = useMemo(() => battleStats(result), [result]);
  const arena = useMemo(() => battleArena(turn.battle.seed, turn.battle.teams), [turn]);
  // Looks each side bought (display only): shiny lines and the trained starter's nickname.
  const shinyLook = useMemo(
    () => result.initial.map((b) => looksShiny(turn.battle.teams[b.side].cosmetics?.shinyLines, b.species, b.shiny)),
    [result, turn],
  );
  const nicknames = useMemo(
    () => result.initial.map((b) => turn.battle.teams[b.side].pieces.find((p) => p.uid === b.uid && p.kind === "pokemon" && p.nickname)),
    [result, turn],
  );
  const nicknameOf = (id: number) => {
    const p = nicknames[id];
    return p?.kind === "pokemon" ? p.nickname : undefined;
  };

  const [vis, setVis] = useState<Vis>(() => initialVis(result));
  const [fx, setFx] = useState<Fx[]>([]);
  const [trails, setTrails] = useState<Trail[]>([]);
  const [log, setLog] = useState<LogLine[]>([]);
  const [speed, setSpeed] = useState(1);
  const [done, setDone] = useState(false);
  // Playback waits until this battle's sprites are loaded (bounded by a timeout).
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    setReady(false);
    preloadPokemonSprites(battleSprites(result, shinyLook)).then(() => alive && setReady(true));
    return () => {
      alive = false;
    };
  }, [result]);
  const anim = useRef<{ lunge: Map<number, number>; hit: Map<number, number>; itemFlash: Map<string, number>; itemUsed: Set<string> }>({
    lunge: new Map(),
    hit: new Map(),
    itemFlash: new Map(),
    itemUsed: new Set(),
  });
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const idRef = useRef(0);
  const skipRef = useRef(false);

  // At 1100px and below the log moves under the field, so the field can take the whole width. A phone on
  // its side keeps the log beside the field (styles.css) and needs only a slim header above it.
  const lowScreen = window.innerHeight <= 500 && window.innerWidth >= 600;
  const sideRoom = lowScreen ? 300 : window.innerWidth <= 1100 ? 56 : 380;
  const cell = Math.max(
    lowScreen ? 16 : 24,
    Math.min(48, Math.floor((window.innerHeight - (lowScreen ? 96 : 190)) / (2 * BOARD_H + 0.8)), Math.floor((window.innerWidth - sideRoom) / BOARD_W)),
  );
  const halfH = BOARD_H * cell;
  const gap = cell * 0.8;
  const pad = 12;

  const things = useMemo<BoardThing[]>(() => {
    const out: BoardThing[] = [];
    turn.battle.teams.forEach((team, side) => {
      for (const p of team.pieces) {
        if (!p.place || p.kind === "pokemon") continue;
        out.push({
          uid: `${side}:${p.uid}`,
          side: side as 0 | 1,
          kind: p.kind,
          cells: cellsOf(p),
          ...(p.kind === "item" ? { item: p.item, ...(p.param ? { param: p.param } : {}) } : {}),
        });
      }
    });
    return out;
  }, [turn]);

  const cellTop = (side: 0 | 1, y: number) => (side === 0 ? pad + halfH + gap + y * cell : pad + (BOARD_H - 1 - y) * cell);

  const boxes = useMemo<Box[]>(() => {
    return result.initial.map((b) => {
      const xs = b.cells.map((c) => c.x);
      const ys = b.cells.map((c) => c.y);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      const w = (maxX - minX + 1) * cell;
      const h = (maxY - minY + 1) * cell;
      const left = pad + minX * cell;
      const top = b.side === 0 ? pad + halfH + gap + minY * cell : pad + (BOARD_H - 1 - maxY) * cell;
      return { left, top, w, h, cx: left + w / 2, cy: top + h / 2 };
    });
  }, [result, cell, halfH, gap]);

  useEffect(() => {
    if (!ready) return;
    let raf = 0;
    let last = performance.now();
    let tickF = 0;
    let processed = -1;
    const v = initialVis(result);
    const name = (id: number) => nicknameOf(id) ?? tr.species(v.species[id] ?? result.initial[id]!.species);
    const sideCls = (id: number) => (result.initial[id]!.side === 0 ? "ally" : "foe");
    const nextId = () => idRef.current++;
    const addFx = (battler: number, text: string, cls: string, item?: string) => {
      const now = performance.now();
      const entry: Fx = { id: nextId(), battler, text, cls, born: now, ...(item ? { item } : {}) };
      setFx((list) => [...list.filter((f) => now - f.born < FX_LIFE), entry]);
    };
    const addLog = (cls: string, text: string) => {
      const line = { id: nextId(), cls, text };
      setLog((list) => [...list.slice(-59), line]);
    };
    const apply = (e: BattleEvent, quiet: boolean) => {
      const now = performance.now();
      switch (e.k) {
        case "move": {
          const variant = e.variant ? ` (${e.variant === "z" ? "Z" : e.variant === "gmax" ? "G-Max" : "Max"})` : "";
          addLog(sideCls(e.src), `${name(e.src)} ▸ ${tr.move(e.move)}${variant}`);
          if (quiet) break;
          anim.current.lunge.set(e.src, now + 220);
          const type = CONTENT.moves[e.move]?.type;
          const color = e.variant ? "#ffd866" : TYPE_COLORS[type ?? "normal"] ?? "#fff";
          const targets = e.targets.filter((t) => t !== e.src);
          if (targets.length > 0) {
            const trail: Trail = { id: nextId(), from: e.src, to: targets, color, big: !!e.variant, born: now };
            setTrails((list) => [...list.filter((t) => now - t.born < TRAIL_LIFE), trail]);
          }
          addFx(e.src, tr.move(e.move), e.variant ? `fx-move fx-${e.variant}` : "fx-move");
          if (e.variant) sound.playSe("se/beam", { gap: 300 });
          break;
        }
        case "damage": {
          v.hp[e.target] = e.hp;
          const tags = [e.crit ? tr.t("battleText.crit") : "", e.eff !== undefined && e.eff > 1 ? tr.t("battleText.super") : "", e.eff !== undefined && e.eff < 1 ? tr.t("battleText.notVery") : ""].filter(Boolean);
          if (e.cause === "move") addLog(`${sideCls(e.target)} sub`, `→ ${name(e.target)} -${e.amount}${tags.length ? ` (${tags.join(", ")})` : ""}`);
          if (quiet) break;
          anim.current.hit.set(e.target, now + 250);
          if (e.cause === "move") {
            // PokéRogue's three hit sounds: super effective (or a critical hit), not very effective, normal.
            const strong = (e.eff !== undefined && e.eff > 1) || e.crit;
            sound.playSe(strong ? "se/hit_strong" : e.eff !== undefined && e.eff < 1 ? "se/hit_weak" : "se/hit");
          }
          const eff = e.eff === undefined ? "" : e.eff > 1 ? " fx-super" : e.eff < 1 ? " fx-weak" : "";
          addFx(e.target, `-${e.amount}${e.crit ? "!" : ""}`, `fx-dmg${eff}${e.crit ? " fx-crit" : ""}`);
          break;
        }
        case "heal":
          v.hp[e.target] = e.hp;
          if (!quiet) {
            addFx(e.target, `+${e.amount}`, "fx-heal");
            sound.playSe("se/restore", { gap: 250, volume: 0.7 });
          }
          break;
        case "miss":
          addLog(`${sideCls(e.target)} sub`, `→ ${name(e.target)} ${tr.t("battleText.miss")}`);
          if (!quiet) addFx(e.target, tr.t("battleText.miss"), "fx-info");
          break;
        case "immune":
          addLog(`${sideCls(e.target)} sub`, `→ ${name(e.target)} ${tr.t("battleText.immune")}`);
          if (!quiet) addFx(e.target, tr.t("battleText.immune"), "fx-info");
          break;
        case "protect":
          if (!quiet) addFx(e.target, tr.t("battleText.protect"), "fx-info");
          break;
        case "status":
          v.status[e.target] = e.stacks && e.stacks > 1 ? `${e.status}×${e.stacks}` : e.status;
          addLog(`${sideCls(e.target)} sub`, `${name(e.target)}: ${tr.t(`status.${e.status}`)}`);
          if (!quiet) addFx(e.target, tr.t(`status.${e.status}`), `fx-status st-${e.status}`);
          break;
        case "cure":
          v.status[e.target] = null;
          break;
        case "confuse":
          if (!quiet) addFx(e.target, tr.t("status.confusion"), "fx-status");
          break;
        case "stage":
          if (!quiet) sound.playSe(e.delta > 0 ? "se/stat_up" : "se/stat_down", { gap: 500, volume: 0.8 });
          if (!quiet) addFx(e.target, `${tr.stat(e.stat === "acc" || e.stat === "eva" ? "spe" : e.stat)}${e.delta > 0 ? "↑".repeat(Math.min(3, e.delta)) : "↓".repeat(Math.min(3, -e.delta))}`, e.delta > 0 ? "fx-up" : "fx-down");
          break;
        case "flinch":
          if (!quiet) addFx(e.target, tr.t("status.flinch"), "fx-info");
          break;
        case "faint":
          v.alive[e.target] = false;
          v.hp[e.target] = 0;
          addLog(`${sideCls(e.target)} ko`, `✖ ${name(e.target)} ${tr.t("battleText.faint")}`);
          if (!quiet) sound.playSe("se/faint", { gap: 120 });
          break;
        case "cant":
          if (!quiet) addFx(e.target, tr.t(`status.${e.reason === "recharge" ? "flinch" : e.reason}`), "fx-info");
          break;
        case "charge":
          if (!quiet) {
            addFx(e.src, tr.t("battleText.charge"), "fx-info");
            sound.playSe("se/charge", { gap: 400, volume: 0.8 });
          }
          break;
        case "weather":
          v.weather = e.weather;
          if (e.weather) addLog("sys", `☁ ${tr.t(`weather.${e.weather}`)}`);
          break;
        case "terrain":
          v.terrain = e.terrain;
          if (e.terrain) addLog("sys", `▦ ${tr.t(`terrain.${e.terrain}`)}`);
          break;
        case "ability":
          if (!quiet) addFx(e.src, tr.ability(e.ability), "fx-ability");
          break;
        case "item": {
          addLog(`${sideCls(e.src)} sub`, `${name(e.src)}: ${tr.itemName(e.item)}`);
          // Light up the item(s) on the board that caused this; one-shot items fade once used.
          const holder = result.initial[e.src]!;
          const sources = things.filter(
            (t) => t.kind === "item" && t.item === e.item && t.side === holder.side && touches(t.cells, holder.cells) && !anim.current.itemUsed.has(t.uid),
          );
          for (const t of sources) anim.current.itemFlash.set(t.uid, now + 700);
          const def = ITEMS[e.item];
          if (sources[0] && def && (def.oneShot || def.family === "berry")) anim.current.itemUsed.add(sources[0].uid);
          if (!quiet) addFx(e.src, tr.itemName(e.item), "fx-item", e.item);
          break;
        }
        case "form":
          v.species[e.target] = e.species;
          v.formKey[e.target] = e.formKey;
          v.maxHp[e.target] = e.maxHp;
          v.hp[e.target] = e.hp;
          v.big[e.target] = e.form === "dynamax" || e.form === "gmax";
          if (e.tera) v.tera[e.target] = e.tera;
          if (e.form !== "stance") addLog(`${sideCls(e.target)} big`, `✦ ${name(e.target)} ${tr.t(`form.${e.form}`)}`);
          if (!quiet) addFx(e.target, tr.t(`form.${e.form}`), `fx-form fx-${e.form}`);
          // Mega Evolution, Dynamax and Terastal get PokéRogue's form-change shine.
          if (!quiet && e.form !== "stance") sound.playSe("se/shine", { gap: 600 });
          break;
        case "sudden":
          v.sudden = true;
          addLog("sys ko", tr.t("ui.suddenDeath"));
          break;
        case "end":
          break;
      }
    };
    const step = (now: number) => {
      const dt = Math.min(100, now - last);
      last = now;
      tickF += (dt / 1000) * 10 * speedRef.current;
      if (skipRef.current) tickF = result.ticks;
      const target = Math.min(result.ticks, Math.floor(tickF));
      while (processed < target) {
        processed++;
        const quiet = skipRef.current;
        for (const e of byTick.get(processed) ?? []) apply(e, quiet);
      }
      const frame = result.frames[Math.min(target, result.frames.length - 1)];
      if (frame) {
        v.gauge = frame.gauge;
        v.hp = [...frame.hp];
      }
      v.tick = target;
      setVis({ ...v, hp: [...v.hp], gauge: [...v.gauge], alive: [...v.alive], status: [...v.status], species: [...v.species], formKey: [...v.formKey], big: [...v.big], tera: [...v.tera] });
      if (target >= result.ticks) {
        setTimeout(() => setDone(true), skipRef.current ? 0 : 700);
        return;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    sound.playSe("se/pb_rel");
    return () => cancelAnimationFrame(raf);
  }, [result, byTick, tr, things, ready]);

  // A win gets the trainer-victory fanfare; a loss or draw lets the battle music fade out.
  useEffect(() => {
    if (done) sound.playBgm(turn.battle.outcome === "win" ? BGM.victory : null);
  }, [done, turn]);

  const now = performance.now();
  const outcome = turn.battle.outcome;
  const opp = turn.battle.opponent;
  const oppName = opp.ghost ? tr.t("ui.ghostOf", { name: opp.name }) : tr.t("ui.botTrainer");
  const notices = [...turn.preBattleNotices, ...turn.state.notices];
  const fieldW = BOARD_W * cell + pad * 2;
  const fieldH = halfH * 2 + gap + pad * 2;

  return (
    <div className="battle-screen">
      <header className="battle-header panel">
        <div className="side-tag">
          <TrainerSprite champion={turn.battle.teams[0].champion} width={40} height={48} />
          <div>
            <b>{before.playerName}</b>
            <div className="muted small">{tr.trainer(turn.battle.teams[0].champion)}</div>
          </div>
        </div>
        <div className="vs">
          {tr.t("ui.vs")}
          <div className="muted small">{(vis.tick / 10).toFixed(1)}s</div>
        </div>
        <div className="side-tag right">
          <div>
            <b>{oppName}</b>
            <div className="muted small">
              {tr.trainer(opp.champion)} · {tr.t("ui.summary", { wins: turn.battle.teams[1].wins, losses: turn.battle.teams[1].losses })}
              {opp.rating !== undefined && ` · ${tr.t("ui.rating")} ${opp.rating}`}
            </div>
          </div>
          <TrainerSprite champion={opp.champion} width={40} height={48} />
        </div>
      </header>

      <div className="battle-main">
        <div className="battle-field" style={{ width: fieldW, height: fieldH, backgroundImage: `url(/assets/arenas/${arena}_bg.png)` }}>
          <div className={`weather-layer ${vis.weather ? `w-${vis.weather}` : ""} ${vis.terrain ? `t-${vis.terrain}` : ""}`} />
          {!ready && <div className="field-loading">{tr.t("ui.loadingSprites")}</div>}
          <div className="field-labels">
            {vis.weather && <span className="chip">{tr.t(`weather.${vis.weather}`)}</span>}
            {vis.terrain && <span className="chip">{tr.t(`terrain.${vis.terrain}`)}</span>}
            {vis.sudden && <span className="chip danger">{tr.t("ui.suddenDeath")}</span>}
          </div>
          {([1, 0] as const).map((side) => (
            <div
              key={side}
              className={`field-grid ${side === 0 ? "ally" : "foe"}`}
              style={{
                left: pad,
                top: side === 0 ? pad + halfH + gap : pad,
                gridTemplateColumns: `repeat(${BOARD_W}, ${cell}px)`,
                gridTemplateRows: `repeat(${BOARD_H}, ${cell}px)`,
              }}
            >
              {Array.from({ length: BOARD_W * BOARD_H }, (_, i) => {
                const row = Math.floor(i / BOARD_W);
                const front = side === 0 ? row === 0 : row === BOARD_H - 1;
                return <div key={i} className={front ? "front" : ""} />;
              })}
            </div>
          ))}
          {things.map((t) =>
            t.kind === "bag" ? (
              t.cells.map((c) => (
                <div key={`${t.uid}-${c.x}-${c.y}`} className="field-bag" style={{ left: pad + c.x * cell, top: cellTop(t.side, c.y), width: cell, height: cell }} />
              ))
            ) : (
              <div
                key={t.uid}
                title={tr.itemName(t.item!, t.param)}
                className={`field-item ${(anim.current.itemFlash.get(t.uid) ?? 0) > now ? "fire" : ""} ${anim.current.itemUsed.has(t.uid) ? "used" : ""}`}
                style={(() => {
                  const xs = t.cells.map((c) => c.x);
                  const ys = t.cells.map((c) => c.y);
                  const w = Math.max(...xs) - Math.min(...xs) + 1;
                  const h = Math.max(...ys) - Math.min(...ys) + 1;
                  const top = t.side === 0 ? cellTop(0, Math.min(...ys)) : cellTop(1, Math.max(...ys));
                  return { left: pad + Math.min(...xs) * cell, top, width: w * cell, height: h * cell };
                })()}
              >
                <ItemIcon item={t.item!} param={t.param} size={Math.round(cell * 0.72)} />
              </div>
            ),
          )}
          <svg className="trails" width={fieldW} height={fieldH}>
            {trails
              .filter((t) => now - t.born < TRAIL_LIFE)
              .flatMap((t) =>
                t.to.map((to) => {
                  const a = boxes[t.from]!;
                  const b = boxes[to]!;
                  return (
                    <line
                      key={`${t.id}-${to}`}
                      x1={a.cx}
                      y1={a.cy}
                      x2={b.cx}
                      y2={b.cy}
                      stroke={t.color}
                      strokeWidth={t.big ? 7 : 4}
                      strokeLinecap="round"
                      className="trail"
                      style={{ animationDuration: `${TRAIL_LIFE}ms` }}
                    />
                  );
                }),
              )}
          </svg>
          {result.initial.map((b) => {
            const box = boxes[b.id]!;
            const lunging = (anim.current.lunge.get(b.id) ?? 0) > now;
            const hit = (anim.current.hit.get(b.id) ?? 0) > now;
            const hp = vis.hp[b.id] ?? 0;
            const max = vis.maxHp[b.id] ?? 1;
            const ratio = Math.max(0, hp / max);
            const status = vis.status[b.id];
            const cls = [
              "battler",
              b.side === 0 ? "ally" : "foe",
              vis.alive[b.id] ? "" : "fainted",
              lunging ? "lunge acting" : "",
              hit ? "hit" : "",
              vis.big[b.id] ? "big" : "",
              vis.tera[b.id] ? "tera" : "",
            ].join(" ");
            return (
              <div
                key={b.id}
                className={cls}
                style={{ left: box.left, top: box.top, width: box.w, height: box.h, "--tc": TYPE_COLORS[b.types[0] ?? "normal"], "--cell": `${cell}px` } as React.CSSProperties}
              >
                <PokemonSprite
                  species={vis.species[b.id] ?? b.species}
                  formKey={vis.formKey[b.id] ?? b.formKey}
                  back={b.side === 0}
                  shiny={shinyLook[b.id]}
                  width={box.w}
                  height={box.h - 10}
                  maxScale={2}
                  valign={box.h > box.w ? "middle" : "bottom"}
                />
                <div className="bars">
                  <div className="hp">
                    <span className={ratio > 0.5 ? "g" : ratio > 0.2 ? "y" : "r"} style={{ width: `${ratio * 100}%` }} />
                  </div>
                  <div className="gauge">
                    <span style={{ width: `${Math.min(100, (vis.gauge[b.id] ?? 0) / 10)}%` }} />
                  </div>
                </div>
                {status && (
                  <span className={`status-tag st-${status.split("×")[0]}`}>
                    {tr.t(`status.${status.split("×")[0]}`)}
                    {status.includes("×") ? `×${status.split("×")[1]}` : ""}
                  </span>
                )}
                {vis.tera[b.id] && <span className="tera-tag">✦{vis.tera[b.id] === "stellar" ? "★" : tr.type(vis.tera[b.id]!)}</span>}
                {fx
                  .filter((f) => f.battler === b.id && now - f.born < FX_LIFE)
                  .slice(-4)
                  .map((f, i) => (
                    <span key={f.id} className={`fx ${f.cls}`} style={{ top: -8 - i * 15 }}>
                      {f.item && <ItemIcon item={f.item} size={18} className="fx-icon" />}
                      {f.text}
                    </span>
                  ))}
              </div>
            );
          })}
        </div>

        <aside className="battle-log panel">
          <div className="panel-title">
            <span>{tr.t("ui.battleLog")}</span>
          </div>
          <ol>
            {log
              .slice(-18)
              .reverse()
              .map((l) => (
                <li key={l.id} className={l.cls}>
                  {l.text}
                </li>
              ))}
          </ol>
        </aside>
      </div>

      <div className="battle-controls">
        <span className="muted small">{tr.t("ui.speed")}</span>
        {[1, 2, 4].map((s) => (
          <button key={s} className={`btn btn-small ${speed === s ? "btn-primary" : ""}`} onClick={() => setSpeed(s)}>
            ×{s}
          </button>
        ))}
        <button className="btn btn-small" onClick={() => (skipRef.current = true)}>
          {tr.t("ui.skip")} ⏭
        </button>
        <SoundButton />
      </div>

      {done && (
        <div className="modal-back">
          <div className={`modal panel result wide ${outcome}`}>
            <h2>{outcome === "win" ? tr.t("ui.victory") : outcome === "loss" ? tr.t("ui.defeat") : tr.t("ui.draw")}</h2>
            <div className="result-row">
              <span>🏆 {tr.t("ui.wins", { n: turn.state.wins, max: 10 })}</span>
              <span className="lives">{"♥".repeat(Math.max(0, turn.state.lives))}</span>
            </div>
            <StatsTable result={result} stats={stats} shinyLook={shinyLook} nicknameOf={nicknameOf} />
            <ul className="notice-list">
              {notices.map((n, i) => (
                <li key={i}>{noticeText(tr, n)}</li>
              ))}
            </ul>
            <button className="btn btn-primary" onClick={onDone}>
              {tr.t("ui.continueRun")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function StatsTable({
  result,
  stats,
  shinyLook,
  nicknameOf,
}: {
  result: BattleResult;
  stats: ReturnType<typeof battleStats>;
  shinyLook: readonly boolean[];
  nicknameOf: (id: number) => string | undefined;
}) {
  const { tr } = useI18n();
  const maxDealt = Math.max(1, ...stats.map((s) => s.dealt));
  const maxTaken = Math.max(1, ...stats.map((s) => s.taken));
  return (
    <div className="stats-cols">
      {([0, 1] as const).map((side) => {
        const members = result.initial.filter((b) => b.side === side);
        const mvp = members.reduce<number | null>((best, b) => (best === null || stats[b.id]!.dealt > stats[best]!.dealt ? b.id : best), null);
        return (
          <div key={side} className={`stats-col ${side === 0 ? "ally" : "foe"}`}>
            <div className="stats-head">
              <span />
              <span className="small">{tr.t("ui.statDealt")}</span>
              <span className="small">{tr.t("ui.statTaken")}</span>
              <span className="small">{tr.t("ui.statHealed")}</span>
              <span className="small">{tr.t("ui.statKos")}</span>
            </div>
            {members.map((b) => {
              const s = stats[b.id]!;
              const fainted = result.fainted[side].includes(b.uid);
              return (
                <div key={b.id} className={`stats-row ${fainted ? "fainted" : ""}`}>
                  <span className="who">
                    <PokemonSprite species={b.species} formKey={b.formKey} shiny={shinyLook[b.id]} width={32} height={32} animate={false} />
                    <span className="small">
                      {mvp === b.id && s.dealt > 0 && <b className="mvp">MVP </b>}
                      {nicknameOf(b.id) ?? tr.species(b.species)}
                    </span>
                  </span>
                  <span className="bar dealt" title={String(s.dealt)}>
                    <i style={{ width: `${(s.dealt / maxDealt) * 100}%` }} />
                    <em>{s.dealt}</em>
                  </span>
                  <span className="bar taken" title={String(s.taken)}>
                    <i style={{ width: `${(s.taken / maxTaken) * 100}%` }} />
                    <em>{s.taken}</em>
                  </span>
                  <span className="small heal">{s.healed > 0 ? `+${s.healed}` : "—"}</span>
                  <span className="small">{s.kos > 0 ? `✖${s.kos}` : "—"}</span>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
