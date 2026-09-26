/**
 * Music and sound effects: PokéRogue's own files, copied by `pnpm sprites` into public/assets/audio
 * with a manifest of loop points (tools/extract/fetch-assets.ts).
 *
 * Effects are short WAVs decoded into Web Audio buffers (they overlap and start instantly). Music
 * streams through two <audio> elements that take turns, so a track starts before it has fully
 * downloaded and is never decoded whole into memory; both elements are unlocked by the first tap,
 * which is what lets iOS change tracks later without a tap. Where Web Audio is available the music
 * runs through it as well, because iOS ignores an <audio> element's own volume.
 */
import { useEffect, useSyncExternalStore } from "react";
import type { ChampionKey } from "@pokebattles/game";

interface AudioManifest {
  bgm: Record<string, { file: string; loop: number | null }>;
  se: Record<string, { file: string; duration?: number }>;
}

export interface SoundSettings {
  /** 0–1 */
  bgm: number;
  /** 0–1 */
  se: number;
  muted: boolean;
}

/** Each champion's battle theme as PokéRogue plays it for that trainer (Red takes the Kanto one, Lance keeps Johto's). */
const CHAMPION_BGM: Record<ChampionKey, string> = {
  red: "battle_kanto_champion",
  lance: "battle_johto_champion",
  steven: "battle_hoenn_champion_g6",
  cynthia: "battle_sinnoh_champion",
  alder: "battle_champion_alder",
  diantha: "battle_kalos_champion",
  kukui: "battle_champion_kukui",
  leon: "battle_galar_champion",
  geeta: "battle_champion_geeta",
};

export const BGM = {
  title: "title",
  menu: "menu",
  /** The two GTS themes take turns round by round. */
  shop: (round: number) => (round % 2 === 1 ? "mystery_encounter_gen_5_gts" : "mystery_encounter_gen_6_gts"),
  battle: (opponent: ChampionKey) => CHAMPION_BGM[opponent] ?? "battle_trainer",
  victory: "bw/victory_trainer",
  cleared: "bw/victory_champion",
} as const;

const SETTINGS_KEY = "pokebattles.sound";
const DEFAULTS: SoundSettings = { bgm: 0.45, se: 0.7, muted: false };
/** Music sits under the effects at equal slider positions. */
const BGM_SCALE = 0.6;
const FADE_OUT = 0.45;
const FADE_IN = 0.25;
/** The same effect again within this many ms is dropped (fast-forwarded battles fire many hits per frame). */
const SE_GAP_MS = 45;
const MAX_VOICES = 10;
/** Effects loaded as soon as sound is unlocked, so the first click or buy is not silent. */
const WARM = ["ui/select", "ui/menu_open", "ui/error", "se/buy", "se/pb_move", "se/hit"];

function loadSettings(): SoundSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<SoundSettings>;
      const vol = (v: unknown, d: number) => (typeof v === "number" && v >= 0 && v <= 1 ? v : d);
      return { bgm: vol(s.bgm, DEFAULTS.bgm), se: vol(s.se, DEFAULTS.se), muted: s.muted === true };
    }
  } catch {
    /* private mode or garbage */
  }
  return { ...DEFAULTS };
}

interface Deck {
  el: HTMLAudioElement;
  gain: GainNode | null;
  key: string | null;
  loop: number | null;
  /** Bumped whenever the deck gets a new track, so a late fade-out timer leaves the new one alone. */
  gen: number;
}

class SoundSystem {
  settings = loadSettings();
  private readonly listeners = new Set<() => void>();
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private seGain: GainNode | null = null;
  private bgmGain: GainNode | null = null;
  private manifest: Promise<AudioManifest | null> | null = null;
  private readonly buffers = new Map<string, Promise<AudioBuffer | null>>();
  private readonly lastPlayed = new Map<string, number>();
  private voices = 0;
  private unlocked = false;
  private decks: [Deck, Deck] | null = null;
  private active: 0 | 1 = 0;
  /** The track the screen wants; plays once sound is unlocked and the page is visible. */
  private wanted: string | null = null;
  private loopTimer = 0;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSettings = () => this.settings;

