import assert from "node:assert/strict";
import { buildCatalog } from "./aot-compiler.ts";
import * as compiler from "../_build/js/release/build/mizchi/sqlike/compiler/compiler.js";
import {
  catalogFunctionConstants,
  catalogStatementConstants,
} from "../src/catalog-capabilities.ts";
import type { CatalogSource } from "../src/aot-contract.ts";
import type { CatalogRequirements } from "../src/catalog-requirements-contract.ts";
import type { SqlikeFeatureName } from "../src/sqlike-features.ts";

const features: readonly [number, SqlikeFeatureName][] = [
  [1, "foreignKeys"],
  [2, "triggers"],
  [4, "strictTables"],
  [8, "rightFullJoin"],
  [16, "sqlJson"],
  [32, "dateTime"],
  [64, "windowFunctions"],
  [128, "schemaMetadata"],
  [256, "aggregateFilter"],
];
export function analyzeCatalogRequirements(source: CatalogSource): CatalogRequirements {
  if (!source || !Array.isArray(source.schema) || !Array.isArray(source.queries))
    throw Error("invalid catalog source");
  const built = buildCatalog(source);
  const data = JSON.parse(compiler.program_runtime_requirements(built.artifact));
  if (data.error) throw Error(data.error);
  assert.equal(data.format, "sqlike-runtime-requirements@1");
  assert.ok(
    Number.isInteger(data.featureBits) && data.featureBits >= 0 && data.featureBits <= 511,
    "unknown catalog feature bits",
  );
  for (const name of ["functions", "functionGroups", "statements"]) {
    const values = data[name];
    assert.ok(Array.isArray(values) && values.every((v) => typeof v === "string"));
    assert.deepEqual(values, [...new Set(values)].sort(), `non-canonical catalog ${name}`);
  }
  assert.ok(
    data.functionGroups.every((n: string) => Object.hasOwn(catalogFunctionConstants, n)),
    "unknown function group",
  );
  assert.ok(
    data.statements.every((n: string) => Object.hasOwn(catalogStatementConstants, n)),
    "unknown statement kind",
  );
  return Object.freeze({
    format: data.format,
    artifactSHA256: built.manifest.artifactSHA256,
    sourceSHA256: built.manifest.sourceSHA256,
    features: Object.freeze(
      features
        .filter(([bit]) => (data.featureBits & bit) !== 0)
        .map(([, name]) => name)
        .sort(),
    ),
    functions: Object.freeze(data.functions),
    functionGroups: Object.freeze(data.functionGroups),
    statements: Object.freeze(data.statements),
  });
}
