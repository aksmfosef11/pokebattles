import { useI18n } from "../i18n.tsx";
import { SoundControls, usePopover } from "./SoundButton.tsx";

/** Portrait phones: recipes, sound and back-to-title share one menu, so the top bar stays a single row. */
export function RunMenu({ onRecipes, onQuit }: { onRecipes: () => void; onQuit: () => void }) {
  const { tr } = useI18n();
  const { open, setOpen, ref } = usePopover();
  return (
    <div ref={ref} className="run-menu">
      <button
        type="button"
        className="btn btn-small icon-btn"
        data-sfx="ui/menu_open"
        aria-label={tr.t("ui.menu")}
        aria-expanded={open}
        title={tr.t("ui.menu")}
        onClick={() => setOpen((o) => !o)}
      >
        ☰
      </button>
      {open && (
        <div className="run-menu-pop panel" role="dialog" aria-label={tr.t("ui.menu")}>
          <button
            type="button"
            className="btn"
            data-sfx="ui/menu_open"
            onClick={() => {
              setOpen(false);
              onRecipes();
            }}
          >
            📖 {tr.t("ui.recipes")}
          </button>
          <div className="run-menu-sound">
            <SoundControls />
          </div>
          <button type="button" className="btn" onClick={onQuit}>
            ⌂ {tr.t("ui.backToTitle")}
          </button>
        </div>
      )}
    </div>
  );
}
