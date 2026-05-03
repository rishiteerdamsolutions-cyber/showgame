/** MP3 cues from `client/public`: CARDSHOW.mp3, SHOW.mp3, WINNER.mp3 */

function publicUrl(filename: string): string {
  const base = import.meta.env.BASE;
  return `${base}${filename}`.replace(/\/{2,}/g, "/");
}

let unlockCtx: AudioContext | null = null;

/** Call after a user gesture (join tap, etc.) so MP3 playback is allowed when events arrive over the socket. */
export async function resumeAudio(): Promise<void> {
  if (typeof AudioContext === "undefined") return;
  if (!unlockCtx) unlockCtx = new AudioContext();
  if (unlockCtx.state !== "running") await unlockCtx.resume();
}

export function announceCardShow(_threeOfAKindName?: string): void {
  const a = new Audio(publicUrl("CARDSHOW.mp3"));
  void a.play().catch(() => {});
}

/** Plays SHOW.mp3, then WINNER.mp3 */
export function announceShow(_winningCardName?: string, _winnerName?: string): void {
  const show = new Audio(publicUrl("SHOW.mp3"));
  show.addEventListener("ended", () => {
    const winner = new Audio(publicUrl("WINNER.mp3"));
    void winner.play().catch(() => {});
  });
  void show.play().catch(() => {
    void new Audio(publicUrl("WINNER.mp3")).play().catch(() => {});
  });
}
