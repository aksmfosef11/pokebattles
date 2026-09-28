import { useEffect, useState } from "react";
import { useI18n } from "../i18n.tsx";

const SEEN_KEY = "pokebattles.patchSeen";

function seenPatch(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

/**
 * Patch notes under the title and login menus (entries from the game locale, newest first). The newest one
 * opens by itself, marked new, the first time it is shown; after that it is one line like the older ones.
 */
export function PatchNotes() {
  const { tr } = useI18n();
  const entries = tr.patchNotes();
  const latest = entries[0];
  const [fresh] = useState(() => !!latest && seenPatch() !== latest.date);

  useEffect(() => {
    if (!latest) return;
    try {
      localStorage.setItem(SEEN_KEY, latest.date);
    } catch {
      /* private mode: it simply opens again next time */
    }
  }, [latest]);

  if (!latest) return null;
  return (
    <section className="patch-notes panel">
      <details open={fresh}>
        <summary>
          <b>{tr.t("patchNotes.title")}</b> <span className="muted small">{latest.date}</span>
          {fresh && <span className="new-tag">{tr.t("patchNotes.new")}</span>}
        </summary>
        <ul>
          {latest.items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      </details>
      {entries.length > 1 && (
        <details className="patch-older">
          <summary className="muted small">{tr.t("patchNotes.older")}</summary>
          {entries.slice(1).map((e) => (
            <div key={e.date}>
              <div className="muted small">{e.date}</div>
              <ul>
                {e.items.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>
          ))}
        </details>
      )}
    </section>
  );
}
