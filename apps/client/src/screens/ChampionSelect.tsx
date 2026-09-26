import { useState } from "react";
import {
  CHAMPION_KEYS,
  CHAMPIONS,
  championPool,
  GameError,
  ITEMS,
  lockedLinesAt,
  META_RULES,
  nextPoolUnlock,
  poolStage,
  type ChampionKey,
  type RunState,
} from "@pokebattles/game";
import type { Account, GameApi } from "../api.ts";
import { ItemIcon, PokemonSprite, TrainerSprite } from "../components/sprites.tsx";
import { useI18n } from "../i18n.tsx";

function exclusiveItems(champion: ChampionKey): { item: string; param?: string }[] {
  const all = Object.values(ITEMS).filter((d) => d.champions?.includes(champion) && !d.noShop);
  const plain = all.filter((d) => !d.mega && d.family !== "zCrystal").map((d) => ({ item: d.key, ...(d.param === "type" ? { param: "fire" } : {}) }));
  const megas = all.filter((d) => d.mega).slice(0, 3).map((d) => ({ item: d.key }));
  const zs = all.filter((d) => d.family === "zCrystal").slice(0, 4).map((d) => ({ item: d.key }));
  return [...plain, ...megas, ...zs].slice(0, 6);
}

/**
 * starter: a new player's free first champion (the run starts right away).
 * normal / ranked: start a run with an owned champion, or recruit one with points.
 */
