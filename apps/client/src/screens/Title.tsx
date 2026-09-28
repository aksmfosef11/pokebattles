import { useEffect, useState } from "react";
import { rankTier, type RunState } from "@pokebattles/game";
import type { Account, GameApi, RunSummary } from "../api.ts";
import { LegalNotice } from "../components/LegalNotice.tsx";
import { ItemIcon, TrainerSprite } from "../components/sprites.tsx";
import { SoundButton } from "../components/SoundButton.tsx";
import { useI18n } from "../i18n.tsx";

export function Title({
  api,
  account,
  onNew,
  onLeaderboard,
  onTrainerCard,
  onLogout,
  onContinue,
}: {
  api: GameApi;
  account: Account;
  onNew: (ranked: boolean) => void;
  onLeaderboard: () => void;
  onTrainerCard: () => void;
  onLogout: () => void;
  onContinue: (s: RunState) => void;
}) {
  const { tr, lang, langs, setLang } = useI18n();
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listRuns().then(setRuns).catch(() => setRuns([]));
  }, [api]);

  const open = async (runId: string) => {
    try {
      onContinue(await api.getRun(runId));
    } catch (e) {
      setError(tr.t(`error.${(e as { code?: string }).code ?? "default"}`));
    }
  };

  const active = (runs ?? []).filter((r) => r.phase !== "ended");
  const rankedRun = active.find((r) => r.ranked);
  const online = api.mode === "online";
  const { profile } = account;

  return (
    <div className="title-screen">
      <div className="title-champions">
        {["red", "cynthia", "leon", "diantha", "steven"].map((c) => (
          <TrainerSprite key={c} champion={c} width={96} height={120} />
        ))}
      </div>
      <h1 className="logo">{tr.t("title")}</h1>
      <p className="subtitle">{tr.t("subtitle")}</p>
      <div className="title-menu panel">
        <div className="account-box">
          <div className="account-name">
            <b>{account.username ?? tr.t("ui.trainer")}</b>
            <span className="points-chip" title={tr.t("ui.pointsHint")}>
              {tr.t("ui.points", { n: profile.points })}
            </span>
          </div>
          {online && (
            <div className="account-rank">
              {profile.rankedRuns > 0 ? (
                <>
                  <ItemIcon item={rankTier(profile.rating)} size={24} />
                  <span>
                    {tr.t("ui.rating")} {profile.rating}
                  </span>
                  <span className="muted small">{tr.t("ui.rankedRuns", { n: profile.rankedRuns })}</span>
                </>
              ) : (
                <span className="muted small">{tr.t("ui.unranked")}</span>
              )}
            </div>
          )}
          <button className="btn btn-small" onClick={onTrainerCard}>
            {tr.t("ui.trainerCard")}
          </button>
          {online && (
            <button className="btn btn-small" onClick={onLogout}>
              {tr.t("ui.logout")}
            </button>
          )}
        </div>
        <div className="title-buttons">
          <button className="btn btn-primary" onClick={() => onNew(false)}>
            {tr.t("ui.newRun")}
          </button>
          <button
            className="btn btn-ranked"
            disabled={!online}
            title={online ? tr.t("ui.rankedHint") : tr.t("ui.rankedOfflineHint")}
            onClick={() => (rankedRun ? open(rankedRun.runId) : onNew(true))}
          >
            {rankedRun ? tr.t("ui.continueRanked") : tr.t("ui.rankedRun")}
          </button>
          <button className="btn" disabled={!online} onClick={onLeaderboard}>
            {tr.t("ui.leaderboard")}
          </button>
        </div>
        <p className="muted small hint">{online ? tr.t("ui.rankedHint") : tr.t("ui.rankedOfflineHint")}</p>
        <div className="continue-list">
          <div className="muted small">{tr.t("ui.continue")}</div>
          {runs && active.length === 0 && <div className="muted small">{tr.t("ui.noRuns")}</div>}
          {active.slice(0, 5).map((r) => (
            <button key={r.runId} className="btn run-row" onClick={() => open(r.runId)}>
              <span>
                {tr.trainer(r.champion)}
                {r.ranked && <span className="ranked-tag">{tr.t("ui.rankedTag")}</span>}
              </span>
              <span>{tr.t("ui.round", { n: r.round })}</span>
              <span>{tr.t("ui.summary", { wins: r.wins, losses: r.losses })}</span>
              <span>{"♥".repeat(Math.max(0, r.lives))}</span>
            </button>
          ))}
        </div>
        {error && <div className="error">{error}</div>}
        <div className="settings-row">
          <label className="lang-select">
            <span>{tr.t("ui.language")}</span>
            <select value={lang} onChange={(e) => setLang(e.target.value)}>
              {langs.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          <SoundButton />
        </div>
        <div className={`mode-tag ${api.mode}`}>{online ? tr.t("ui.online") : tr.t("ui.offline")}</div>
      </div>
      <LegalNotice />
    </div>
  );
}
