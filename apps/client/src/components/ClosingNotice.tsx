import { useI18n } from "../i18n.tsx";

/** Where the source code lives once the service has closed. */
export const REPO_URL = "https://github.com/aksmfosef11/pokebattles";

/** Service-closing announcement under the subtitle of the login and title screens. */
export function ClosingNotice() {
  const { tr } = useI18n();
  return (
    <aside className="closing-notice panel" role="note">
      <b className="closing-title">{tr.t("closing.title")}</b>
      <p>{tr.t("closing.body")}</p>
      <p>{tr.t("closing.source")}</p>
      <p>
        <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
          {tr.t("closing.link")} ↗
        </a>
      </p>
      <p className="muted small">{tr.t("closing.thanks")}</p>
    </aside>
  );
}
