import { mkdirSync, mkdtempSync, writeFileSync, readdirSync, copyFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { NodeDatabase } from "../adapters/node-database.ts";
import { LitestreamReplica } from "../adapters/litestream.ts";

const destination = resolve("tests/fixtures/ltx"); mkdirSync(destination, { recursive: true });
const db = new NodeDatabase(":memory:");
db.raw.exec("CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT NOT NULL);INSERT INTO items VALUES(1,'base')");
writeFileSync(join(destination, "base.sqlite"), db.raw.serialize());
db.raw.exec("INSERT INTO items VALUES(2,hex(zeroblob(10000)));UPDATE items SET value='grown' WHERE id=1");
writeFileSync(join(destination, "grown.sqlite"), db.raw.serialize());
db.raw.exec("DELETE FROM items WHERE id=2;UPDATE items SET value='shrunk';VACUUM");
writeFileSync(join(destination, "shrunk.sqlite"), db.raw.serialize()); db.close();
execFileSync("go", ["run", "-mod=mod", ".", destination], { cwd: "scripts/ltx-reference", stdio: "inherit" });

const binary = process.env.LITESTREAM_BIN;
if (!binary) throw new Error("set LITESTREAM_BIN to regenerate the real Litestream fixtures");
const dir = mkdtempSync(join(tmpdir(), "browser-litestream-fixture-"));
const source = join(dir, "source.sqlite"); const root = join(dir, "replica");
const native = new NodeDatabase(source);
native.raw.exec("CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT NOT NULL);INSERT INTO items VALUES(1,'base')");
const replica = new LitestreamReplica(binary, source, root);
try {
  await replica.catalog(0);
  native.raw.exec("INSERT INTO items VALUES(2,hex(zeroblob(10000)));UPDATE items SET value='grown' WHERE id=1");
  await replica.catalog(0);
  native.raw.exec("DELETE FROM items WHERE id=2;UPDATE items SET value='shrunk';VACUUM");
  await replica.catalog(0);
} finally { await replica.close(); native.close(); }
const names = readdirSync(join(root, "ltx/0")).filter(n => n.endsWith(".ltx")).sort();
names.forEach((name, i) => copyFileSync(join(root, "ltx/0", name), join(destination, `litestream-${i}.ltx`)));
writeFileSync(join(destination, "litestream.json"), JSON.stringify(names.map((_, i) => `litestream-${i}.ltx`)) + "\n");
rmSync(join(destination, "litestream-restored.sqlite"), { force: true });
execFileSync(binary, ["restore", "-o", join(destination, "litestream-restored.sqlite"), pathToFileURL(root).href]);
rmSync(dir, { recursive: true, force: true });
console.log(`Generated upstream fixtures and ${names.length} real Litestream files in ${destination}`);
