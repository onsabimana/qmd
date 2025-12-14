/**
 * Structured logging and output handling
 *
 * Separates concerns:
 * - data(): Primary command output to stdout (for piping)
 * - info/success/warn/error(): User messages to stderr
 */

import { colors as c } from "./terminal";

interface Logger {
  /** Write primary data output to stdout (pipeable) */
  data(content: string): void;

  /** Write informational message to stderr */
  info(message: string): void;

  /** Write success message to stderr (with green checkmark) */
  success(message: string): void;

  /** Write error message to stderr (with red prefix) */
  error(message: string): void;

  /** Write warning message to stderr (with yellow prefix) */
  warn(message: string): void;

  /** Write dim/muted message to stderr */
  dim(message: string): void;
}

export class ConsoleLogger implements Logger {
  data(content: string): void {
    process.stdout.write(`${content}\n`);
  }

  info(message: string): void {
    process.stderr.write(`${message}\n`);
  }

  success(message: string): void {
    process.stderr.write(`${c.green}✓${c.reset} ${message}\n`);
  }

  error(message: string): void {
    process.stderr.write(`${c.red}Error:${c.reset} ${message}\n`);
  }

  warn(message: string): void {
    process.stderr.write(`${c.yellow}⚠${c.reset} ${message}\n`);
  }

  dim(message: string): void {
    process.stderr.write(`${c.dim}${message}${c.reset}\n`);
  }
}

/**
 * JSON output mode - only data goes to stdout, errors to stderr
 * All other messages are suppressed for clean JSON piping
 */
export class JsonLogger implements Logger {
  data(content: string): void {
    process.stdout.write(`${content}\n`);
  }

  info(): void {
    // Silent in JSON mode
  }

  success(): void {
    // Silent in JSON mode
  }

  error(message: string): void {
    process.stderr.write(JSON.stringify({ error: message }) + "\n");
  }

  warn(): void {
    // Silent in JSON mode
  }

  dim(): void {
    // Silent in JSON mode
  }
}

/**
 * Default logger instance
 * Can be replaced with JsonLogger for structured output
 */
export const logger = new ConsoleLogger();
