// ── FlowRadar Neo event sound engine (client-safe, zero assets) ──
// Tiny WebAudio synthesizer: every engine event gets a distinct voice.
// Context is created lazily and primed by a user gesture (sound toggle).

let ctx: AudioContext | null = null;
let master: GainNode | null = null;

/** Operator volume 0..1 (persisted in nexus-alerts). Master gain = vol × 0.32. */
let volume = 0.5;

export function setMasterVolume(v: number): void {
  volume = Math.max(0, Math.min(1, v));
  if (master) master.gain.value = volume * 0.32;
}

function ensureCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  if (!ctx) {
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = volume * 0.32;
    master.connect(ctx.destination);
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

/** Call from a user gesture (e.g. enabling sounds) to unlock audio playback. */
export function primeAudio(): void {
  const c = ensureCtx();
  if (!c || c.state !== "running") return;
  // 40ms silent buffer — marks the context as "gesture unlocked" on Safari.
  const buf = c.createBuffer(1, Math.ceil(c.sampleRate * 0.04), c.sampleRate);
  const src = c.createBufferSource();
  src.buffer = buf;
  src.connect(master!);
  src.start();
}

interface ToneOpts {
  freq: number;
  dur?: number;
  delay?: number;
  type?: OscillatorType;
  vol?: number;
  slideTo?: number;
}

function tone({ freq, dur = 0.09, delay = 0, type = "sine", vol = 1, slideTo }: ToneOpts): void {
  const c = ctx;
  const m = master;
  if (!c || !m || c.state !== "running") return;
  const t0 = c.currentTime + delay;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(40, slideTo), t0 + dur);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain);
  gain.connect(m);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

/**
 * Play the signature sound for an engine event type.
 * No-ops when the context is locked (no gesture yet) — sounds are
 * best-effort garnish, never a blocker.
 */
export function playEventSound(eventType: string): void {
  if (!ctx || ctx.state !== "running") return;
  switch (eventType) {
    case "CREATED":
      // violet double-blip: deployment chirp
      tone({ freq: 620, type: "square", vol: 0.5, dur: 0.06 });
      tone({ freq: 880, type: "square", vol: 0.5, dur: 0.08, delay: 0.08 });
      break;
    case "TP1":
      tone({ freq: 740, vol: 0.6, dur: 0.09 });
      tone({ freq: 988, vol: 0.6, dur: 0.12, delay: 0.09 });
      break;
    case "TP2":
      tone({ freq: 830, vol: 0.6, dur: 0.09 });
      tone({ freq: 1108, vol: 0.6, dur: 0.12, delay: 0.09 });
      break;
    case "TP3":
      // full-target arpeggio
      tone({ freq: 659, vol: 0.55, dur: 0.08 });
      tone({ freq: 830, vol: 0.55, dur: 0.08, delay: 0.08 });
      tone({ freq: 1174, vol: 0.6, dur: 0.16, delay: 0.16 });
      break;
    case "SL":
      // descending stop-out buzz
      tone({ freq: 240, slideTo: 96, type: "sawtooth", vol: 0.5, dur: 0.22 });
      break;
    case "TTL_EXPIRED":
      tone({ freq: 440, vol: 0.4, dur: 0.07 });
      tone({ freq: 440, vol: 0.35, dur: 0.07, delay: 0.12 });
      break;
    case "TTL_EXTENDED":
      // v6.1.1: rising gate-grant blip — the mirror of the expiry double-beep
      tone({ freq: 523, vol: 0.4, dur: 0.07 });
      tone({ freq: 784, vol: 0.4, dur: 0.1, delay: 0.09 });
      break;
    case "AFTERLIFE":
      // v6.1: soft cyan follow-up blip — post-expiry TP/SL report
      tone({ freq: 520, vol: 0.35, dur: 0.06 });
      tone({ freq: 780, vol: 0.4, dur: 0.09, delay: 0.08 });
      break;
    default:
      break;
  }
}

/** Short confirmation chirp when the operator toggles sound ON. */
export function playConfirmChirp(): void {
  if (!ensureCtx()) return;
  tone({ freq: 523, vol: 0.5, dur: 0.06 });
  tone({ freq: 1046, vol: 0.5, dur: 0.1, delay: 0.07 });
}

/**
 * TTL escalation blip — fires when a live position enters its final 60s.
 * Three quick amber pulses, more insistent than the CREATED chirp.
 */
export function playTtlUrgency(): void {
  if (!ctx || ctx.state !== "running") return;
  tone({ freq: 784, type: "triangle", vol: 0.55, dur: 0.07 });
  tone({ freq: 784, type: "triangle", vol: 0.5, dur: 0.07, delay: 0.11 });
  tone({ freq: 1040, type: "triangle", vol: 0.6, dur: 0.14, delay: 0.22 });
}

/**
 * TTL warning ping — softer tier, fires at T-5min (heads-up before the
 * critical 60s escalation). Two low amber pulses, clearly calmer than
 * playTtlUrgency so the operator can hear the difference with eyes off-screen.
 */
export function playTtlWarning(): void {
  if (!ctx || ctx.state !== "running") return;
  tone({ freq: 520, type: "sine", vol: 0.45, dur: 0.08 });
  tone({ freq: 520, type: "sine", vol: 0.38, dur: 0.1, delay: 0.16 });
}
