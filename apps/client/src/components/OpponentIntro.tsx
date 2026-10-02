import { CHAMPIONS, SUBCLASS_ROUND, type UpcomingOpponent } from "@pokebattles/game";
import { useI18n } from "../i18n.tsx";
import { TrainerSprite, TypeBadge } from "./sprites.tsx";

/** The previewed opponents (top bar ⚔): who each champion is and the types their teams usually bring. */
export function OpponentIntro({ upcoming, onClose }: { upcoming: readonly UpcomingOpponent[]; onClose: () => void }) {
  const { tr } = useI18n();
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal panel opponent-intro" role="dialog" aria-label={tr.t("ui.opponentIntro")} onClick={(e) => e.stopPropagation()}>
        <h2>⚔ {tr.t("ui.opponentIntro")}</h2>
        <div className="opponent-cards">
          {upcoming.map((u, i) => {
            const def = CHAMPIONS[u.champion];
            const [a, b] = def.subclasses;
            return (
              <section key={u.round} className={`opponent-card ${i === 0 ? "now" : "later"}`}>
                <header>
                  <TrainerSprite champion={u.champion} width={48} height={56} />
                  <div>
                    <div className="muted small">{tr.t(i === 0 ? "ui.opponentNow" : "ui.opponentLater")}</div>
                    <b>{tr.trainer(u.champion)}</b>
                    <div className="small">
                      {tr.t("ui.generation", { n: def.generation })} · {tr.t(`champion.${u.champion}.concept`)}
                    </div>
                  </div>
                </header>
                <div className="detail-block">
                  <div className="label">{tr.t("ui.mainTypes")}</div>
                  <div className="types">
                    {def.mainTypes.map((t) => (
                      <TypeBadge key={t} type={t} />
                    ))}
                  </div>
                </div>
                <div className="detail-block">
                  <div className="label">{tr.t("ui.passive")}</div>
                  <ul className="ability-list small">
                    {tr.passives(u.champion).map((p) => (
                      <li key={p.name}>
                        <b className="ability-name">{p.name}</b>
                        <span>{p.desc}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                {u.subclass ? (
                  <div className="detail-block">
                    <div className="label">
                      {tr.t("ui.subclassLabel")} · {tr.t(`subclass.${u.subclass}.name`)}
                    </div>
                    <p className="small">{tr.t(`subclass.${u.subclass}.desc`)}</p>
                  </div>
                ) : (
                  // Not fixed yet (a later round): the champion has one of its two specializations from round 8.
                  u.subclass === undefined &&
                  u.round >= SUBCLASS_ROUND && (
                    <div className="detail-block">
                      <div className="label">{tr.t("ui.subclassLabel")}</div>
                      <p className="small">{tr.t("ui.subclassEither", { a: tr.t(`subclass.${a}.name`), b: tr.t(`subclass.${b}.name`) })}</p>
                    </div>
                  )
                )}
              </section>
            );
          })}
        </div>
        <p className="muted small opponent-note">※ {tr.t("ui.mainTypesNote")}</p>
        <button className="btn" onClick={onClose}>
          {tr.t("ui.close")}
        </button>
      </div>
    </div>
  );
}
