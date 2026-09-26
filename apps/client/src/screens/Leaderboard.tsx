import { useEffect, useState } from "react";
import { GameError, rankTier } from "@pokebattles/game";
import type { GameApi, Leaderboard } from "../api.ts";
import { ItemIcon } from "../components/sprites.tsx";
import { useI18n } from "../i18n.tsx";

export function LeaderboardScreen({ api, onBack }: { api: GameApi; onBack: () => void }) {
  const { tr } = useI18n();
  const [board, setBoard] = useState<Leaderboard | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .leaderboard()
      .then(setBoard)
      .catch((e) => setError(tr.t(`error.${e instanceof GameError ? e.code : "default"}`)));
  }, [api, tr]);

  const me = board?.me ?? null;
  const meListed = !!me && board!.top.some((e) => e.username === me.username);

  return (
    <div className="leaderboard-screen">
      <header className="screen-header">
        <button className="btn" onClick={onBack}>
          {tr.t("ui.back")}
        </button>
        <h2>{tr.t("ui.leaderboard")}</h2>
        <span className="muted small">{board ? tr.t("ui.leaderboardPlayers", { n: board.players }) : ""}</span>
      </header>
      <section className="panel">
        <p className="muted small">{tr.t("ui.rankedHint")}</p>
        {error && <div className="error">{error}</div>}
        {board && board.top.length === 0 && <p className="muted">{tr.t("ui.leaderboardEmpty")}</p>}
        {board && board.top.length > 0 && (
          <table className="rank-table">
            <thead>
              <tr>
                <th />
                <th>{tr.t("ui.trainer")}</th>
                <th>{tr.t("ui.rating")}</th>
                <th className="hide-narrow">{tr.t("ui.rankedRun")}</th>
              </tr>
            </thead>
            <tbody>
              {board.top.map((e, i) => {
                // Ties share the better place, like the server's own rank.
                const place = board.top.findIndex((o) => o.rating === e.rating) + 1;
                return (
                  <tr key={e.username} className={me?.username === e.username ? "me" : ""}>
                    <td>{tr.t("ui.rank", { n: place || i + 1 })}</td>
                    <td className="rank-name">
                      <ItemIcon item={rankTier(e.rating)} size={22} />
                      {e.username}
                    </td>
                    <td>{e.rating}</td>
                    <td className="hide-narrow">{e.rankedRuns}</td>
                  </tr>
                );
              })}
              {me && !meListed && (
                <tr className="me">
                  <td>{tr.t("ui.rank", { n: me.rank })}</td>
                  <td className="rank-name">
                    <ItemIcon item={rankTier(me.rating)} size={22} />
                    {me.username}
                  </td>
                  <td>{me.rating}</td>
                  <td className="hide-narrow">{me.rankedRuns}</td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
