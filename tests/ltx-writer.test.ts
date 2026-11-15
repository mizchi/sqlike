import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import * as runtime from "../_build/js/release/build/mizchi/litestream/litestream.js";
import { applyLtx } from "../src/ltx.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import type { LtxInfo } from "../src/ltx.ts";
import { nativeValues } from "./compatibility/native-values.ts";

function encode(base: Uint8Array, data: Uint8Array, min: string, max = min) {
  const result = runtime.encode_ltx(base, data, min, max, "0");
  const info = JSON.parse(runtime.ltx_info(result)) as LtxInfo & {
    error?: string;
  };
  if (info.error) throw Error(info.error);
  return { data: runtime.ltx_data(result), info };
}
const fixture = (name: string) =>
  new Uint8Array(readFileSync(`tests/fixtures/ltx/${name}`));
test("pure MoonBit LTX writer produces snapshot, delta, shrink and uint64 TXIDs that decode independently", () => {
  const base = fixture("base.sqlite"),
    grown = fixture("grown.sqlite"),
    shrunk = fixture("shrunk.sqlite");
  const snapshot = encode(new Uint8Array(), base, "1"),
    delta = encode(base, grown, "2"),
    shrink = encode(grown, shrunk, "3");
  assert.deepEqual(
    applyLtx(new Uint8Array(), "0", snapshot.data, 3).data,
    base,
  );
  assert.deepEqual(applyLtx(base, "1", delta.data, 3).data, grown);
  assert.deepEqual(applyLtx(grown, "2", shrink.data, 3).data, shrunk);
  assert.equal(
    encode(base, grown, "9007199254740994").info.maxTXID,
    "9007199254740994",
  );
  const directory = mkdtempSync(join(tmpdir(), "moon-ltx-writer-"));
  try {
    for (const [name, value] of [
      ["snapshot", snapshot],
      ["delta", delta],
      ["shrink", shrink],
    ] as const) {
      const file = join(directory, `${name}.ltx`);
      writeFileSync(file, value.data);
      execFileSync("go", ["run", "-mod=mod", ".", "verify", file], {
        cwd: "scripts/ltx-reference",
        stdio: "pipe",
      });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("LTX generation rejects malformed images, ranges and incompatible page sizes without mutating inputs", () => {
  const base = fixture("base.sqlite"),
    copy = base.slice();
  assert.throws(() => encode(base, base, "0"), /TXID|transaction/i);
  assert.throws(() => encode(base, base, "3", "2"), /TXID|range/i);
  assert.throws(
    () => encode(base, new Uint8Array([1]), "2"),
    /SQLite|page|size/i,
  );
  const broken = base.slice();
  broken[16] = 1;
  assert.throws(() => encode(base, broken, "2"), /page|size/i);
  assert.deepEqual(base, copy);
});
test("real Litestream restores a full MoonBit-produced LTX chain", () => {
  const binary = process.env.LITESTREAM_BIN;
  assert.ok(
    binary,
    "LITESTREAM_BIN must identify a real executable; this integration is not skipped",
  );
  const directory = mkdtempSync(join(tmpdir(), "moon-ltx-restore-"));
  try {
    const level = join(directory, "replica", "ltx", "0");
    mkdirSync(level, { recursive: true });
    const base = fixture("base.sqlite"),
      grown = fixture("grown.sqlite"),
      shrunk = fixture("shrunk.sqlite");
    for (const [index, result] of [
      encode(new Uint8Array(), base, "1"),
      encode(base, grown, "2"),
      encode(grown, shrunk, "3"),
    ].entries()) {
      const txid = BigInt(index + 1)
        .toString(16)
        .padStart(16, "0");
      writeFileSync(join(level, `${txid}-${txid}.ltx`), result.data);
    }
    const output = join(directory, "restored.sqlite");
    execFileSync(
      binary,
      ["restore", "-o", output, pathToFileURL(join(directory, "replica")).href],
      { stdio: "pipe" },
    );
    assert.deepEqual(new Uint8Array(readFileSync(output)), shrunk);
    const native = new NodeDatabase(output, false);
    try {
      assert.deepEqual(nativeValues(native, "PRAGMA integrity_check"), [
        ["ok"],
      ]);
      assert.deepEqual(nativeValues(native, "SELECT id,value FROM items"), [
        [1n, "shrunk"],
      ]);
    } finally {
      native.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("LZ4 writer handles native SQLite pages from 512 to 65536 bytes, incompressible blobs and no-op deltas", () => {
  const dir = mkdtempSync(join(tmpdir(), "moon-ltx-pages-"));
  try {
    for (const pageSize of [512, 1024, 4096, 65536]) {
      const db = new NodeDatabase(":memory:");
      try {
        db.raw.exec(
          `PRAGMA page_size=${pageSize};VACUUM;CREATE TABLE data(id INTEGER PRIMARY KEY,b BLOB)`,
        );
        const blob = new Uint8Array(20000);
        let seed = 123456789;
        for (let i = 0; i < blob.length; i++) {
          seed ^= seed << 13;
          seed ^= seed >>> 17;
          seed ^= seed << 5;
          blob[i] = seed & 255;
        }
        db.run("INSERT INTO data VALUES(1,?)", [blob]);
        const image = db.raw.serialize(),
          snapshot = encode(new Uint8Array(), image, "1");
        assert.deepEqual(
          applyLtx(new Uint8Array(), "0", snapshot.data, 3).data,
          new Uint8Array(image),
        );
        const empty = encode(image, image, "2");
        assert.equal(empty.info.pagesApplied, 0);
        assert.deepEqual(
          applyLtx(image, "1", empty.data, 3).data,
          new Uint8Array(image),
        );
        const path = join(dir, `${pageSize}.ltx`);
        writeFileSync(path, snapshot.data);
        execFileSync("go", ["run", "-mod=mod", ".", "verify", path], {
          cwd: "scripts/ltx-reference",
          stdio: "pipe",
        });
      } finally {
        db.close();
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Wasm GC emits the same LTX bytes using the portable base64 boundary", async () => {
  const { instance, module } = await WebAssembly.instantiate(
    readFileSync("_build/wasm-gc/release/build/mizchi/litestream/litestream.wasm"),
    {},
    { builtins: ["js-string"], importedStringConstants: "_" },
  );
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  const wasm = instance.exports as unknown as typeof runtime;
  const input = fixture("base.sqlite"),
    result = wasm.encode_ltx_base64(
      "",
      Buffer.from(input).toString("base64"),
      "1",
      "1",
      "0",
    );
  assert.equal(JSON.parse(wasm.ltx_info(result)).error, undefined);
  assert.deepEqual(
    new Uint8Array(Buffer.from(wasm.ltx_data_base64(result), "base64")),
    encode(new Uint8Array(), input, "1").data,
  );
});
