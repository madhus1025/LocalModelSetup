export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface JsonSchema {
  type: "object";
  properties: Record<string, JsonValue>;
  required?: string[];
  additionalProperties?: boolean;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireString(
  value: Record<string, unknown>,
  key: string
): string {
  const candidate = value[key];
  if (typeof candidate !== "string") {
    throw new TypeError(`Expected "${key}" to be a string.`);
  }
  return candidate;
}

export function optionalString(
  value: Record<string, unknown>,
  key: string
): string | undefined {
  const candidate = value[key];
  if (candidate === undefined) {
    return undefined;
  }
  if (typeof candidate !== "string") {
    throw new TypeError(`Expected "${key}" to be a string when provided.`);
  }
  return candidate;
}

export function optionalNumber(
  value: Record<string, unknown>,
  key: string
): number | undefined {
  const candidate = value[key];
  if (candidate === undefined) {
    return undefined;
  }
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
    throw new TypeError(`Expected "${key}" to be a finite number.`);
  }
  return candidate;
}

export function optionalBoolean(
  value: Record<string, unknown>,
  key: string
): boolean | undefined {
  const candidate = value[key];
  if (candidate === undefined) {
    return undefined;
  }
  if (typeof candidate !== "boolean") {
    throw new TypeError(`Expected "${key}" to be a boolean.`);
  }
  return candidate;
}
