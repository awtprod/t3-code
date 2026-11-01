/**
 * In-app alert chime, played whenever the window is unfocused: Do Not Disturb
 * silences the OS notification sound and offers no API to detect that.
 * Synthesized with WebAudio rather than shipping an audio file.
 */

// A soft major sixth (A5 -> F#6). Pleasant, and distinct from system alerts.
const CHIME_NOTES: ReadonlyArray<{ readonly frequency: number; readonly startOffset: number }> = [
  { frequency: 880, startOffset: 0 },
  { frequency: 1174.7, startOffset: 0.085 },
];

const NOTE_DURATION_SECONDS = 0.34;
const PEAK_GAIN = 0.11;

type AudioContextConstructor = new () => AudioContext;

let sharedContext: AudioContext | null = null;

function resolveAudioContextConstructor(): AudioContextConstructor | null {
  if (typeof window === "undefined") {
    return null;
  }
  const candidate =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext;
  return candidate ?? null;
}

// One context for the app's lifetime: browsers cap how many can exist, and
// creating one per chime leaks them.
function getAudioContext(): AudioContext | null {
  if (sharedContext !== null) {
    return sharedContext;
  }
  const Constructor = resolveAudioContextConstructor();
  if (Constructor === null) {
    return null;
  }
  try {
    sharedContext = new Constructor();
    return sharedContext;
  } catch {
    return null;
  }
}

// Never throws: audio is an enhancement, and a blocked or unavailable output
// must not disturb the notification path that calls it.
export function playAlertChime(): void {
  const context = getAudioContext();
  if (context === null) {
    return;
  }

  try {
    // Autoplay policy can leave the context suspended until the page has
    // been interacted with. Resuming is best-effort; the app has invariably
    // been clicked long before an agent finishes a task.
    if (context.state === "suspended") {
      void context.resume().catch(() => undefined);
    }

    const startedAt = context.currentTime;
    for (const note of CHIME_NOTES) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const noteStart = startedAt + note.startOffset;
      const noteEnd = noteStart + NOTE_DURATION_SECONDS;

      // A sine avoids the harsh harmonics that make synthesized alerts grating.
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(note.frequency, noteStart);

      // Quick attack, exponential decay. Ramping to a small non-zero value
      // because exponentialRampToValueAtTime cannot reach exactly zero, then
      // cutting to silence so the note ends cleanly instead of clicking.
      gain.gain.setValueAtTime(0.0001, noteStart);
      gain.gain.exponentialRampToValueAtTime(PEAK_GAIN, noteStart + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, noteEnd);
      gain.gain.setValueAtTime(0, noteEnd);

      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(noteStart);
      oscillator.stop(noteEnd + 0.02);
    }
  } catch {
    // Output device removed mid-play, context closed by the platform, etc.
  }
}

// Test-only: drops the shared context so specs start from a clean slate.
export function __resetAlertChimeForTests(): void {
  sharedContext = null;
}
