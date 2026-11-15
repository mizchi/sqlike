/** Optional SQLite writer entry. The execution-only adapter does not import it. */
import * as runtime from "../_build/js/release/build/mizchi/sqlike/defined-sqlite/defined-sqlite.js";
import type { DefinedCatalog } from "../src/defined-contract.ts";
import { sha256 } from "../src/aot-values.ts";
export async function exportDefinedSQLite(
  catalog: DefinedCatalog,
  image: Uint8Array,
): Promise<Uint8Array> {
  const schema = catalog.schema.slice(),
    statements = catalog.statements.slice(),
    layout = catalog.storage?.slice(),
    snapshot = image.slice();
  const manifest = { ...catalog.manifest };
  if (!layout || !manifest.storageSHA256)
    throw Error("defined SQLite export requires an optional storage layout");
  if (
    (await sha256(schema)) !== manifest.schemaSHA256 ||
    (await sha256(statements)) !== manifest.statementsSHA256 ||
    (await sha256(layout)) !== manifest.storageSHA256
  )
    throw Error("defined export artifact hash mismatch");
  const result = runtime.defined_export_sqlite(
    schema,
    statements,
    layout,
    snapshot,
  );
  const info = JSON.parse(runtime.sqlite_info(result)) as { error?: string };
  if (info.error) throw Error(info.error);
  return runtime.sqlite_data(result).slice();
}
