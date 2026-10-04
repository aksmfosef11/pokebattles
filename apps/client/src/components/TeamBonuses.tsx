import { teamBonuses, type RunState, type TeamBonus } from "@pokebattles/game";
import { useMemo } from "react";
import { useI18n } from "../i18n.tsx";
import { TrainerSprite } from "./sprites.tsx";

/** The champion's bonuses for the board as it stands (top bar ✦): what the next battle gets, per passive. */
export function useTeamBonuses(state: RunState): TeamBonus[] {
  return useMemo(() => teamBonuses(state), [state]);
}

/** "+3.5%": the sign and one decimal only when there is one. */
function formatAmount(amount: number): string {
  const pct = Math.round(amount * 1000) / 10;
  return `${pct > 0 ? "+" : ""}${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`;
}

export function TeamBonuses({ state, bonuses, onClose }: { state: RunState; bonuses: readonly TeamBonus[]; onClose: () => void }) {
  const { tr } = useI18n();
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal panel team-bonuses" role="dialog" aria-label={tr.t("ui.teamBonus.title")} onClick={(e) => e.stopPropagation()}>
        <header className="team-bonus-head">
          <TrainerSprite champion={state.champion} width={40} height={46} />
          <div>
            <h2>✦ {tr.t("ui.teamBonus.title")}</h2>
            <div className="muted small">
              {tr.trainer(state.champion)}
              {state.subclass ? ` · ${tr.t(`subclass.${state.subclass}.name`)}` : ""} · {tr.t("ui.roundShort", { n: state.round })}
            </div>
          </div>
        </header>
        <p className="muted small">{tr.t("ui.teamBonus.hint")}</p>
        {bonuses.length === 0 ? (
          <p className="muted team-bonus-empty">{tr.t("ui.teamBonus.empty")}</p>
        ) : (
          <ul className="team-bonus-list">
            {bonuses.map((b) => (
              <li key={b.id} className={`team-bonus-row scope-${b.scope} ${b.amount === 0 ? "off" : ""}`}>
                <div className="team-bonus-main">
                  <b className="ability-name">{tr.t(`ui.teamBonus.entries.${b.id}.name`)}</b>
                  <span className="team-bonus-scope small">{tr.t(`ui.teamBonus.scope.${b.scope}`)}</span>
                  <span className="team-bonus-value">{b.amount === 0 ? "—" : formatAmount(b.amount)}</span>
                </div>
                <div className="small team-bonus-desc">{tr.t(`ui.teamBonus.entries.${b.id}.desc`, b.params)}</div>
              </li>
            ))}
          </ul>
        )}
        <p className="muted small team-bonus-note">※ {tr.t("ui.teamBonus.note")}</p>
        <button className="btn" onClick={onClose}>
          {tr.t("ui.close")}
        </button>
      </div>
    </div>
  );
}
