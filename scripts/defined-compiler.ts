import { createHash } from "node:crypto";
import { buildCatalog } from "./aot-compiler.ts";
import * as compiler from "../_build/js/release/build/mizchi/sqlike/compiler/compiler.js";
import type { CatalogSource } from "../src/aot-contract.ts";
import type { DefinedCatalog } from "../src/defined-contract.ts";
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export function buildDefinedCatalog(
  source: CatalogSource,
  {
    sqliteExport = false,
    pageSize = 4096,
  }: { sqliteExport?: boolean; pageSize?: number } = {},
): DefinedCatalog {
  const legacy = buildCatalog(source, { pageSize });
  const packed = compiler.pack_program_binary(legacy.artifact);
  const info = JSON.parse(compiler.binary_catalog_info(packed)) as {
    error?: string;
    schemaId: string;
    programId: string;
  };
  if (info.error) throw Error(info.error);
  const schema = Uint8Array.from(compiler.binary_catalog_schema(packed));
  const statements = Uint8Array.from(
    compiler.binary_catalog_statements(packed),
  );
  const storage = sqliteExport
    ? Uint8Array.from(compiler.binary_catalog_storage(packed))
    : undefined;
  return {
    schema,
    statements,
    ...(storage ? { storage } : {}),
    manifest: {
      format: "sqlike-defined-build@1",
      schemaId: info.schemaId,
      programId: info.programId,
      schemaSHA256: hash(schema),
      statementsSHA256: hash(statements),
      ...(storage ? { storageSHA256: hash(storage) } : {}),
      sourceSHA256: legacy.manifest.sourceSHA256,
      queries: legacy.manifest.queries,
    },
  };
}
