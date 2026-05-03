/** Game audio: MP3s live in `client/public/` */

const LS_VOL = "showgame:vol";
const LS_MUTE = "showgame:mute";

export const SOUND_SETTINGS_EVENT = "showgame-sound";

/** Background music is mixed at 50% of the master level (see syncBackgroundMusic). */
export const BGM_LEVEL = 0.5;

function readVol(): number {
  if (typeof window === "undefined") return 0.9;
  const v = window.localStorage.getItem(LS_VOL);
  if (v == null) return 0.9;
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.9;
}

function readMute(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(LS_MUTE) === "1";
}

export function getSoundVolume(): number {
  return readVol();
}

export function getSoundMuted(): boolean {
  return readMute();
}

export function getEffectiveSoundLevel(): number {
  if (readMute()) return 0;
  return readVol();
}

export function setSoundVolume(v: number): void {
  const x = Math.min(1, Math.max(0, v));
  window.localStorage.setItem(LS_VOL, String(x));
  window.dispatchEvent(new Event(SOUND_SETTINGS_EVENT));
}

export function setSoundMuted(m: boolean): void {
  window.localStorage.setItem(LS_MUTE, m ? "1" : "0");
  window.dispatchEvent(new Event(SOUND_SETTINGS_EVENT));
}

function applyOutputVolume(a: HTMLAudioElement): void {
  a.volume = getEffectiveSoundLevel();
}

function publicUrl(filename: string): string {
  const base = import.meta.env.BASE ?? "/";
  const path = `${base}${filename}`.replace(/\/{2,}/g, "/");
  if (typeof window !== "undefined" && path.startsWith("/")) {
    return `${window.location.origin}${path}`;
  }
  return path;
}

const SILENT_WAV =
  "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";

let primed = false;
let priming = false;

/** Looping background music element */
let bgmEl: HTMLAudioElement | null = null;

export function syncBackgroundMusic(): void {
  if (!bgmEl) return;
  bgmEl.volume = getEffectiveSoundLevel() * BGM_LEVEL;
}

export function startBackgroundMusic(): void {
  if (typeof window === "undefined") return;
  const eff = getEffectiveSoundLevel();
  if (!bgmEl) {
    bgmEl = new Audio(publicUrl("showgamebgmusic.mp3"));
    bgmEl.loop = true;
    bgmEl.playsInline = true;
    bgmEl.preload = "auto";
  }
  syncBackgroundMusic();
  if (eff <= 0) {
    bgmEl.pause();
    return;
  }
  void bgmEl.play().catch((err) => {
    if (import.meta.env.DEV) console.warn("[audio] bgm", err);
  });
}

export function stopBackgroundMusic(): void {
  if (!bgmEl) return;
  bgmEl.pause();
  bgmEl.currentTime = 0;
}

if (typeof window !== "undefined") {
  window.addEventListener(SOUND_SETTINGS_EVENT, () => syncBackgroundMusic());
}

export function primeAudioPlayback(): void {
  if (typeof window === "undefined" || primed || priming) return;
  priming = true;

  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (AC) {
    try {
      const ctx = new AC();
      void ctx.resume();
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      g.gain.value = 0;
      osc.connect(g);
      g.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.02);
      void ctx.close();
    } catch {
      /* ignore */
    }
  }

  const silent = new Audio(SILENT_WAV);
  applyOutputVolume(silent);
  if (silent.volume === 0) silent.volume = 0.01;
  void silent
    .play()
    .then(() => {
      silent.pause();
      silent.src = "";
      silent.load();

      const warmFiles = [
        "SHOW.mp3",
        "WINNER.mp3",
        "CARDPASSSOUND.mp3",
        "COUNTDOWN.mp3",
        "showgamebgmusic.mp3",
      ];
      for (const file of warmFiles) {
        const w = new Audio(publicUrl(file));
        w.playsInline = true;
        const eff = getEffectiveSoundLevel();
        w.volume = eff > 0 ? Math.max(0.001, eff * 0.001) : 0;
        void w
          .play()
          .then(() => {
            w.pause();
            w.currentTime = 0;
            applyOutputVolume(w);
          })
          .catch(() => {});
      }

      primed = true;
      priming = false;
      startBackgroundMusic();
    })
    .catch(() => {
      priming = false;
    });
}

export async function resumeAudio(): Promise<void> {
  primeAudioPlayback();
}

function playMp3(filename: string): void {
  if (getEffectiveSoundLevel() <= 0) return;
  const a = new Audio(publicUrl(filename));
  a.playsInline = true;
  applyOutputVolume(a);
  void a.play().catch((err) => {
    if (import.meta.env.DEV) console.warn("[audio]", filename, err);
  });
}

/** Short tick when a countdown second rolls (pass timer / lobby). Uses COUNTDOWN.mp3 or a beep fallback. */
export function playCountdownTick(): void {
  const eff = getEffectiveSoundLevel();
  if (eff <= 0) return;
  const a = new Audio(publicUrl("COUNTDOWN.mp3"));
  a.playsInline = true;
  a.volume = eff;
  void a.play().catch(() => playCountdownBeep(eff));
}

function playCountdownBeep(level: number): void {
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    void ctx.resume();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.value = 880;
    g.gain.value = level * 0.08;
    o.connect(g);
    g.connect(ctx.destination);
    const t0 = ctx.currentTime;
    o.start(t0);
    o.stop(t0 + 0.06);
    window.setTimeout(() => void ctx.close(), 120);
  } catch {
    /* ignore */
  }
}

export function playCardPassSound(): void {
  playMp3("CARDPASSSOUND.mp3");
}

/** Disabled — re-enable when bringing CARD SHOW overlay + CARDSHOW.mp3 back. */
export function announceCardShow(_threeOfAKindName?: string): void {
  void _threeOfAKindName;
}

export function announceShow(_winningCardName?: string, _winnerName?: string): void {
  if (getEffectiveSoundLevel() <= 0) return;
  const show = new Audio(publicUrl("SHOW.mp3"));
  show.playsInline = true;
  applyOutputVolume(show);
  show.addEventListener("ended", () => {
    if (getEffectiveSoundLevel() <= 0) return;
    const winner = new Audio(publicUrl("WINNER.mp3"));
    winner.playsInline = true;
    applyOutputVolume(winner);
    void winner.play().catch((err) => {
      if (import.meta.env.DEV) console.warn("[audio] WINNER", err);
    });
  });
  void show.play().catch((err) => {
    if (import.meta.env.DEV) console.warn("[audio] SHOW", err);
    playMp3("WINNER.mp3");
  });
}
