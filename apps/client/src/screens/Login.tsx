import { useState, type FormEvent } from "react";
import { GameError } from "@pokebattles/game";
import type { Account, GameApi } from "../api.ts";
import { LegalNotice } from "../components/LegalNotice.tsx";
import { PatchNotes } from "../components/PatchNotes.tsx";
import { TrainerSprite } from "../components/sprites.tsx";
import { SoundButton } from "../components/SoundButton.tsx";
import { useI18n } from "../i18n.tsx";

/** ID + password only (4+ characters each). The same form logs in or signs up. */
export function Login({ api, onLogin }: { api: GameApi; onLogin: (a: Account) => void }) {
  const { tr, lang, langs, setLang } = useI18n();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (kind: "login" | "register") => {
    setBusy(true);
    setError(null);
    try {
      onLogin(kind === "login" ? await api.login(username, password) : await api.register(username, password));
    } catch (e) {
      setError(tr.t(`error.${e instanceof GameError ? e.code : "default"}`));
      setBusy(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit("login");
  };

  const filled = username.trim().length >= 4 && password.length >= 4;

  return (
    <div className="title-screen">
      <div className="title-champions">
        {["red", "cynthia", "leon", "diantha", "steven"].map((c) => (
          <TrainerSprite key={c} champion={c} width={96} height={120} />
        ))}
      </div>
      <h1 className="logo">{tr.t("title")}</h1>
      <p className="subtitle">{tr.t("subtitle")}</p>
      <form className="title-menu panel login-form" onSubmit={onSubmit}>
        <label className="field">
          <span className="muted small">{tr.t("ui.username")}</span>
          <input value={username} autoComplete="username" maxLength={16} autoCapitalize="none" spellCheck={false} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label className="field">
          <span className="muted small">{tr.t("ui.password")}</span>
          <input type="password" value={password} autoComplete="current-password" maxLength={72} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <p className="muted small hint">{tr.t("ui.loginHint")}</p>
        <div className="login-buttons">
          <button type="submit" className="btn btn-primary" disabled={busy || !filled}>
            {tr.t("ui.login")}
          </button>
          <button type="button" className="btn" disabled={busy || !filled} onClick={() => submit("register")}>
            {tr.t("ui.register")}
          </button>
        </div>
        <p className="muted small hint">{tr.t("ui.registerHint")}</p>
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
      </form>
      <PatchNotes />
      <LegalNotice />
    </div>
  );
}
