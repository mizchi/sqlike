import { aotBindings, aotValue } from "./aot-values.ts";
import type { Value } from "./contract.ts";
import type { DrizzleConstantCell, DrizzleParameterCodec } from "./drizzle-defined-contract.ts";

export function drizzleValue(value: unknown): Value {
  if (value === null || typeof value === "string" || typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Uint8Array) return value.slice();
  throw TypeError("unsupported Drizzle binding value");
}
export function drizzleConstant(value: unknown): DrizzleConstantCell {
  const typed = drizzleValue(value);
  if (typeof typed === "number" && Object.is(typed, -0)) return { t: "real", v: "-0" };
  return (JSON.parse(aotBindings([typed])) as DrizzleConstantCell[])[0]!;
}
export function decodeDrizzleConstant(cell: DrizzleConstantCell): Value {
  const value = aotValue(cell);
  if (JSON.stringify(drizzleConstant(value)) !== JSON.stringify(cell))
    throw Error("invalid Drizzle binding constant");
  return value;
}
export function encodeDrizzlePlaceholder(codec: DrizzleParameterCodec, value: unknown): Value {
  switch (codec) {
    case "value":
      return drizzleValue(value);
    case "boolean":
      if (typeof value !== "boolean")
        throw TypeError("Drizzle boolean placeholder requires boolean");
      return value ? 1 : 0;
    case "timestamp":
    case "timestamp_ms": {
      if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
        throw TypeError("invalid Drizzle date placeholder");
      return codec === "timestamp" ? Math.floor(value.getTime() / 1000) : value.getTime();
    }
    case "json": {
      const text = JSON.stringify(value);
      if (text === undefined) throw TypeError("invalid Drizzle JSON placeholder");
      return text;
    }
    default:
      throw TypeError("unknown Drizzle placeholder codec");
  }
}
