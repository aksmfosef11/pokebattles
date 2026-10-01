import { useId } from "react";
import { useI18n } from "../i18n.tsx";

/**
 * A small board sketch. Foe rows read top-down with their front row last; ally rows top-down with
 * your front row first, the way the battle field draws them. Each letter is one Pokémon.
 */
interface Sketch {
  key: string;
  foe: string[];
  ally: string[];
  /** Attacker letter followed by target letter. */
  arrows: string[];
  /** Hit by a spread move without being its target. */
  splash?: string;
  /** Passed over: the move cannot touch it. */
  skip?: string;
}

const RULES = ["front", "lane", "immune", "spread", "special", "frontOnly"] as const;

// Every sketch follows sim.ts: frontmost row first, then the nearest column, immune foes skipped.
const SKETCHES: Sketch[] = [
  { key: "wall", foe: ["a.b.c"], ally: ["..W..", "A...B"], arrows: ["aW", "bW", "cW", "Aa", "Bc"] },
  { key: "split", foe: ["ab..c"], ally: ["W...V", "..A.."], arrows: ["aW", "bW", "cV"] },
  { key: "focus", foe: ["a....b"], ally: ["ABC..."], arrows: ["Aa", "Ba", "Ca"] },
  { key: "immune", foe: ["..n.."], ally: ["..G..", "..P.."], arrows: ["nP"], skip: "G" },
  { key: "spread", foe: [".b..."], ally: ["PQ.R."], arrows: ["bQ"], splash: "P" },
  { key: "quake", foe: [".a..."], ally: ["PQF.."], arrows: ["Qa"], splash: "P", skip: "F" },
];

const GLYPH: Record<string, string> = { W: "🛡", V: "🛡", A: "⚔", B: "⚔", C: "⚔", Q: "⚔", G: "👻", F: "🕊" };

const C = 24;
const GAP = 16;

