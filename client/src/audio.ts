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

/** HTMLAudio unlock must happen in a user gesture; we record success here. */
let audioUnlocked = false;
let unlockInFlight: Promise<void> | null = null;

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

async function resumeWebAudio(): Promise<void> {
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return;
  try {
    const ctx = new AC();
    await ctx.resume();
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    g.gain.value = 0;
    osc.connect(g);
    g.connect(ctx.destination);
    const t0 = ctx.currentTime;
    osc.start(t0);
    osc.stop(t0 + 0.02);
    await ctx.close();
  } catch {
    /* ignore */
  }
}

/**
 * Unlocks HTMLAudio + WebAudio after a user gesture. Safe to call repeatedly; resolves immediately once unlocked.
 */
export async function ensureAudioUnlocked(): Promise<void> {
  if (typeof window === "undefined") return;
  if (audioUnlocked) return;
  if (unlockInFlight) return unlockInFlight;

  unlockInFlight = (async () => {
    await resumeWebAudio();

    const silent = new Audio(SILENT_WAV);
    silent.playsInline = true;
    silent.volume = 0.0001;
    try {
      await silent.play();
      silent.pause();
      silent.removeAttribute("src");
      silent.load();
      audioUnlocked = true;
    } catch {
      /* Next user gesture can retry */
    }

    if (audioUnlocked) {
      startBackgroundMusic();
    }
  })().finally(() => {
    unlockInFlight = null;
  });

  return unlockInFlight;
}

/** Fire-and-forget unlock (use inside click handlers). */
export function primeAudioPlayback(): void {
  void ensureAudioUnlocked();
}

export async function resumeAudio(): Promise<void> {
  await ensureAudioUnlocked();
}

function playMp3(filename: string): void {
  if (getEffectiveSoundLevel() <= 0) return;
  const a = new Audio(publicUrl(filename));
  a.playsInline = true;
  a.preload = "auto";
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
  void ensureAudioUnlocked().then(() => playMp3("CARDPASSSOUND.mp3"));
}

export function announceCardShow(_threeOfAKindName?: string): void {
  void _threeOfAKindName;
}

const SHOW_CELEBRATION_MIN_MS = 5000;

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Load and play one MP3 to completion. Uses loadedmetadata + play for broad browser support.
 */
function playOneMp3ToEnd(filename: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const eff = getEffectiveSoundLevel();
    if (eff <= 0) {
      resolve();
      return;
    }

    const a = new Audio();
    a.preload = "auto";
    a.playsInline = true;
    a.src = publicUrl(filename);

    const finishOk = () => {
      a.removeEventListener("ended", onEnded);
      a.removeEventListener("error", onErr);
      resolve();
    };

    const finishBad = () => {
      a.removeEventListener("ended", onEnded);
      a.removeEventListener("error", onErr);
      reject(new Error(`audio: ${filename}`));
    };

    const onEnded = () => finishOk();
    const onErr = () => finishBad();

    a.addEventListener("ended", onEnded);
    a.addEventListener("error", onErr);

    let started = false;
    const startOnce = () => {
      if (started) return;
      started = true;
      applyOutputVolume(a);
      void a.play().catch(() => finishBad());
    };

    a.addEventListener("canplay", () => startOnce(), { once: true });
    a.load();
    /* Cached assets sometimes skip `canplay` until after sync load. */
    queueMicrotask(() => {
      if (a.readyState >= 2) startOnce();
    });
  });
}

/**
 * Plays SHOW.mp3 then WINNER.mp3. Resolves when WINNER ends (or both fail after unlock attempt).
 */
export async function announceShow(_winningCardName?: string, _winnerName?: string): Promise<void> {
  void _winningCardName;
  void _winnerName;

  const eff = getEffectiveSoundLevel();
  if (eff <= 0) {
    await delay(SHOW_CELEBRATION_MIN_MS);
    return;
  }

  await ensureAudioUnlocked();

  try {
    await playOneMp3ToEnd("SHOW.mp3");
  } catch (e) {
    if (import.meta.env.DEV) console.warn("[audio] SHOW", e);
  }

  try {
    await playOneMp3ToEnd("WINNER.mp3");
  } catch (e) {
    if (import.meta.env.DEV) console.warn("[audio] WINNER", e);
  }
}

/** Wait until celebration audio finishes, keeping overlay at least `SHOW_CELEBRATION_MIN_MS`. */
export async function waitForShowCelebration(announcePromise: Promise<void>): Promise<void> {
  const t0 = Date.now();
  await announcePromise;
  const elapsed = Date.now() - t0;
  const pad = Math.max(0, SHOW_CELEBRATION_MIN_MS - elapsed);
  if (pad > 0) await delay(pad);
}
