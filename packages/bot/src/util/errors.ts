/** Coerce an unknown thrown value into an `Error` (preserving a real Error). */
export function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** The message of an unknown thrown value, without wrapping it in an Error. */
export function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
