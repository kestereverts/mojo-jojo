import type { LogLevel } from "../config/schema.ts";

/** Minimal structured logger. Levels: debug < info < warn < error < silent. */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  /** A child logger whose scope is appended (`parent:child`), reused for prefixing. */
  child(scope: string): Logger;
}

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/** The console-like methods a {@link ConsoleLogger} writes to (injectable for tests). */
export type LogSink = Pick<Console, "debug" | "info" | "warn" | "error">;

export interface ConsoleLoggerOptions {
  readonly level?: LogLevel;
  readonly scope?: string;
  readonly sink?: LogSink;
}

/** A {@link Logger} that writes level-prefixed lines to a console-like sink. */
export class ConsoleLogger implements Logger {
  readonly #level: LogLevel;
  readonly #scope: string;
  readonly #sink: LogSink;

  constructor(options: ConsoleLoggerOptions = {}) {
    this.#level = options.level ?? "info";
    this.#scope = options.scope ?? "";
    this.#sink = options.sink ?? console;
  }

  debug(message: string, ...args: unknown[]): void {
    this.#write("debug", message, args);
  }
  info(message: string, ...args: unknown[]): void {
    this.#write("info", message, args);
  }
  warn(message: string, ...args: unknown[]): void {
    this.#write("warn", message, args);
  }
  error(message: string, ...args: unknown[]): void {
    this.#write("error", message, args);
  }

  child(scope: string): Logger {
    return new ConsoleLogger({
      level: this.#level,
      scope: this.#scope ? `${this.#scope}:${scope}` : scope,
      sink: this.#sink,
    });
  }

  #write(level: Exclude<LogLevel, "silent">, message: string, args: readonly unknown[]): void {
    if (RANK[level] < RANK[this.#level]) return;
    const line = this.#scope ? `[${this.#scope}] ${message}` : message;
    this.#sink[level](line, ...args);
  }
}
