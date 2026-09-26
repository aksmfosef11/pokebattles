import { useI18n } from "../i18n.tsx";

/** Where rights holders reach us (takedown requests). */
export const CONTACT_EMAIL = "zkwpsk66@gmail.com";

/** Fan-game notice under the login and title menus: one line, the full text when opened. */
export function LegalNotice() {
  const { tr } = useI18n();
  return (
    <footer className="legal">
      <details>
        <summary>{tr.t("legal.summary")}</summary>
        {(["unofficial", "rights", "free", "credits", "takedown"] as const).map((k) => (
          <p key={k}>{tr.t(`legal.${k}`)}</p>
        ))}
      </details>
      <p>
        {tr.t("legal.contact")} <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
      </p>
    </footer>
  );
}
