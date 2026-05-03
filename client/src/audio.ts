/** MP3 cues from `client/public`: CARDSHOW.mp3, SHOW.mp3, WINNER.mp3 */

const LS_VOL = "showgame:vol";
const LS_MUTE = "showgame:mute";

export const SOUND_SETTINGS_EVENT = "showgame-sound";

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

/** Volume slider value 0–1 (ignored while muted). */
export function getSoundVolume(): number {
  return readVol();
}

export function getSoundMuted(): boolean {
  return readMute();
}

/** Effective output 0–1 applied to HTMLAudioElement. */
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

/** Minimal silent WAV (Chrome/Safari decode reliably). */
const SILENT_WAV =
  "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";

let primed = false;
let priming = false;

/**
 * Must run during a user gesture (tap/click). Socket-driven playback is blocked otherwise.
 */
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

      for (const file of ["CARDSHOW.mp3", "SHOW.mp3", "WINNER.mp3"]) {
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

export function announceCardShow(_threeOfAKindName?: string): void {
  playMp3("CARDSHOW.mp3");
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
