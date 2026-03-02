/**
 * DEC mode 2026 — Synchronized Output.
 *
 * Wraps process.stdout.write so every write is bracketed by
 * Begin Synchronized Update / End Synchronized Update escape sequences.
 * The terminal buffers all output between these markers and paints
 * atomically, eliminating visible flicker during re-renders.
 *
 * Supported by: iTerm2, Kitty, WezTerm, Ghostty, foot, Contour.
 * Ignored (harmless no-op) on terminals that don't support it.
 */

const BEGIN = "\x1b[?2026h";
const END = "\x1b[?2026l";

export const enableSyncOutput = (): (() => void) => {
  const original = process.stdout.write.bind(process.stdout);

  process.stdout.write = ((...args: unknown[]): boolean => {
    original(BEGIN);
    const result = (original as (...a: unknown[]) => boolean)(...args);
    original(END);
    return result;
  }) as typeof process.stdout.write;

  return () => {
    process.stdout.write = original;
  };
};
