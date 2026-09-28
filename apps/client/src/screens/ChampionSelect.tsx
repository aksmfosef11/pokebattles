import { useState } from "react";
import {
  abilityOptions,
  CHAMPION_KEYS,
  CHAMPIONS,
  championPool,
  GameError,
  ITEMS,
  lockedLinesAt,
  MAX_IV,
  META_RULES,
  natureEffect,
  NICKNAME_MAX,
  nextPoolUnlock,
  poolStage,
  shinyLinesOf,
  START_ITEMS,
  STAT_KEYS,
  starterTraining,
  type ChampionKey,
  type Nature,
  type RunState,
  type StartItem,
  type StarterTrainingKind,
} from "@pokebattles/game";
import type { Account, GameApi } from "../api.ts";
import { ItemIcon, PokemonSprite, ShinyLines, TrainerSprite } from "../components/sprites.tsx";
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
  /** Which stat the last IV point went to. */
  const [raised, setRaised] = useState<string | null>(null);
  const [startItems, setStartItems] = useState<StartItem[]>([]);
  /** The line the last shiny draw gave. */
  const [drawnShiny, setDrawnShiny] = useState<string | null>(null);
  /** The nickname being typed (null: showing the saved one). */
  const [nickDraft, setNickDraft] = useState<string | null>(null);

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
      if (mode === "starter") await api.chooseStarter(selected);
      const { state, account: after } = await api.startRun(selected, mode === "ranked", mode === "starter" ? [] : startItems);
      onAccount(after);
      onStart(state);
    });

  const pick = (key: ChampionKey) => {
    setSelected(key);
    setRaised(null);
    setDrawnShiny(null);
    setNickDraft(null);
  };

  const recruit = () => attempt(async () => onAccount(await api.buyChampion(selected)));
  const buyStage = () => attempt(async () => onAccount(await api.buyPoolStage(selected)));
  const train = (kind: StarterTrainingKind) =>
    attempt(async () => {
      const next = await api.trainStarter(selected, kind);
      const before = starterTraining(profile, selected).ivBonus ?? {};
      const after = starterTraining(next.profile, selected).ivBonus ?? {};
      const stat = kind === "iv" ? STAT_KEYS.find((k) => (after[k] ?? 0) > (before[k] ?? 0)) : undefined;
      setRaised(stat ? tr.t("ui.ivRaised", { stat: tr.stat(stat) }) : null);
      onAccount(next);
    });
  const keepDraw = (keep: boolean) => attempt(async () => onAccount(await api.keepStarterDraw(selected, keep)));
  const saveNickname = () =>
    attempt(async () => {
      onAccount(await api.nameStarter(selected, nickDraft ?? ""));
      setNickDraft(null);
    });
  const drawShiny = () =>
    attempt(async () => {
      const next = await api.drawShiny(selected);
      setDrawnShiny(next.profile.shinyLines.at(-1) ?? null);
      onAccount(next);
    });
  const toggleStartItem = (key: StartItem) =>
    setStartItems((list) => (list.includes(key) ? list.filter((k) => k !== key) : START_ITEMS.filter((k) => k === key || list.includes(k))));

  const natureLabel = (n: Nature) => {
    const { up, down } = natureEffect(n);
    return up && down ? `${tr.nature(n)} (${tr.stat(up)}↑ ${tr.stat(down)}↓)` : tr.nature(n);
  };
  const abilityLabel = (a: { ability: string; hidden: boolean }) => `${tr.ability(a.ability)}${a.hidden ? ` (${tr.t("ui.hiddenAbility")})` : ""}`;

  const champ = CHAMPIONS[selected];
  const stage = poolStage(profile, selected);
  const unlocked = championPool({ champion: selected, lockedLines: lockedLinesAt(selected, stage) }).size;
  const next = nextPoolUnlock(profile, selected);
  const price = META_RULES.championPrice;
  const stagePrice = META_RULES.poolStagePrice;
  const itemPrice = META_RULES.startItemPrice;
  const owned = owns(selected);
  // Pool stages, starter training and start items are for recruited champions (not while picking the free starter).
  const canBuyStage = mode !== "starter" && profile.champions.includes(selected);
  const training = starterTraining(profile, selected);
  const keptAbility = training.ability;
  const abilityDraws = abilityOptions(champ.starter.species).filter((o) => !(keptAbility && o.ability === keptAbility.ability && o.hidden === keptAbility.hidden));
  const ivBonus = STAT_KEYS.filter((k) => (training.ivBonus?.[k] ?? 0) > 0);
  const ivFull = STAT_KEYS.every((k) => (training.ivBonus?.[k] ?? 0) >= MAX_IV);
  const itemsCost = startItems.length * itemPrice;
  const shinyHere = shinyLinesOf(selected);
  const shinyOwned = shinyHere.filter((l) => profile.shinyLines.includes(l));
  const nickname = nickDraft ?? training.nickname ?? "";
  const nicknameChanged = nickname.trim() !== (training.nickname ?? "");

  return (
    <ShinyLines.Provider value={profile.shinyLines}>
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
              onClick={() => pick(key)}
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
                <span>{(canBuyStage && training.nickname) || tr.species(champ.starter.species)}</span>
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
                {canBuyStage && (
                  <div className="pool-buy-row">
                    <button className="btn" data-sfx="se/buy" disabled={busy || profile.points < stagePrice} onClick={buyStage}>
                      {tr.t("ui.poolBuy", { price: stagePrice })}
                    </button>
                    {profile.points < stagePrice && <span className="muted small">{tr.t("ui.poolBuyNeed", { n: stagePrice - profile.points })}</span>}
                  </div>
                )}
              </>
            ) : (
              <p className="small gold">{tr.t("ui.poolFull")}</p>
            )}
          </div>
          {canBuyStage && (
            <div className="detail-block">
              <div className="label">{tr.t("ui.starterTraining")}</div>
              <p className="small">{tr.t("ui.starterTrainingDesc", { species: tr.species(champ.starter.species) })}</p>
              <div className="training-grid">
                <span className="muted small">{tr.t("ui.nature")}</span>
                <span>{training.nature ? natureLabel(training.nature) : tr.t("ui.randomEachRun")}</span>
                <span className="muted small">{tr.t("ui.ability")}</span>
                <span>{keptAbility ? abilityLabel(keptAbility) : tr.t("ui.randomEachRun")}</span>
                <span className="muted small">{tr.t("ui.ivBonus")}</span>
                <span>{ivBonus.length > 0 ? ivBonus.map((k) => `${tr.stat(k)} +${training.ivBonus![k]}`).join(" · ") : "+0"}</span>
              </div>
              {training.draw && (
                <div className="draw-result">
                  <b>
                    {training.draw.kind === "nature"
                      ? tr.t("ui.drawNature", { name: natureLabel(training.draw.nature) })
                      : tr.t("ui.drawAbility", { name: abilityLabel(training.draw) })}
                  </b>
                  <div className="training-actions">
                    <button className="btn btn-small btn-primary" disabled={busy} onClick={() => keepDraw(true)}>
                      {tr.t("ui.keepDraw")}
                    </button>
                    <button className="btn btn-small" disabled={busy} onClick={() => keepDraw(false)}>
                      {tr.t("ui.dropDraw")}
                    </button>
                  </div>
                </div>
              )}
              <div className="training-actions">
                <button className="btn btn-small" data-sfx="se/buy" disabled={busy || profile.points < META_RULES.natureDrawPrice} onClick={() => train("nature")}>
                  {tr.t("ui.trainNature", { price: META_RULES.natureDrawPrice })}
                </button>
                <button
                  className="btn btn-small"
                  data-sfx="se/buy"
                  disabled={busy || abilityDraws.length === 0 || profile.points < META_RULES.abilityDrawPrice}
                  onClick={() => train("ability")}
                >
                  {tr.t("ui.trainAbility", { price: META_RULES.abilityDrawPrice })}
                </button>
                <button className="btn btn-small" data-sfx="se/buy" disabled={busy || ivFull || profile.points < META_RULES.ivPointPrice} onClick={() => train("iv")}>
                  {tr.t("ui.trainIv", { price: META_RULES.ivPointPrice })}
                </button>
              </div>
              {raised && <p className="small gold">{raised}</p>}
              <div className="training-actions">
                <input
                  className="nickname-input"
                  value={nickname}
                  maxLength={NICKNAME_MAX}
                  placeholder={tr.t("ui.nicknamePlaceholder")}
                  aria-label={tr.t("ui.nickname")}
                  onChange={(e) => setNickDraft(e.target.value)}
                />
                <button
                  className="btn btn-small"
                  data-sfx="se/buy"
                  disabled={busy || !nicknameChanged || (nickname.trim() !== "" && profile.points < META_RULES.nicknamePrice)}
                  onClick={saveNickname}
                >
                  {nickname.trim() ? tr.t("ui.nicknameSet", { price: META_RULES.nicknamePrice }) : tr.t("ui.nicknameClear")}
                </button>
              </div>
            </div>
          )}
          {canBuyStage && (
            <div className="detail-block">
              <div className="label">
                {tr.t("ui.shinyLooks")} · {tr.t("ui.shinyProgress", { n: shinyOwned.length, total: shinyHere.length })}
              </div>
              <p className="small">{tr.t("ui.shinyLooksDesc")}</p>
              {drawnShiny && (
                <div className="draw-result shiny-result">
                  <PokemonSprite species={drawnShiny} width={56} height={56} />
                  <b>{tr.t("ui.shinyDrawn", { species: tr.species(drawnShiny) })}</b>
                </div>
              )}
              {shinyOwned.length > 0 && (
                <div className="squad-row">
                  {shinyOwned.map((key) => (
                    <span key={key} className="squad-mon" title={tr.species(key)}>
                      <PokemonSprite species={key} width={32} height={32} animate={false} />
                    </span>
                  ))}
                </div>
              )}
              <div className="training-actions">
                <button
                  className="btn btn-small"
                  data-sfx="se/buy"
                  disabled={busy || shinyOwned.length >= shinyHere.length || profile.points < META_RULES.shinyDrawPrice}
                  onClick={drawShiny}
                >
                  {shinyOwned.length >= shinyHere.length ? tr.t("ui.shinyComplete") : tr.t("ui.shinyDraw", { price: META_RULES.shinyDrawPrice })}
                </button>
              </div>
            </div>
          )}
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
          {canBuyStage && (
            <div className="detail-block">
              <div className="label">{tr.t("ui.startItems")}</div>
              <p className="small muted">{tr.t("ui.startItemsHint")}</p>
              <div className="start-items">
                {START_ITEMS.map((key) => {
                  const on = startItems.includes(key);
                  const affordable = on || profile.points >= itemsCost + itemPrice;
                  return (
                    <button key={key} className={`item-chip item-toggle ${on ? "on" : ""}`} aria-pressed={on} disabled={busy || !affordable} onClick={() => toggleStartItem(key)}>
                      <ItemIcon item={key} size={24} />
                      {tr.t("ui.startItemToggle", { name: tr.itemName(key), price: itemPrice })}
                    </button>
                  );
                })}
              </div>
              {START_ITEMS.map((key) => (
                <p key={key} className="small muted">
                  {tr.itemName(key)}: {tr.itemEffect(key)}
                </p>
              ))}
            </div>
          )}
          <div className="start-row">
            {owned ? (
              <>
                <span className="muted small">{mode === "ranked" ? tr.t("ui.rankedHint") : ""}</span>
                <button className="btn btn-primary" disabled={busy || itemsCost > profile.points} onClick={start}>
                  {mode === "starter" ? tr.t("ui.startWith") : mode === "ranked" ? tr.t("ui.startRanked") : tr.t("ui.start")}
                  {canBuyStage && itemsCost > 0 && ` (−${tr.t("ui.points", { n: itemsCost })})`}
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
    </ShinyLines.Provider>
  );
}
