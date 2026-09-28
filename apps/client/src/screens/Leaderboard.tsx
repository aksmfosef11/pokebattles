import { useEffect, useState } from "react";
import { CHAMPION_KEYS, GameError, rankTier, type ChampionKey, type Profile } from "@pokebattles/game";
import type { ChampionWinsBoard, GameApi, Leaderboard } from "../api.ts";
import { ItemIcon, TrainerSprite } from "../components/sprites.tsx";
import { useI18n } from "../i18n.tsx";

type Tab = "rating" | "champion";

/** The champion the player has finished the most runs with (their first one before any). */
function favoriteChampion(profile: Profile): ChampionKey {
  let best: ChampionKey = profile.champions[0] ?? CHAMPION_KEYS[0]!;
  for (const c of CHAMPION_KEYS) if ((profile.runs[c] ?? 0) > (profile.runs[best] ?? 0)) best = c;
  return best;
}

/** Ranked ratings, and (a separate tab) trainers by battles won with each champion. */
export function LeaderboardScreen({ api, profile, onBack }: { api: GameApi; profile: Profile; onBack: () => void }) {
  const { tr } = useI18n();
  const [tab, setTab] = useState<Tab>("rating");
  const [board, setBoard] = useState<Leaderboard | null>(null);
  const [champion, setChampion] = useState<ChampionKey>(() => favoriteChampion(profile));
  const [wins, setWins] = useState<Partial<Record<ChampionKey, ChampionWinsBoard>>>({});
  const [error, setError] = useState<string | null>(null);
  const [winsError, setWinsError] = useState<string | null>(null);
  const message = (e: unknown) => tr.t(`error.${e instanceof GameError ? e.code : "default"}`);

  useEffect(() => {
    api
      .leaderboard()
      .then(setBoard)
      .catch((e) => setError(message(e)));
  }, [api, tr]);

  const champBoard = wins[champion] ?? null;
  useEffect(() => {
    if (tab !== "champion" || champBoard) return;
    setWinsError(null);
    api
      .championLeaderboard(champion)
      .then((b) => setWins((w) => ({ ...w, [champion]: b })))
      .catch((e) => setWinsError(message(e)));
  }, [api, tr, tab, champion, champBoard]);

  const players = tab === "rating" ? board && tr.t("ui.leaderboardPlayers", { n: board.players }) : champBoard && tr.t("ui.championWinsPlayers", { n: champBoard.players });

  return (
    <div className="leaderboard-screen">
      <header className="screen-header">
        <button className="btn" onClick={onBack}>
          {tr.t("ui.back")}
        </button>
        <h2>{tr.t("ui.leaderboard")}</h2>
        <span className="muted small">{players ?? ""}</span>
      </header>
      <div className="board-tabs" role="tablist">
        {(["rating", "champion"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`board-tab ${tab === t ? "on" : ""}`} onClick={() => setTab(t)}>
            {t === "rating" ? tr.t("ui.rating") : tr.t("ui.championWinsBoard")}
          </button>
        ))}
      </div>
      {tab === "rating" ? (
        <section className="panel">
          <p className="muted small">{tr.t("ui.rankedHint")}</p>
          {error && <div className="error">{error}</div>}
          {board && <RatingTable board={board} />}
        </section>
      ) : (
        <section className="panel">
          <div className="board-champions">
            {CHAMPION_KEYS.map((key) => (
              <button key={key} className={`board-champion ${key === champion ? "on" : ""}`} aria-pressed={key === champion} onClick={() => setChampion(key)}>
                <TrainerSprite champion={key} width={40} height={48} />
                <span>{tr.trainer(key)}</span>
              </button>
            ))}
          </div>
          <p className="muted small">{tr.t("ui.championWinsHint")}</p>
          {winsError && <div className="error">{winsError}</div>}
          {champBoard && <ChampionWinsTable board={champBoard} />}
        </section>
      )}
    </div>
  );
}

function RatingTable({ board }: { board: Leaderboard }) {
  const { tr } = useI18n();
  const me = board.me;
  const meListed = !!me && board.top.some((e) => e.username === me.username);
  if (board.top.length === 0) return <p className="muted">{tr.t("ui.leaderboardEmpty")}</p>;
  return (
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
  );
}

function ChampionWinsTable({ board }: { board: ChampionWinsBoard }) {
  const { tr } = useI18n();
  const me = board.me;
  const meListed = !!me && board.top.some((e) => e.username === me.username);
  if (board.top.length === 0) return <p className="muted">{tr.t("ui.championWinsEmpty")}</p>;
  const row = (e: ChampionWinsBoard["top"][number], place: number) => (
    <tr key={e.username} className={me?.username === e.username ? "me" : ""}>
      <td>{tr.t("ui.rank", { n: place })}</td>
      <td className="rank-name">{e.username}</td>
      <td>{e.wins}</td>
      <td>{e.trophies}</td>
      <td className="hide-narrow">{e.runs}</td>
    </tr>
  );
  return (
    <table className="rank-table">
      <thead>
        <tr>
          <th />
          <th>{tr.t("ui.trainer")}</th>
          <th>{tr.t("ui.winsColumn")}</th>
          <th>{tr.t("ui.trophiesColumn")}</th>
          <th className="hide-narrow">{tr.t("ui.runsColumn")}</th>
        </tr>
      </thead>
      <tbody>
        {/* Ties share the better place, like the server's own rank. */}
        {board.top.map((e) => row(e, board.top.findIndex((o) => o.wins === e.wins) + 1))}
        {me && !meListed && row(me, me.rank)}
      </tbody>
    </table>
  );
}
