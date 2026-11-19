import type { AotDatabase } from "../../adapters/aot-database.ts";
import type { IndexedDbAotPageStore } from "../../adapters/aot-page-store.ts";
export { AotDatabase } from "../../adapters/aot-database.ts";
export { IndexedDbAotPageStore } from "../../adapters/aot-page-store.ts";
export { uploadAotLtx, syncAotLtx } from "../../src/aot-upload.ts";
export { toBase64 } from "../../src/aot-values.ts";
export const state: { db?: AotDatabase; store?: IndexedDbAotPageStore } = {};
