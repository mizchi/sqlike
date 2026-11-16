import { createHash } from "node:crypto";
import { Column, Param, Placeholder, is, noopEncoder } from "drizzle-orm";
import { SQLiteBoolean, SQLiteTimestamp, SQLiteTextJson } from "drizzle-orm/sqlite-core";
import { buildDefinedCatalog } from "./defined-compiler.ts";
import { drizzleConstant } from "../src/drizzle-defined-values.ts";
import type {
  CompiledDrizzleCatalog,
  DrizzleParameter,
  DrizzleParameterCodec,
} from "../src/drizzle-defined-contract.ts";

export interface DrizzleQuerySource {
  readonly name: string;
  readonly query: { toSQL(): { sql: string; params: unknown[] } };
}
function encoderCodec(encoder: Param["encoder"]): DrizzleParameterCodec {
  if (encoder === noopEncoder) return "value";
  if (is(encoder, Column)) {
    const standard =
      encoder.columnType === "SQLiteBoolean"
        ? SQLiteBoolean.prototype.mapToDriverValue
        : encoder.columnType === "SQLiteTimestamp"
          ? SQLiteTimestamp.prototype.mapToDriverValue
          : encoder.columnType === "SQLiteTextJson"
            ? SQLiteTextJson.prototype.mapToDriverValue
            : Column.prototype.mapToDriverValue;
    if (encoder.mapToDriverValue !== standard) {
      throw TypeError("unsupported Drizzle placeholder encoder override");
    }
    switch (encoder.columnType) {
      case "SQLiteInteger":
      case "SQLiteReal":
      case "SQLiteText":
      case "SQLiteNumeric":
        return "value";
      case "SQLiteBoolean":
        return "boolean";
      case "SQLiteTextJson":
        return "json";
      case "SQLiteTimestamp": {
        const mode = (encoder as Column & { mode?: string }).mode;
        if (mode === "timestamp" || mode === "timestamp_ms") return mode;
      }
    }
  }
  throw TypeError(
    "unsupported Drizzle placeholder encoder; use supported columns or raw sql.placeholder",
  );
}
/** Build-time only. No query builder, column object or encoder is serialized. */
export function compileDrizzleCatalog({
  schema,
  queries,
}: {
  schema: string[];
  queries: readonly DrizzleQuerySource[];
}): CompiledDrizzleCatalog {
  const built = queries.map(({ name, query }) => {
    const source = query.toSQL();
    const parameters: DrizzleParameter[] = source.params.map((value) => {
      if (is(value, Placeholder)) return { kind: "placeholder", name: value.name, codec: "value" };
      if (is(value, Param) && is(value.value, Placeholder))
        return { kind: "placeholder", name: value.value.name, codec: encoderCodec(value.encoder) };
      return { kind: "constant", value: drizzleConstant(value) };
    });
    return { name, sql: source.sql, parameters };
  });
  const catalog = buildDefinedCatalog({
    schema,
    queries: built.map(({ name, sql }) => ({ name, sql })),
  });
  for (const [i, q] of catalog.manifest.queries.entries())
    if (q.parameters !== built[i]!.parameters.length)
      throw Error(`Drizzle parameter count mismatch: ${q.name}`);
  const payload = {
    format: "sqlike-drizzle-bindings@1" as const,
    schemaId: catalog.manifest.schemaId,
    programId: catalog.manifest.programId,
    queries: built.map(({ name, parameters }) => ({ name, parameters })),
  };
  return {
    catalog,
    bindings: {
      ...payload,
      sha256: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
    },
  };
}
