import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { compile_program } from "../_build/js/release/build/mizchi/sqlike/compiler/compiler.js";
import type {
  CatalogSource,
  CatalogManifest,
  StoragePlan,
  StorageTree,
  StorageField,
} from "../src/aot-contract.ts";

const sha256 = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
function compile(source: CatalogSource, storage?: StoragePlan): string {
  const artifact = compile_program(
    JSON.stringify({ ...source, ...(storage ? { storage } : {}) }),
  );
  const diagnostic = JSON.parse(artifact) as { error?: string };
  if (diagnostic.error) throw Error(`SQL build: ${diagnostic.error}`);
  return artifact;
}
export function buildCatalog(
  source: CatalogSource,
  { pageSize = 4096 }: { pageSize?: number } = {},
): { artifact: string; manifest: CatalogManifest; storage: StoragePlan } {
  if (![512, 1024, 2048, 4096, 8192, 16384, 32768, 65536].includes(pageSize))
    throw Error("invalid SQLite template page size");
  if (
    !Array.isArray(source.schema) ||
    !source.schema.every((sql) => typeof sql === "string") ||
    !Array.isArray(source.queries) ||
    !source.queries.every(
      (q) => typeof q.name === "string" && typeof q.sql === "string",
    )
  )
    throw Error("invalid catalog source");
  const diagnostic = JSON.parse(compile(source)) as {
    queries: { name: string; parameters: number; names: string[] }[];
    schema: {
      objects: {
        name: string;
        index_terms?: { expression: unknown }[];
        index_predicate?: unknown;
      }[];
    };
  };
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      `PRAGMA page_size=${pageSize};PRAGMA auto_vacuum=NONE;PRAGMA foreign_keys=ON`,
    );
    for (const sql of source.schema) db.exec(sql);
    const trees: StorageTree[] = [];
    const indexFields = (name: string): StorageField[] =>
      db
        .prepare(
          "SELECT seqno,cid,coll,desc FROM pragma_index_xinfo(?) ORDER BY seqno",
        )
        .all(name)
        .map((row) => {
          const expression =
            Number(row.cid) === -2
              ? diagnostic.schema.objects.find((o) => o.name === name)
                  ?.index_terms?.[Number(row.seqno)]?.expression
              : undefined;
          if (Number(row.cid) < -1 && expression === undefined)
            throw Error(
              "expression indexes are not supported by the runtime writer",
            );
          const collation = String(row.coll).toLowerCase();
          if (!["binary", "nocase", "rtrim"].includes(collation))
            throw Error(`unsupported collation ${collation}`);
          return {
            column: Number(row.cid),
            collation,
            descending: Boolean(row.desc),
            ...(expression === undefined ? {} : { expression }),
          };
        });
    for (const row of db
      .prepare(
        "SELECT type,name,tbl_name,rootpage FROM sqlite_schema WHERE rootpage>0 ORDER BY rowid",
      )
      .all()) {
      const name = String(row.name),
        table = String(row.tbl_name),
        root = Number(row.rootpage);
      if (row.type === "table") {
        const info = db
          .prepare(
            "SELECT wr FROM pragma_table_list WHERE schema='main' AND name=?",
          )
          .get(name)!;
        if (Number(info.wr)) {
          const pk = db
            .prepare("SELECT name FROM pragma_index_list(?) WHERE origin='pk'")
            .get(name);
          if (!pk) throw Error(`WITHOUT ROWID primary index missing: ${name}`);
          trees.push({
            name,
            table,
            root,
            kind: "without-rowid",
            fields: indexFields(String(pk.name)),
          });
        } else
          trees.push({
            name,
            table,
            root,
            kind: name === "sqlite_sequence" ? "sequence" : "table",
            fields: [],
          });
      } else if (row.type === "index")
        trees.push({
          name,
          table,
          root,
          kind: "index",
          fields: indexFields(name),
          ...(diagnostic.schema.objects.find((o) => o.name === name)
            ?.index_predicate === undefined
            ? {}
            : {
                predicate: diagnostic.schema.objects.find(
                  (o) => o.name === name,
                )!.index_predicate,
              }),
        });
    }
    for (const [i, query] of source.queries.entries()) {
      const names = db
        .prepare(query.sql)
        .columns()
        .map((column) => column.name);
      const moon = diagnostic.queries[i]!;
      if (JSON.stringify(names) !== JSON.stringify(moon.names))
        throw Error(
          `native/compiled result columns differ: ${query.name}: ${JSON.stringify(names)} != ${JSON.stringify(moon.names)}`,
        );
    }
    const image = db.serialize();
    const storage: StoragePlan = {
      format: "sqlite-template@1",
      page_size: pageSize,
      image: Buffer.from(image).toString("base64"),
      trees,
    };
    const artifact = compile(source, storage);
    return {
      artifact,
      storage,
      manifest: {
        format: "moon-aot-build@1",
        artifactSHA256: sha256(artifact),
        sourceSHA256: sha256(JSON.stringify(source)),
        templateSHA256: sha256(image),
        pageSize,
        nativeSQLite: String(
          db.prepare("SELECT sqlite_version() AS v").get()!.v,
        ),
        queries: diagnostic.queries.map((q) => ({
          name: q.name,
          parameters: q.parameters,
          columns: q.names,
        })),
      },
    };
  } finally {
    db.close();
  }
}
