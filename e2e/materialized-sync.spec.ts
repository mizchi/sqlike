import { test, expect } from "@playwright/test";
import { build } from "vite";
import { readFileSync } from "node:fs";
let code = "";
test.beforeAll(async () => {
  const bundles = await build({
    configFile: false,
    publicDir: false,
    logLevel: "error",
    build: {
      write: false,
      minify: true,
      target: "esnext",
      lib: { entry: "e2e/fixtures/materialized-runtime.ts", formats: ["es"] },
    },
  });
  for (const b of Array.isArray(bundles) ? bundles : [bundles])
    if ("output" in b)
      for (const item of b.output) if (item.type === "chunk") code += item.code;
});
test("SQLite WASM materialized binary sync captures trigger and FK effects once in Chromium", async ({
  page,
}) => {
  await page.route("**/materialized-test", (r) =>
    r.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.route("**/materialized-test.js", (r) =>
    r.fulfill({ contentType: "text/javascript", body: code }),
  );
  await page.route("**/sqlite3.wasm", (r) =>
    r.fulfill({
      contentType: "application/wasm",
      body: readFileSync(
        "node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm",
      ),
    }),
  );
  await page.goto("/materialized-test");
  const result = await page.evaluate(async () => {
    const path = "/materialized-test.js";
    const m = (await import(
      path
    )) as typeof import("./fixtures/materialized-runtime.ts");
    const sqlite = await m.sqlite3InitModule();
    const raw = new sqlite.oo1.DB(":memory:");
    raw.exec("PRAGMA foreign_keys=ON");
    const native = new m.WasmDatabase(sqlite, raw),
      server = m.withMaterializedReplication(native),
      engine = new m.SyncEngine(server);
    const local = m.withMaterializedReplication(new m.MoonDatabase());
    engine.migrate([
      m.statement("CREATE TABLE p(id INTEGER PRIMARY KEY)"),
      m.statement(
        "CREATE TABLE c(id INTEGER PRIMARY KEY,p INTEGER REFERENCES p(id) ON DELETE CASCADE)",
      ),
      m.statement(
        "CREATE TABLE audit(id INTEGER PRIMARY KEY AUTOINCREMENT,v TEXT)",
      ),
      m.statement(
        "CREATE TRIGGER tr AFTER DELETE ON c BEGIN INSERT INTO audit(v) VALUES('delete'); END",
      ),
    ]);
    const client = new m.OfflineClient(local, {
      snapshot: async () => engine.snapshot(),
      push: async (b) => engine.push(b),
    });
    await client.sync();
    client.execute(
      [
        m.statement("INSERT INTO p VALUES(1)"),
        m.statement("INSERT INTO c VALUES(2,1)"),
      ],
      "changeset",
    );
    await client.sync();
    client.execute([m.statement("DELETE FROM p WHERE id=1")], "changeset");
    await client.sync();
    const first = server.all("SELECT * FROM audit").length,
      children = server.all("SELECT * FROM c").length;
    let enforced = false;
    try {
      native.run("INSERT INTO c VALUES(3,404)");
    } catch {
      enforced = true;
    }
    // Also use SQLite Session as the source, including indirect trigger changes.
    const source = new m.WasmDatabase(sqlite, new sqlite.oo1.DB(":memory:"));
    source.run("PRAGMA foreign_keys=ON");
    const target = m.withMaterializedReplication(new m.MoonDatabase()),
      receiver = new m.SyncEngine(target);
    receiver.migrate([
      m.statement("CREATE TABLE t(id INTEGER PRIMARY KEY)"),
      m.statement("CREATE TABLE log(id INTEGER PRIMARY KEY)"),
      m.statement(
        "CREATE TRIGGER ai AFTER INSERT ON t BEGIN INSERT INTO log VALUES(new.id); END",
      ),
    ]);
    const nativeClient = new m.OfflineClient(source, {
      snapshot: async () => receiver.snapshot(),
      push: async (b) => receiver.push(b),
    });
    await nativeClient.sync();
    nativeClient.execute([m.statement("INSERT INTO t VALUES(1)")], "changeset");
    await nativeClient.sync();
    const captured =
      target.all("SELECT * FROM log").length === 1 &&
      source.all("SELECT * FROM log").length === 1;
    raw.close();
    source.raw.close();
    local.close();
    target.close();
    return { first, children, enforced, captured };
  });
  expect(result).toEqual({
    first: 1,
    children: 0,
    enforced: true,
    captured: true,
  });
});