  update(patch: Partial<SoundSettings>): void {
    this.settings = { ...this.settings, ...patch };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      /* ignore */
    }
    this.applyVolumes();
    for (const fn of this.listeners) fn();
    // Turning music up from zero (or unmuting) starts the wanted track.
    if (this.audible("bgm")) this.startWanted();
  }

  /** Called from the first tap/key (sound may only start inside a user gesture). */
  unlock = (): void => {
    this.ensureContext();
    void this.ctx?.resume().catch(() => undefined);
    if (this.unlocked) return;
    this.unlocked = true;
    const decks = this.ensureDecks();
    // Playing both elements once inside the gesture lets iOS start them later without one.
    for (const d of decks) {
      if (d.key) continue;
      d.el.muted = true;
      d.el.src = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";
      void d.el
        .play()
        .then(() => {
          // A track may already have been put on this deck meanwhile.
          if (!d.key) d.el.pause();
          d.el.muted = false;
        })
        .catch(() => {
          d.el.muted = false;
        });
    }
    for (const k of WARM) void this.buffer(k);
    this.startWanted();
  };

  /** Switches the music (no-op when that track is already playing). null fades the music out. */
  playBgm(key: string | null): void {
    this.wanted = key;
    this.startWanted();
  }

  /** `gap`: ms before the same effect may play again (long ones like stat changes want more). */
  playSe(key: string, opts: { rate?: number; volume?: number; gap?: number } = {}): void {
    if (!this.audible("se") || !this.unlocked) return;
    const now = performance.now();
    if (now - (this.lastPlayed.get(key) ?? -Infinity) < (opts.gap ?? SE_GAP_MS) || this.voices >= MAX_VOICES) return;
    this.lastPlayed.set(key, now);
    void this.buffer(key).then((buf) => {
      const ctx = this.ctx;
      if (!buf || !ctx || !this.seGain || ctx.state !== "running") return;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      if (opts.rate) src.playbackRate.value = opts.rate;
      let out: AudioNode = this.seGain;
      if (opts.volume !== undefined) {
        const g = ctx.createGain();
        g.gain.value = opts.volume;
        g.connect(this.seGain);
        out = g;
      }
      src.connect(out);
      this.voices++;
      src.onended = () => {
        this.voices--;
        src.disconnect();
        if (out !== this.seGain) out.disconnect();
      };
      src.start();
    });
  }

  // ───────────────────────────── internals

  private audible(kind: "bgm" | "se"): boolean {
    return !this.settings.muted && this.settings[kind] > 0;
  }

  private ensureContext(): void {
    if (this.ctx) return;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    try {
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      this.seGain = this.ctx.createGain();
      this.seGain.connect(this.master);
      this.bgmGain = this.ctx.createGain();
      this.bgmGain.connect(this.master);
      this.applyVolumes();
    } catch {
      this.ctx = null;
    }
  }

  private ensureDecks(): [Deck, Deck] {
    if (this.decks) return this.decks;
    const make = (): Deck => {
      const el = new Audio();
      el.preload = "auto";
      let gain: GainNode | null = null;
      if (this.ctx && this.bgmGain) {
        try {
          const node = this.ctx.createMediaElementSource(el);
          gain = this.ctx.createGain();
          gain.gain.value = 0;
          node.connect(gain).connect(this.bgmGain);
        } catch {
          gain = null;
        }
      }
      const deck: Deck = { el, gain, key: null, loop: null, gen: 0 };
      // A track with a loop point jumps back there; one without (a fanfare) just ends.
      el.addEventListener("ended", () => {
        if (deck.loop !== null && deck.key && deck === this.decks?.[this.active]) {
          el.currentTime = deck.loop;
          void el.play().catch(() => undefined);
        }
      });
      return deck;
    };
    this.decks = [make(), make()];
    this.applyVolumes();
    return this.decks;
  }

  private applyVolumes(): void {
    const se = this.settings.muted ? 0 : this.settings.se;
    const bgm = this.settings.muted ? 0 : this.settings.bgm * BGM_SCALE;
    if (this.seGain) this.seGain.gain.value = se;
    if (this.bgmGain) this.bgmGain.gain.value = bgm;
    // Without Web Audio the element volume is the only knob (and fades are skipped).
    for (const d of this.decks ?? []) if (!d.gain) d.el.volume = d.key === this.decks?.[this.active]?.key ? bgm : 0;
    if (this.decks && !this.audible("bgm")) for (const d of this.decks) d.el.pause();
  }

  private loadManifest(): Promise<AudioManifest | null> {
    this.manifest ??= fetch("/assets/audio/manifest.json")
      .then((r) => (r.ok ? (r.json() as Promise<AudioManifest>) : null))
      .catch(() => null);
    return this.manifest;
  }

  private buffer(key: string): Promise<AudioBuffer | null> {
    let p = this.buffers.get(key);
    if (!p) {
      p = this.loadManifest().then(async (m) => {
        const file = m?.se[key]?.file;
        if (!file || !this.ctx) return null;
        try {
          const data = await (await fetch(`/assets/${file}`)).arrayBuffer();
          // Safari's decodeAudioData has only the callback form on older versions.
          return await new Promise<AudioBuffer>((resolve, reject) => this.ctx!.decodeAudioData(data, resolve, reject));
        } catch {
          return null;
        }
      });
      this.buffers.set(key, p);
    }
    return p;
  }

  private fade(deck: Deck, to: number, seconds: number): void {
    if (!deck.gain || !this.ctx) return;
    const g = deck.gain.gain;
    const t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(to, t + seconds);
  }

  private startWanted(): void {
    if (!this.unlocked || document.hidden) return;
    const decks = this.ensureDecks();
    const cur = decks[this.active];
    const key = this.audible("bgm") ? this.wanted : null;
    if (key && cur.key === key) {
      if (cur.el.paused && !(cur.loop === null && cur.el.ended)) void cur.el.play().catch(() => undefined);
      return;
    }
    // Fade out whatever plays now.
    if (cur.key) {
      const gen = cur.gen;
      this.fade(cur, 0, FADE_OUT);
      window.setTimeout(
        () => {
          if (cur.gen !== gen) return;
          cur.el.pause();
          cur.key = null;
        },
        cur.gain ? FADE_OUT * 1000 + 50 : 0,
      );
    }
    if (!key) {
      cur.key = null;
      return;
    }
    void this.loadManifest().then((m) => {
      const track = m?.bgm[key];
      if (!track || this.wanted !== key) return;
      this.active = this.active === 0 ? 1 : 0;
      const deck = decks[this.active];
      deck.gen++;
      deck.key = key;
      deck.loop = track.loop;
      deck.el.muted = false;
      deck.el.loop = track.loop === 0;
      deck.el.src = `/assets/${track.file}`;
      deck.el.currentTime = 0;
      if (deck.gain) {
        deck.gain.gain.cancelScheduledValues(0);
        deck.gain.gain.value = 0;
      } else deck.el.volume = this.settings.muted ? 0 : this.settings.bgm * BGM_SCALE;
      void deck.el.play().catch(() => undefined);
      this.fade(deck, 1, FADE_IN);
      this.watchLoop();
    });
  }

  /** "ended" fires a little late; jumping just before the end keeps the loop tight. */
  private watchLoop(): void {
    if (this.loopTimer) return;
    this.loopTimer = window.setInterval(() => {
      const deck = this.decks?.[this.active];
      if (!deck?.key || deck.loop === null || deck.loop === 0 || deck.el.paused) return;
      const d = deck.el.duration;
      if (Number.isFinite(d) && d > 0 && deck.el.currentTime >= d - 0.06) deck.el.currentTime = deck.loop;
    }, 30);
  }

  /** Music stops while the tab or app is in the background and picks up again on return. */
  onVisibility = (): void => {
    if (!this.decks) return;
    if (document.hidden) {
      for (const d of this.decks) d.el.pause();
      void this.ctx?.suspend().catch(() => undefined);
    } else {
      void this.ctx?.resume().catch(() => undefined);
      const cur = this.decks[this.active];
      if (cur.key && this.audible("bgm") && !(cur.loop === null && cur.el.ended)) void cur.el.play().catch(() => undefined);
      else this.startWanted();
    }
  };
}

export const sound = new SoundSystem();

/**
 * Unlocks sound on the first gesture, and plays "ui/select" for every button click (a button can ask
 * for another effect with data-sfx="se/buy", or for none with data-sfx="none").
 */
export function installSound(): void {
  const unlock = () => sound.unlock();
  window.addEventListener("pointerdown", unlock, { capture: true });
  window.addEventListener("keydown", unlock, { capture: true });
  document.addEventListener("visibilitychange", sound.onVisibility);
  document.addEventListener(
    "click",
    (e) => {
      const el = (e.target as Element | null)?.closest?.("button, [data-sfx]") as HTMLElement | null;
      if (!el || (el as HTMLButtonElement).disabled) return;
      const sfx = el.dataset.sfx ?? "ui/select";
      if (sfx !== "none") sound.playSe(sfx);
    },
    { capture: true },
  );
}

export function useSoundSettings(): SoundSettings {
  return useSyncExternalStore(sound.subscribe, sound.getSettings);
}

/** Plays `key` while the calling screen is shown (null: silence). */
export function useBgm(key: string | null): void {
  useEffect(() => {
    sound.playBgm(key);
  }, [key]);
}
