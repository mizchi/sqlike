import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
test("optional inverted search matches FTS5 ascii/trigram phrases, prefix, boolean queries, column filters and BM25 through mutations/reopen", async () => {
  const js = await import(
    "../_build/js/release/build/mizchi/sqlike/fts/fts.js"
  );
  const wasm = (
    await WebAssembly.instantiate(
      readFileSync("_build/wasm-gc/release/build/mizchi/sqlike/fts/fts.wasm"),
      {},
      { builtins: ["js-string"], importedStringConstants: "_" },
    )
  ).instance.exports as unknown as typeof js;
  function parse(s: string) {
    const r = JSON.parse(s);
    if (r.error) throw Error(r.error);
    return r;
  }
  for (const tokenizer of ["ascii", "trigram"])
    for (const r of [js, wasm]) {
      const native = new DatabaseSync(":memory:");
      native.exec(
        `CREATE VIRTUAL TABLE docs USING fts5(title,body,tokenize='${tokenizer}')`,
      );
      const index = r.fts_open('["title","body"]', tokenizer);
      parse(r.fts_info(index));
      try {
        for (const [id, title, body] of [
          [1, "One two", "one two three"],
          [2, "TWO", "two two"],
          [3, "three", "one four"],
          [4, "日本語", "日本語 データベース"],
        ] as const) {
          native
            .prepare("INSERT INTO docs(rowid,title,body) VALUES(?,?,?)")
            .run(id, title, body);
          parse(r.fts_put(index, String(id), JSON.stringify([title, body])));
        }
        for (const query of tokenizer === "ascii"
          ? [
              "one",
              "two",
              '"one two"',
              "one*",
              "one AND two",
              "one NOT three",
              "one OR three",
              "title:one",
              "(one OR three) AND two",
              "日本語",
            ]
          : ["one", "two", '"one two"', "thr*", "one OR two", "日本語"]) {
          const s = native.prepare(
            "SELECT rowid,rank FROM docs WHERE docs MATCH ? ORDER BY rank,rowid",
          );
          const expected = s.all(query);
          const actual = parse(r.fts_search(index, query, 100)).hits;
          assert.deepEqual(
            actual.map((x: any) => Number(x.rowid)),
            expected.map((x) => x.rowid),
            `${tokenizer}: ${query}`,
          );
          for (const [i, x] of actual.entries())
            assert.ok(
              Math.abs(x.rank - Number(expected[i]!.rank)) < 1e-12,
              `${query}: ${x.rank}/${expected[i]!.rank}`,
            );
        }
        native.prepare("UPDATE docs SET body='five six' WHERE rowid=1").run();
        parse(r.fts_put(index, "1", JSON.stringify(["One two", "five six"])));
        native.exec("DELETE FROM docs WHERE rowid=2");
        parse(r.fts_delete(index, "2"));
        const saved = r.fts_dump(index),
          restored = r.fts_open('["title","body"]', tokenizer);
        parse(r.fts_restore(restored, saved));
        assert.equal(r.fts_dump(restored), saved);
        assert.deepEqual(
          parse(r.fts_search(restored, "one", 100)),
          parse(r.fts_search(index, "one", 100)),
        );
      } finally {
        native.close();
      }
    }
});
test("optional search adapter rebuilds from SQLike data and a malformed restore is atomic", async () => {
  const { SearchIndex } = await import("../src/search.ts");
  const { MoonDatabase } = await import("../adapters/moon-database.ts");
  const db = new MoonDatabase();
  try {
    db.run("CREATE TABLE docs(id INTEGER PRIMARY KEY,title TEXT,body TEXT)");
    db.run("INSERT INTO docs VALUES(1,'one','one two'),(2,'two','three')");
    const search = new SearchIndex(["title", "body"]);
    search.rebuild(
      db.query("SELECT id,title,body FROM docs").map((row) => ({
        rowid: row.id as bigint,
        fields: [String(row.title), String(row.body)],
      })),
    );
    assert.deepEqual(
      search.search("one").map((x) => x.rowid),
      [1n],
    );
    const before = search.dump();
    assert.throws(() => search.restore("{bad"));
    assert.equal(search.dump(), before);
    assert.throws(() => search.rebuild([{ rowid: 3n, fields: [] }]));
    assert.equal(search.dump(), before);
  } finally {
    db.close();
  }
});

test("trigram folds common Unicode case variants like native FTS5 and ASCII leaves non-ASCII letters distinct", async () => {
  const r = await import("../_build/js/release/build/mizchi/sqlike/fts/fts.js");
  for (const tokenizer of ["ascii", "trigram"]) {
    const n = new DatabaseSync(":memory:");
    try {
      n.exec(`CREATE VIRTUAL TABLE d USING fts5(text,tokenize='${tokenizer}')`);
      const index = r.fts_open('["text"]', tokenizer);
      for (const [i, text] of [
        "Äpfel",
        "äpfel",
        "Ελλάδα",
        "ΕΛΛΆΔΑ",
        "one_two",
      ].entries()) {
        n.prepare("INSERT INTO d(rowid,text) VALUES(?,?)").run(i + 1, text);
        assert.equal(
          JSON.parse(r.fts_put(index, String(i + 1), JSON.stringify([text])))
            .error,
          undefined,
        );
      }
      for (const query of [
        "Äpfel",
        "äpfel",
        "Ελλάδα",
        "one",
        "two",
        "TEXT:one",
      ]) {
        const expected = n
          .prepare("SELECT rowid FROM d WHERE d MATCH ? ORDER BY rowid")
          .all(query)
          .map((x) => x.rowid);
        const actual = JSON.parse(r.fts_search(index, query, 100));
        assert.equal(actual.error, undefined);
        assert.deepEqual(
          actual.hits
            .map((h: any) => Number(h.rowid))
            .sort((a: number, b: number) => a - b),
          expected,
          `${tokenizer}/${query}`,
        );
      }
    } finally {
      n.close();
    }
  }
});
