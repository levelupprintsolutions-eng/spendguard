export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function asFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Non-negative finite number, or undefined when the field is absent or unusable. */
export function asCount(value: unknown): number | undefined {
  const n = asFinite(value);
  if (n === undefined || n < 0) return undefined;
  return n;
}
