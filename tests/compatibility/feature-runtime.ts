import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  MoonDatabase,
  type MoonSqlRuntime,
} from "../../adapters/moon-database.ts";
import * as jsRuntime from "../../_build/js/release/build/mizchi/sqlike/sqlike.js";
import type { Value } from "../../src/contract.ts";
import {
  catalogFeatures,
  runtimeInventoryGaps,
  type FeatureCatalog,
} from "./feature-probes.ts";
import { additionalFeatures } from "./feature-requirements.ts";
import {
  auditFeature,
  outputDataState,
  summarizeAudit,
  type AuditDriver,
  type AuditFeature,
  type OracleCapabilities,
} from "./feature-audit.ts";

const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export const serialize = (value: unknown) =>
  JSON.stringify(
    value,
    (_, v) =>
      typeof v === "bigint"
        ? { $integer: String(v) }
        : typeof v === "number" && (Object.is(v, -0) || !Number.isFinite(v))
          ? { $real: Object.is(v, -0) ? "-0" : String(v) }
          : v,
    2,
  ) + "\n";
export function nativeDriver(): AuditDriver {
  const db = new DatabaseSync(":memory:");
  return {
    execute(step) {
      const stmt = db.prepare(step.sql);
      stmt.setReadBigInts(true);
      stmt.setReturnArrays(true);
      const rows = stmt.all(...(step.params ?? [])) as unknown as Value[][];
      return step.kind === "exec" ? [] : rows;
    },
    hasExport: () => false,
    close: () => db.close(),
  };
}
export function moonDriver(runtime: MoonSqlRuntime = jsRuntime): AuditDriver {
  const db = new MoonDatabase(undefined, undefined, runtime);
  return {
    execute(step) {
      if (step.kind === "exec") {
        db.run(step.sql, step.params);
        return [];
      }
      if (step.kind === "returning")
        return db.all(step.sql, step.params).map(Object.values);
      return db.queryValues(step.sql, step.params);
    },
    dataState: () => outputDataState(db.dump()),
    hasExport: (name) =>
      typeof (runtime as unknown as Record<string, unknown>)[name] ===
      "function",
  };
}
export async function wasmRuntime(): Promise<MoonSqlRuntime> {
  const { instance, module } = await WebAssembly.instantiate(
    readFileSync("_build/wasm-gc/release/build/mizchi/sqlike/sqlike.wasm"),
    {},
    { builtins: ["js-string"], importedStringConstants: "_" },
  );
  if (WebAssembly.Module.imports(module).length)
    throw Error("Wasm GC requires unexpected host imports");
  const runtime = instance.exports as unknown as MoonSqlRuntime;
  return {
    ...runtime,
    database_is_readonly: (sql) => Boolean(runtime.database_is_readonly(sql)),
  };
}
export function auditPlan() {
  const body = readFileSync(
    "tests/fixtures/sqlite-catalog/catalog.json",
    "utf8",
  );
  const catalog = JSON.parse(body) as FeatureCatalog;
  const db = new DatabaseSync(":memory:");
  try {
    const functionSignatures = db.prepare("PRAGMA function_list").all();
    const pragmaNames = db
      .prepare("PRAGMA pragma_list")
      .all()
      .map((r) => String(r.name));
    const moduleNames = db
      .prepare("PRAGMA module_list")
      .all()
      .map((r) => String(r.name));
    const capabilities: OracleCapabilities = {
      functions: [
        ...new Set(functionSignatures.map((r) => String(r.name))),
      ].sort(),
      pragmas: pragmaNames.sort(),
      modules: moduleNames.sort(),
    };
    const official = catalogFeatures(catalog),
      extra = additionalFeatures();
    const features = [
      ...official,
      ...extra,
      ...runtimeInventoryGaps(capabilities, official),
    ];
    const ids = features.map((f) => f.id);
    if (new Set(ids).size !== ids.length) throw Error("Duplicate feature IDs");
    const sources = [
      "moon.work",
      ...["packages/sqlike", "packages/litestream", "examples/aot"].flatMap(
        (dir) =>
          readdirSync(dir, { recursive: true, withFileTypes: true })
            .filter(
              (entry) =>
                entry.isFile() &&
                (entry.name.endsWith(".mbt") ||
                  ["moon.mod", "moon.pkg"].includes(entry.name)),
            )
            .map((entry) => `${entry.parentPath}/${entry.name}`),
      ),
    ].sort();
    const harness = [
      "adapters/moon-database.ts",
      "src/contract.ts",
      "src/aot-values.ts",
      "src/protocol.ts",
      "tests/compatibility/output-policy-corpus.ts",
      "tests/compatibility/output-generated-corpus.ts",
      "e2e/sqlite-feature-audit.audit.ts",
      "scripts/audit-sqlite.ts",
      "scripts/check-sqlite-audit.ts",
      ...readdirSync("tests/compatibility")
        .filter((name) => name.startsWith("feature-") && name.endsWith(".ts"))
        .map((name) => `tests/compatibility/${name}`),
    ].sort();
    const oracle = {
      engine: "native node:sqlite",
      node: process.version,
      ...db
        .prepare(
          "SELECT sqlite_version() AS version,sqlite_source_id() AS sourceId",
        )
        .get(),
      compileOptions: db
        .prepare("PRAGMA compile_options")
        .all()
        .map((r) => r.compile_options),
      functionSignatures,
      capabilities,
    };
    return {
      format: 1,
      catalogSHA256: hash(body),
      planSHA256: hash(serialize(features)),
      sourceSHA256: hash(
        sources
          .map((path) => path + "\0" + readFileSync(path, "utf8"))
          .join("\0"),
      ),
      harnessSHA256: hash(
        harness
          .map((path) => path + "\0" + readFileSync(path, "utf8"))
          .join("\0"),
      ),
      oracleSHA256: hash(serialize(oracle)),
      artifacts: {
        js: hash(
          readFileSync("_build/js/release/build/mizchi/sqlike/sqlike.js"),
        ),
        wasmGC: hash(
          readFileSync(
            "_build/wasm-gc/release/build/mizchi/sqlike/sqlike.wasm",
          ),
        ),
      },
      oracle,
      features,
    };
  } finally {
    db.close();
  }
}
export type AuditPlan = ReturnType<typeof auditPlan>;
export function auditRuntime(plan: AuditPlan, runtime: MoonSqlRuntime) {
  const results = plan.features.map((feature) => {
    const native = nativeDriver(),
      moon = moonDriver(runtime);
    try {
      return auditFeature(feature, native, moon, plan.oracle.capabilities);
    } finally {
      native.close?.();
    }
  });
  return { summary: summarizeAudit(results), results };
}
export function categorySummary(
  features: AuditFeature[],
  results: ReturnType<typeof auditRuntime>["results"],
) {
  return Object.fromEntries(
    [...new Set(features.map((f) => f.category))].map((category) => [
      category,
      summarizeAudit(results.filter((r) => r.category === category)),
    ]),
  );
}
