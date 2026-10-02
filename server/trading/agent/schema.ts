import { TradingDomainError } from "../../../shared/trading/errors.ts";

/** JSON schema fragment advertised to the model and enforced before a
 * trading handler runs. Only the keywords this checker understands are used. */
export interface ToolJsonSchema {
  readonly type: "object" | "string" | "number" | "integer" | "boolean" | "array";
  readonly description?: string;
  readonly properties?: Readonly<Record<string, ToolJsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: false;
  readonly enum?: readonly (string | number)[];
  readonly items?: ToolJsonSchema;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
}

function fail(path: string, message: string): never {
  throw new TradingDomainError("tool_rejected", `${path}: ${message}`);
}

/** Reject a tool payload that does not match the advertised schema.
 * Unknown fields fail closed. Nothing is coerced. */
export function assertToolSchema(schema: ToolJsonSchema, value: unknown, path = "arguments"): void {
  if (schema.enum && !schema.enum.some((item) => item === value)) {
    fail(path, "value is outside the advertised set");
  }
  switch (schema.type) {
    case "string":
      if (typeof value !== "string") fail(path, "expected a string");
      if (schema.minLength !== undefined && value.length < schema.minLength) fail(path, "is too short");
      if (schema.maxLength !== undefined && value.length > schema.maxLength) fail(path, "is too long");
      return;
    case "number":
    case "integer":
      if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "expected a finite number");
      if (schema.type === "integer" && !Number.isInteger(value)) fail(path, "expected an integer");
      if (schema.minimum !== undefined && value < schema.minimum) fail(path, "is below the minimum");
      if (schema.maximum !== undefined && value > schema.maximum) fail(path, "is above the maximum");
      return;
    case "boolean":
      if (typeof value !== "boolean") fail(path, "expected a boolean");
      return;
    case "array":
      if (!Array.isArray(value)) fail(path, "expected an array");
      if (schema.minItems !== undefined && value.length < schema.minItems) fail(path, "has too few items");
      if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(path, "has too many items");
      if (schema.items) value.forEach((item, index) => assertToolSchema(schema.items!, item, `${path}.${index}`));
      return;
    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) fail(path, "expected an object");
      const record = value as Record<string, unknown>;
      const properties = schema.properties ?? {};
      for (const key of schema.required ?? []) {
        if (record[key] === undefined) fail(path, `missing ${key}`);
      }
      for (const key of Object.keys(record)) {
        const child = properties[key];
        if (!child) {
          if (schema.additionalProperties === false) fail(path, `unsupported field ${key}`);
          continue;
        }
        assertToolSchema(child, record[key], `${path}.${key}`);
      }
      return;
    }
    default:
      fail(path, "schema is unsupported");
  }
}
