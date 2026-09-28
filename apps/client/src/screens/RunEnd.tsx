import { getSpecies, rankTier, WINS_TO_CLEAR, type RunReward, type RunState } from "@pokebattles/game";
import { ItemIcon, PokemonSprite, ShinyLines, TrainerSprite } from "../components/sprites.tsx";
import { useI18n } from "../i18n.tsx";

export function RunEnd({ state, reward, onTitle }: { state: RunState; reward?: RunReward; onTitle: () => void }) {
  const { tr } = useI18n();
  const cleared = state.wins >= WINS_TO_CLEAR;
  const team = Object.values(state.pieces).filter((p) => p.kind === "pokemon" && p.place);
  return (
    <ShinyLines.Provider value={state.cosmetics?.shinyLines}>
      <div className="end-screen">
        <div className="panel end-panel">
          <TrainerSprite champion={state.champion} width={120} height={150} />
          <h2>
            {cleared ? tr.t("ui.runCleared") : tr.t("ui.runOver")}
            {state.ranked && <span className="ranked-tag">{tr.t("ui.rankedTag")}</span>}
          </h2>
          <div className="big-score">{tr.t("ui.summary", { wins: state.wins, losses: state.losses })}</div>
          {reward && (
            <div className="reward-box">
              <div className="points-chip">{tr.t("ui.rewardPoints", { n: reward.points, total: reward.totalPoints })}</div>
              {reward.rating && (
                <div className="reward-rating">
                  <ItemIcon item={rankTier(reward.rating.after)} size={24} />
                  {tr.t("ui.rewardRating", {
                    before: reward.rating.before,
                    after: reward.rating.after,
                    delta: `${reward.rating.after >= reward.rating.before ? "+" : ""}${reward.rating.after - reward.rating.before}`,
                  })}
                </div>
              )}
              {reward.unlocked.length > 0 && (
                <div className="reward-unlocked">
                  <div className="gold">{tr.t("ui.rewardUnlocked", { champion: tr.trainer(state.champion), n: reward.unlocked.length })}</div>
                  <div className="squad-row">
                    {reward.unlocked.map((key) => (
                      <span key={key} className="squad-mon" title={tr.species(key)}>
                        <PokemonSprite species={key} width={36} height={36} animate={false} />
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          <div className="end-team">
            {team.map((p) =>
              p.kind === "pokemon" ? (
                <div key={p.uid} className="end-mon">
                  <PokemonSprite species={p.species} formKey={getSpecies(p.species).spriteForm} shiny={p.shiny} width={72} height={72} />
                  <span className="small">{p.nickname ?? tr.species(p.species)}</span>
                  <span className="muted small">{tr.t("ui.level", { n: p.level })}</span>
                </div>
              ) : null,
            )}
          </div>
          <ul className="log-list">
            {state.log.map((l) => (
              <li key={l.round} className={l.outcome}>
                {tr.t("ui.round", { n: l.round })} · {l.outcome === "win" ? tr.t("ui.victory") : l.outcome === "loss" ? tr.t("ui.defeat") : tr.t("ui.draw")} ·{" "}
                {l.opponent.ghost ? tr.t("ui.ghostOf", { name: l.opponent.name }) : tr.t("ui.botTrainer")} ({tr.trainer(l.opponent.champion)})
                {l.opponent.rating !== undefined && ` · ${tr.t("ui.rating")} ${l.opponent.rating}`}
              </li>
            ))}
          </ul>
          <button className="btn btn-primary" onClick={onTitle}>
            {tr.t("ui.backToTitle")}
          </button>
        </div>
      </div>
    </ShinyLines.Provider>
  );
}
