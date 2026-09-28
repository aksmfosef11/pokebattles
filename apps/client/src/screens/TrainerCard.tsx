import { useState } from "react";
import { ARENAS, GameError, META_RULES } from "@pokebattles/game";
import type { Account, GameApi } from "../api.ts";
import { useI18n } from "../i18n.tsx";

/** Account looks bought with points: a new ID (online only) and the home arena. Shiny looks and nicknames live on the champion screen. */
export function TrainerCard({ api, account, onAccount, onBack }: { api: GameApi; account: Account; onAccount: (a: Account) => void; onBack: () => void }) {
  const { tr } = useI18n();
  const { profile } = account;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const online = api.mode === "online";
  const renamePrice = META_RULES.renamePrice;
  const arenaPrice = META_RULES.arenaPrice;

  const attempt = async (work: () => Promise<Account>) => {
    setBusy(true);
    setError(null);
    try {
      onAccount(await work());
    } catch (e) {
      setError(tr.t(`error.${e instanceof GameError ? e.code : "default"}`));
    }
    setBusy(false);
  };

  const rename = () =>
    attempt(async () => {
      const next = await api.rename(name.trim());
      setName("");
      return next;
    });

  return (
    <div className="leaderboard-screen">
      <header className="screen-header">
        <button className="btn" onClick={onBack}>
          {tr.t("ui.back")}
        </button>
        <h2>{tr.t("ui.trainerCard")}</h2>
        <span className="points-chip" title={tr.t("ui.pointsHint")}>
          {tr.t("ui.points", { n: profile.points })}
        </span>
      </header>
      <section className="panel">
        {online && (
          <div className="detail-block">
            <div className="label">{tr.t("ui.renameTitle")}</div>
            <p className="small">{tr.t("ui.renameDesc", { name: account.username ?? "" })}</p>
            <div className="training-actions">
              <input className="nickname-input" value={name} maxLength={16} placeholder={account.username ?? ""} aria-label={tr.t("ui.renameTitle")} onChange={(e) => setName(e.target.value)} />
              <button className="btn btn-small" data-sfx="se/buy" disabled={busy || !name.trim() || profile.points < renamePrice} onClick={rename}>
                {tr.t("ui.renameButton", { price: renamePrice })}
              </button>
            </div>
          </div>
        )}
        <div className="detail-block">
          <div className="label">{tr.t("ui.homeArena")}</div>
          <p className="small">{tr.t("ui.homeArenaDesc")}</p>
          <div className="arena-grid">
            {ARENAS.map((a) => {
              const owned = profile.arenas.includes(a);
              const home = profile.homeArena === a;
              return (
                <button
                  key={a}
                  className={`arena-card ${home ? "home" : ""} ${owned ? "" : "locked"}`}
                  data-sfx={owned ? undefined : "se/buy"}
                  disabled={busy || home || (!owned && profile.points < arenaPrice)}
                  style={{ backgroundImage: `url(/assets/arenas/${a}_bg.png)` }}
                  onClick={() => attempt(() => (owned ? api.setHomeArena(a) : api.buyArena(a)))}
                >
                  <span className="arena-tag">{home ? tr.t("ui.arenaHome") : owned ? tr.t("ui.arenaSetHome") : tr.t("ui.points", { n: arenaPrice })}</span>
                </button>
              );
            })}
          </div>
          {profile.homeArena && (
            <button className="btn btn-small" disabled={busy} onClick={() => attempt(() => api.setHomeArena(null))}>
              {tr.t("ui.arenaRandom")}
            </button>
          )}
        </div>
        {error && <div className="error">{error}</div>}
      </section>
    </div>
  );
}
