import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import * as runtime from "../_build/js/release/build/mizchi/litestream-example/runtime/runtime.js";
import { buildCatalog } from "./aot-compiler.ts";
import { aotBindings } from "../src/aot-values.ts";
import { value } from "../tests/compatibility/differential-core.ts";
import type { DifferentialCase } from "../tests/compatibility/differential-contract.ts";
/** Compare real exported files, not only the logical evaluator's own checks. */
export function auditExportIntegrity(cases: DifferentialCase[]) {
  return cases
    .filter((c) => c.family === "unique-nul")
    .map((c) => {
      const dir = mkdtempSync(join(tmpdir(), "sqlike-integrity-"));
      try {
        const operations = [...(c.seed ?? []), ...c.steps];
        const built = buildCatalog({
          schema: c.schema,
          queries: operations.map((op, i) => ({ name: `q${i}`, sql: op.sql })),
        });
        const db = runtime.aot_open(built.artifact, "");
        const outcomes = operations.map((op, i) =>
          JSON.parse(
            runtime.aot_execute(
              db,
              `q${i}`,
              aotBindings((op.params ?? []).map(value)),
            ),
          ),
        );
        const exported = runtime.aot_export_sqlite(db);
        const info = JSON.parse(runtime.sqlite_info(exported));
        if (info.error)
          return { id: c.id, ok: false, exportError: info.error, outcomes };
        const image = Buffer.from(
          runtime.sqlite_data_base64(exported),
          "base64",
        );
        const path = join(dir, "db.sqlite");
        writeFileSync(path, image);
        const native = new DatabaseSync(path, { readOnly: true });
        try {
          const messages = native
            .prepare("PRAGMA integrity_check")
            .all()
            .map((r) => String(r.integrity_check));
          return {
            id: c.id,
            ok: messages.length === 1 && messages[0] === "ok",
            messages,
            bytes: image.length,
            sha256: createHash("sha256").update(image).digest("hex"),
            outcomes,
          };
        } finally {
          native.close();
        }
      } catch (e) {
        return {
          id: c.id,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
}