export function ChampionSelect({
  api,
  account,
  mode,
  onAccount,
  onBack,
  onStart,
}: {
  api: GameApi;
  account: Account;
  mode: "starter" | "normal" | "ranked";
  onAccount: (a: Account) => void;
  onBack?: () => void;
  onStart: (s: RunState) => void;
}) {
  const { tr } = useI18n();
  const { profile } = account;
  const owns = (key: ChampionKey) => mode === "starter" || profile.champions.includes(key);
  const [selected, setSelected] = useState<ChampionKey>(() => (mode === "starter" ? "red" : (profile.champions[0] ?? "red")));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const attempt = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(tr.t(`error.${e instanceof GameError ? e.code : "default"}`));
    }
    setBusy(false);
  };

  const start = () =>
    attempt(async () => {
      if (mode === "starter") {
        const picked = await api.chooseStarter(selected);
        const state = await api.startRun(selected, false);
        onAccount(picked);
        onStart(state);
        return;
      }
      onStart(await api.startRun(selected, mode === "ranked"));
    });

  const recruit = () => attempt(async () => onAccount(await api.buyChampion(selected)));

  const champ = CHAMPIONS[selected];
  const stage = poolStage(profile, selected);
  const unlocked = championPool({ champion: selected, lockedLines: lockedLinesAt(selected, stage) }).size;
  const next = nextPoolUnlock(profile, selected);
  const price = META_RULES.championPrice;
  const owned = owns(selected);

  return (
    <div className="champion-screen">
      <header className="screen-header">
        {onBack ? (
          <button className="btn" onClick={onBack}>
            {mode === "starter" ? tr.t("ui.logout") : tr.t("ui.back")}
          </button>
        ) : (
          <span />
        )}
        <h2>
          {mode === "starter" ? tr.t("ui.chooseStarter") : tr.t("ui.chooseChampion")}
          {mode === "ranked" && <span className="ranked-tag">{tr.t("ui.rankedTag")}</span>}
        </h2>
        <span className="points-chip" title={tr.t("ui.pointsHint")}>
          {tr.t("ui.points", { n: profile.points })}
        </span>
        {mode === "starter" && <p className="starter-note">{tr.t("ui.chooseStarterDesc", { price })}</p>}
      </header>
      <div className="champion-grid">
        {CHAMPION_KEYS.map((key) => (
          <button
            key={key}
            className={`champion-card ${key === selected ? "selected" : ""} ${owns(key) ? "" : "unowned"}`}
            onClick={() => setSelected(key)}
          >
            <TrainerSprite champion={key} width={72} height={88} />
            <div className="champion-name">{tr.trainer(key)}</div>
            <div className="muted small">
              {tr.t("ui.generation", { n: CHAMPIONS[key].generation })} · {tr.t(`champion.${key}.concept`)}
            </div>
            {!owns(key) && <div className="lock-badge">🔒 {tr.t("ui.points", { n: price })}</div>}
          </button>
        ))}
      </div>
      <section className="champion-detail panel">
        <div className="champion-detail-head">
          <TrainerSprite champion={selected} width={120} height={150} />
          <div>
            <div className="small muted">
              {tr.championTitle()} · {tr.t("ui.generation", { n: champ.generation })}
            </div>
            <h3>{tr.trainer(selected)}</h3>
            <div className="concept">{tr.t(`champion.${selected}.concept`)}</div>
            <div className="starter-row">
              <span className="muted small">{tr.t("ui.starter")}</span>
              <PokemonSprite species={champ.starter.species} width={56} height={56} />
              <span>{tr.species(champ.starter.species)}</span>
              <ItemIcon item={champ.starter.item} param={champ.starter.itemParam} size={28} />
              <span>{tr.itemName(champ.starter.item, champ.starter.itemParam)}</span>
            </div>
          </div>
        </div>
        <div className="detail-block">
          <div className="label">
            {tr.t("ui.passive")} · {tr.t(`champion.${selected}.passiveName`)}
          </div>
          <p>{tr.t(`champion.${selected}.passive`)}</p>
        </div>
        <div className="detail-block">
          <div className="label">
            {tr.t("ui.shopPool")} · {tr.t("ui.poolProgress", { n: unlocked, total: championPool(selected).size })}
          </div>
          <p className="small">{tr.t("ui.shopPoolDesc", { n: champ.generation, count: championPool(selected).size })}</p>
          <div className="squad-row">
            {champ.squad.map((key) => (
              <span key={key} className="squad-mon" title={tr.species(key)}>
                <PokemonSprite species={key} width={40} height={40} animate={false} />
              </span>
            ))}
          </div>
          {next ? (
            <>
              {stage === 0 && <p className="small muted">{tr.t("ui.poolLockedNote")}</p>}
              <p className="small">{tr.t("ui.poolNext", { runs: next.runsLeft, count: next.species.length })}</p>
              <div className="squad-row next-unlock">
                {next.species.slice(0, 12).map((key) => (
                  <span key={key} className="squad-mon" title={tr.species(key)}>
                    <PokemonSprite species={key} width={32} height={32} animate={false} />
                  </span>
                ))}
                {next.species.length > 12 && <span className="muted small">+{next.species.length - 12}</span>}
              </div>
            </>
          ) : (
            <p className="small gold">{tr.t("ui.poolFull")}</p>
          )}
        </div>
        <div className="detail-block">
          <div className="label">{tr.t("ui.exclusive")}</div>
          <div className="item-row">
            {exclusiveItems(selected).map((it) => (
              <span key={it.item} className="item-chip" title={tr.itemEffect(it.item, it.param)}>
                <ItemIcon item={it.item} param={it.param} size={28} />
                {tr.itemName(it.item, it.param)}
              </span>
            ))}
          </div>
        </div>
        <div className="detail-block">
          <div className="label">{tr.t("ui.subclasses")}</div>
          <div className="subclass-preview">
            {champ.subclasses.map((s) => (
              <div key={s} className="subclass-mini">
                <b>{tr.t(`subclass.${s}.name`)}</b>
                <span>{tr.t(`subclass.${s}.desc`)}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="start-row">
          {owned ? (
            <>
              <span className="muted small">{mode === "ranked" ? tr.t("ui.rankedHint") : ""}</span>
              <button className="btn btn-primary" disabled={busy} onClick={start}>
                {mode === "starter" ? tr.t("ui.startWith") : mode === "ranked" ? tr.t("ui.startRanked") : tr.t("ui.start")}
              </button>
            </>
          ) : (
            <>
              <span className="muted small">
                {profile.points < price ? tr.t("ui.recruitNeed", { n: price - profile.points }) : tr.t("ui.notOwned")}
                {" · "}
                {tr.t("ui.pointsHint")}
              </span>
              <button className="btn btn-primary" data-sfx="se/buy" disabled={busy || profile.points < price} onClick={recruit}>
                {tr.t("ui.recruit", { price })}
              </button>
            </>
          )}
        </div>
        {error && <div className="error">{error}</div>}
      </section>
    </div>
  );
}
