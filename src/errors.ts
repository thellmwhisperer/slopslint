/**
 * Fail-closed error types.
 *
 * Every malformed, ambiguous, or unverifiable condition in this engine raises
 * one of these instead of degrading into a partial result. A gate that cannot
 * prove what it measured must refuse to pass, never guess.
 */

/** Raised for every fail-closed condition in the scan/canonical/ceiling path. */
export class SlopslintError extends Error {
  override readonly name = "SlopslintError";
}

/** Raised for every malformed-record condition in the tombstone loader. */
export class TombstoneConfigError extends Error {
  override readonly name = "TombstoneConfigError";
}

/** Throw {@link SlopslintError} unless `condition` holds. */
export function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new SlopslintError(message);
  }
}

/** Throw {@link TombstoneConfigError} unless `condition` holds. */
export function ensureRecord(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new TombstoneConfigError(message);
  }
}

/**
 * Return `value` when it is a genuine integer, else fail closed.
 *
 * Booleans and non-integral numbers are rejected: a gate's counters are exact
 * integers, and a silently coerced `true`/`36.5` would corrupt every threshold
 * derived from them.
 */
export function asInteger(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new SlopslintError(`${what} must be an integer`);
  }
  return value;
}
