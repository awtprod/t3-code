import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { __resetAlertChimeForTests, playAlertChime } from "./alertChime.ts";

afterEach(() => {
  __resetAlertChimeForTests();
  vi.unstubAllGlobals();
});

describe("playAlertChime", () => {
  it("never throws when window is unavailable (no browser environment)", () => {
    // The test runs in a Node environment, so `window` is already undefined —
    // this exercises the same branch `resolveAudioContextConstructor` takes
    // when there is no browser global at all.
    expect(() => playAlertChime()).not.toThrow();
  });

  it("never throws when window exists but has no AudioContext", () => {
    vi.stubGlobal("window", {});
    expect(() => playAlertChime()).not.toThrow();
  });

  it("creates oscillators and a gain node per note when AudioContext is available", () => {
    const created: Array<{ started: boolean }> = [];
    const oscillatorFactory = () => {
      const state = { started: false };
      created.push(state);
      return {
        type: "sine",
        frequency: { setValueAtTime: vi.fn() },
        connect: vi.fn(),
        start: () => {
          state.started = true;
        },
        stop: vi.fn(),
      };
    };
    const gainFactory = () => ({
      gain: {
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
    });

    class MockAudioContext {
      currentTime = 0;
      state = "running";
      destination = {};
      createOscillator = oscillatorFactory;
      createGain = gainFactory;
      resume = vi.fn(() => Promise.resolve());
    }

    vi.stubGlobal("window", { AudioContext: MockAudioContext });

    playAlertChime();

    expect(created).toHaveLength(2);
    expect(created.every((note) => note.started)).toBe(true);
  });

  it("never throws when AudioContext construction fails", () => {
    class ThrowingAudioContext {
      constructor() {
        throw new Error("no audio device");
      }
    }
    vi.stubGlobal("window", { AudioContext: ThrowingAudioContext });
    expect(() => playAlertChime()).not.toThrow();
  });
});
