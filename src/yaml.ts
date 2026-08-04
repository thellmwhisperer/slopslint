/**
 * Strict YAML reading shared by every config surface.
 *
 * Two conditions a permissive loader accepts silently are rejected here,
 * because both let one document mean two things:
 *
 *   * a repeated mapping key (`id:` twice) — a permissive loader keeps the last
 *     value, so a record could shadow itself and a reviewer would read the
 *     other one;
 *   * a non-scalar mapping key (`? [a, b]: v`) — stringified by the JS object
 *     conversion, so two structurally different keys can collide.
 *
 * Callers translate {@link YamlError} into their own fail-closed error type.
 */
import { isScalar, parseDocument, visit } from "yaml";

/** Raised for unparseable, ambiguous, or non-scalar-keyed YAML. */
export class YamlError extends Error {
  override readonly name = "YamlError";
}

/**
 * Parse YAML with duplicate-key and complex-key detection.
 *
 * Returns the plain-JS value (`undefined` for an empty document).
 */
export function parseYamlStrict(text: string): unknown {
  const doc = parseDocument(text, { uniqueKeys: true });
  const failure = doc.errors[0];
  if (failure) {
    const detail = failure.message.split("\n")[0] ?? failure.message;
    if (failure.code === "DUPLICATE_KEY") {
      throw new YamlError(`duplicate key in mapping: ${detail}`);
    }
    throw new YamlError(`invalid YAML: ${detail}`);
  }
  visit(doc, {
    Pair(_key, pair) {
      if (!isScalar(pair.key)) {
        throw new YamlError(
          "unhashable mapping key: only scalar keys are supported, got a collection key",
        );
      }
    },
  });
  return doc.toJS();
}

/** True when `value` is a plain object usable as a YAML mapping. */
export function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
