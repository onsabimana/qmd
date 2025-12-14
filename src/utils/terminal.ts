/**
 * Terminal utilities - colors, progress bars, cursor control
 */

// Terminal colors (respects NO_COLOR env)
const useColor = !process.env.NO_COLOR && process.stdout.isTTY;

export const colors = {
  reset: useColor ? "\x1b[0m" : "",
  dim: useColor ? "\x1b[2m" : "",
  bold: useColor ? "\x1b[1m" : "",
  cyan: useColor ? "\x1b[36m" : "",
  yellow: useColor ? "\x1b[33m" : "",
  green: useColor ? "\x1b[32m" : "",
  magenta: useColor ? "\x1b[35m" : "",
  blue: useColor ? "\x1b[34m" : "",
  red: useColor ? "\x1b[31m" : "",
};

// Terminal cursor control
export const cursor = {
  hide() {
    process.stderr.write("\x1b[?25l");
  },
  show() {
    process.stderr.write("\x1b[?25h");
  },
};

// Terminal progress bar using OSC 9;4 escape sequence
export const progress = {
  set(percent: number) {
    process.stderr.write(`\x1b]9;4;1;${Math.round(percent)}\x07`);
  },
  clear() {
    process.stderr.write(`\x1b]9;4;0\x07`);
  },
  indeterminate() {
    process.stderr.write(`\x1b]9;4;3\x07`);
  },
  error() {
    process.stderr.write(`\x1b]9;4;2\x07`);
  },
};

/**
 * Render a progress bar as a string
 */
export function renderProgressBar(percent: number, width: number = 30): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  return bar;
}

/**
 * Format a score with color based on value
 */
export function formatScore(score: number): string {
  const pct = (score * 100).toFixed(0).padStart(3);
  if (!useColor) return `${pct}%`;
  if (score >= 0.7) return `${colors.green}${pct}%${colors.reset}`;
  if (score >= 0.4) return `${colors.yellow}${pct}%${colors.reset}`;
  return `${colors.dim}${pct}%${colors.reset}`;
}

/**
 * Highlight query terms in text (skip short words < 3 chars)
 */
export function highlightTerms(text: string, query: string): string {
  if (!useColor) return text;
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 3);
  let result = text;
  for (const term of terms) {
    const regex = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
    result = result.replace(regex, `${colors.yellow}${colors.bold}$1${colors.reset}`);
  }
  return result;
}
