/** The script runtime exposes a console for diagnostics; it is not a DOM one. */
declare const console: {
  log(...data: unknown[]): void;
  warn(...data: unknown[]): void;
  error(...data: unknown[]): void;
};
