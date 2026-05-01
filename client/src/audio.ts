/** Tiny WebAudio cues — zero external mp3 downloads. */

let ctxRef: AudioContext | null = null;

function ctx(): AudioContext | null {
  if (typeof AudioContext === "undefined") return null;
  if (!ctxRef) ctxRef = new AudioContext();
  return ctxRef;
}

function beep(freq: number, dur: number, type: OscillatorType = "sine", gain = 0.06): void {
  const ac = ctx();
  if (!ac) return;
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.value = gain;
  o.connect(g);
  g.connect(ac.destination);
  const t0 = ac.currentTime;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.start(t0);
  o.stop(t0 + dur + 0.03);
}

export function playCardShow(): void {
  beep(880, 0.08);
  window.setTimeout(() => beep(1320, 0.075, "triangle"), 70);
}

export function playShow(): void {
  const ac = ctx();
  if (!ac) return;
  [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => window.setTimeout(() => beep(f, 0.15, "triangle", 0.09), i * 115));
}

export async function resumeAudio(): Promise<void> {
  const c = ctx();
  if (!c || c.state === "running") return;
  await c.resume();
}