function MiniField({ sketch }: { sketch: Sketch }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const cols = Math.max(...[...sketch.foe, ...sketch.ally].map((r) => r.length));
  const allyTop = sketch.foe.length * C + GAP;
  const w = cols * C;
  const h = allyTop + sketch.ally.length * C;
  const pos = new Map<string, { x: number; y: number; ally: boolean }>();
  sketch.foe.forEach((row, y) => [...row].forEach((ch, x) => ch !== "." && pos.set(ch, { x: x * C + C / 2, y: y * C + C / 2, ally: false })));
  sketch.ally.forEach((row, y) => [...row].forEach((ch, x) => ch !== "." && pos.set(ch, { x: x * C + C / 2, y: allyTop + y * C + C / 2, ally: true })));
  const targets = new Set(sketch.arrows.map((a) => a[1]!));
  const r = C * 0.36;
  const frontRows = [(sketch.foe.length - 1) * C, allyTop];

  return (
    <svg className="mini-field" viewBox={`-2 -2 ${w + 4} ${h + 4}`} width={w + 4} height={h + 4} aria-hidden>
      <defs>
        {(["a", "f"] as const).map((s) => (
          <marker key={s} id={`${uid}-${s}`} viewBox="0 0 6 6" refX="5" refY="3" markerWidth="5" markerHeight="5" orient="auto">
            <path d="M0,0 L6,3 L0,6 z" className={s === "a" ? "mf-arrow-ally" : "mf-arrow-foe"} />
          </marker>
        ))}
      </defs>
      {[...sketch.foe.map((row, y) => ({ row, top: y * C })), ...sketch.ally.map((row, y) => ({ row, top: allyTop + y * C }))].map(({ row, top }) =>
        [...row].map((_, x) => (
          <rect key={`${top}-${x}`} x={x * C + 1} y={top + 1} width={C - 2} height={C - 2} rx={3} className={frontRows.includes(top) ? "mf-cell front" : "mf-cell"} />
        )),
      )}
      {sketch.arrows.map((pair) => {
        const a = pos.get(pair[0]!)!;
        const b = pos.get(pair[1]!)!;
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        const ux = (b.x - a.x) / len;
        const uy = (b.y - a.y) / len;
        return (
          <line
            key={pair}
            x1={a.x + ux * r}
            y1={a.y + uy * r}
            x2={b.x - ux * (r + 2)}
            y2={b.y - uy * (r + 2)}
            className={a.ally ? "mf-line ally" : "mf-line foe"}
            markerEnd={`url(#${uid}-${a.ally ? "a" : "f"})`}
          />
        );
      })}
      {[...pos].map(([ch, p]) => {
        const mark = targets.has(ch) ? "target" : sketch.splash?.includes(ch) ? "splash" : sketch.skip?.includes(ch) ? "skip" : "";
        return (
          <g key={ch} className={`mf-mon ${p.ally ? "ally" : "foe"} ${mark}`}>
            <circle cx={p.x} cy={p.y} r={r} />
            {GLYPH[ch] && (
              <text x={p.x} y={p.y} dy="0.35em" textAnchor="middle">
                {GLYPH[ch]}
              </text>
            )}
            {mark === "skip" && (
              <text className="mf-skip" x={p.x + r} y={p.y - r + 2} textAnchor="middle">
                ✕
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** How a Pokémon picks what to hit, with placements that use it (the ? beside the board's front row). */
export function TargetGuide({ onClose }: { onClose: () => void }) {
  const { tr } = useI18n();
  const names = {
    levitate: tr.ability("LEVITATE"),
    balloon: tr.itemName("AIR_BALLOON"),
    waterAbsorb: tr.ability("WATER_ABSORB"),
    voltAbsorb: tr.ability("VOLT_ABSORB"),
    rockSlide: tr.move("ROCK_SLIDE"),
    heatWave: tr.move("HEAT_WAVE"),
    earthquake: tr.move("EARTHQUAKE"),
    surf: tr.move("SURF"),
    outrage: tr.move("OUTRAGE"),
    thrash: tr.move("THRASH"),
    infiltrator: tr.ability("INFILTRATOR"),
    stalwart: tr.ability("STALWART"),
    intimidate: tr.ability("INTIMIDATE"),
    shadowTag: tr.ability("SHADOW_TAG"),
  };
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal panel target-guide" role="dialog" aria-label={tr.t("targets.title")} onClick={(e) => e.stopPropagation()}>
        <h2>🎯 {tr.t("targets.title")}</h2>
        <p className="muted small">{tr.t("targets.intro")}</p>

        <h3>{tr.t("targets.rulesTitle")}</h3>
        <ol className="target-rules">
          {RULES.map((k) => (
            <li key={k}>
              <b>{tr.t(`targets.rule.${k}.name`)}</b>
              <span className="small">{tr.t(`targets.rule.${k}.desc`, names)}</span>
            </li>
          ))}
        </ol>

        <h3>{tr.t("targets.examplesTitle")}</h3>
        <div className="mf-legend small muted">
          <span>
            <i className="mf-dot ally" /> {tr.t("targets.legend.ally")}
          </span>
          <span>
            <i className="mf-dot foe" /> {tr.t("targets.legend.foe")}
          </span>
          <span>
            <i className="mf-dot target" /> {tr.t("targets.legend.target")}
          </span>
          <span>
            <i className="mf-dot splash" /> {tr.t("targets.legend.splash")}
          </span>
          <span>✕ {tr.t("targets.legend.skip")}</span>
          <span>
            <i className="mf-dot front" /> {tr.t("targets.legend.front")}
          </span>
        </div>
        <div className="target-examples">
          {SKETCHES.map((s) => (
            <section key={s.key} className="target-example">
              <b>{tr.t(`targets.example.${s.key}.name`, names)}</b>
              <MiniField sketch={s} />
              <p className="small">{tr.t(`targets.example.${s.key}.desc`, names)}</p>
            </section>
          ))}
        </div>
        <button className="btn" onClick={onClose}>
          {tr.t("ui.close")}
        </button>
      </div>
    </div>
  );
}
