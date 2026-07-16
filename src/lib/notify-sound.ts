// Short synthesized "ping" for new unread messages — deliberately not
// a bundled audio file (no licensing, no asset weight). Web Audio API
// only; a no-op on the server or before any user gesture has unlocked
// audio in the browser (autoplay policy) — callers don't need to
// handle either case themselves.

let sharedContext: AudioContext | null = null;

export function playUnreadPing(): void {
  if (typeof window === "undefined") return;

  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = (sharedContext ??= new Ctx());

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;

    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.15, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.15);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.15);
  } catch {
    // Autoplay-blocked or unsupported — silently skip, never surface
    // an error for a non-essential notification sound.
  }
}
