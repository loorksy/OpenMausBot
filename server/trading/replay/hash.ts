import { createHash } from "node:crypto";

/** Canonical JSON: object keys are sorted, array order is preserved.
 * Replay identity uses this so key insertion order cannot change a hash. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function contentHash(value: unknown): string {
  return sha256(canonicalJson(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const child = source[key];
      if (child !== undefined) sorted[key] = sortValue(child);
    }
    return sorted;
  }
  return value;
}
