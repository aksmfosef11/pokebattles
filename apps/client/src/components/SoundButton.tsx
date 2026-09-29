import { useEffect, useRef, useState } from "react";
import { sound, useSoundSettings } from "../audio.ts";
import { useI18n } from "../i18n.tsx";

/** A small popover's open state; it closes on a press outside its root or on Escape. */
export function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  return { open, setOpen, ref };
}

/** Music and effect volume, and mute. Settings stay in this browser. */
export function SoundControls() {
  const { tr } = useI18n();
  const settings = useSoundSettings();
  const slider = (kind: "bgm" | "se", label: string) => (
    <label className="sound-row">
      <span>{label}</span>
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={Math.round(settings[kind] * 100)}
        onChange={(e) => {
          const v = Number(e.target.value) / 100;
          sound.update(kind === "bgm" ? { bgm: v, muted: false } : { se: v, muted: false });
        }}
        // Let the effects slider be heard while it moves.
        onPointerUp={() => kind === "se" && sound.playSe("ui/select")}
      />
      <span className="sound-val">{Math.round(settings[kind] * 100)}</span>
    </label>
  );
  return (
    <>
      {slider("bgm", tr.t("ui.bgmVolume"))}
      {slider("se", tr.t("ui.seVolume"))}
      <button type="button" className="btn btn-small" data-sfx="none" onClick={() => sound.update({ muted: !settings.muted })}>
        {settings.muted ? `🔊 ${tr.t("ui.soundOn")}` : `🔇 ${tr.t("ui.mute")}`}
      </button>
    </>
  );
}

/** Speaker button with a small panel of the sound controls. */
export function SoundButton() {
  const { tr } = useI18n();
  const settings = useSoundSettings();
  const { open, setOpen, ref } = usePopover();
  const silent = settings.muted || (settings.bgm === 0 && settings.se === 0);

  return (
    <div ref={ref} className="sound-ctl">
      <button
        type="button"
        className={`btn btn-small icon-btn ${silent ? "off" : ""}`}
        data-sfx="ui/menu_open"
        aria-label={tr.t("ui.sound")}
        aria-expanded={open}
        title={tr.t("ui.sound")}
        onClick={() => setOpen((o) => !o)}
      >
        {silent ? "🔇" : settings.bgm === 0 ? "🔈" : "🔊"}
      </button>
      {open && (
        <div className="sound-pop panel" role="dialog" aria-label={tr.t("ui.sound")}>
          <SoundControls />
        </div>
      )}
    </div>
  );
}
