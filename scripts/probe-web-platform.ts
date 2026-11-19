/** Size experiments only. Generated modules are transformed in memory / tmp;
 * production MoonBit and browser code are not replaced. */
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";
import { createHash } from "node:crypto";
import { build } from "vite";
import { chromium } from "@playwright/test";
import { isDeepStrictEqual } from "node:util";
import * as current from "../_build/js/release/build/mizchi/litestream-example/runtime/runtime.js";
import { buildCatalog } from "./aot-compiler.ts";
import { aotBindings } from "../src/aot-values.ts";
const runtimePath = resolve(
  "_build/js/release/build/mizchi/litestream-example/runtime/runtime.js",
);
const original = await readFile(runtimePath, "utf8");
const body = (code: string, name: string, replacement: string) => {
  const re = new RegExp(`function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n\\}`);
  if (!re.test(code)) throw Error(`compiler ABI changed: ${name}`);
  return code.replace(re, () => replacement);
};
const parse = String.raw`function _M0FPC14json13parse_2einner(input, max_nesting_depth, reject_duplicate_keys, preserve_number_repr) {
  try {
    // Upper-bound probe: native parsing collapses duplicate keys and reorders
    // numeric object keys; this is not a drop-in replacement for MoonBit JSON.
    const source = typeof input === "string" ? input : input.str.slice(input.start,input.end);
    const value = JSON.parse(source, (key, value, context) => {
      if (value === null) return _M0DTPC14json4Json4Null__;
      if (typeof value === 'boolean') return value ? _M0DTPC14json4Json4True__ : _M0DTPC14json4Json5False__;
      if (typeof value === 'number') return new _M0DTPC14json4Json6Number(value, preserve_number_repr ? context.source : undefined);
      if (typeof value === 'string') return new _M0DTPC14json4Json6String(value);
      if (Array.isArray(value)) return new _M0DTPC14json4Json5Array({buf:value,len:value.length});
      const entries = Object.entries(value).map(([key,value])=>({_0:key,_1:value}));
      return new _M0DTPC14json4Json6Object(_M0MPB3Map3MapGsRPC14json4JsonE({buf:entries,start:0,end:entries.length},undefined));
    });
    return new _M0DTPC16result6ResultGRPC14json4JsonRPC14json10ParseErrorE2Ok(value);
  } catch(error) {
    return new _M0DTPC16result6ResultGRPC14json4JsonRPC14json10ParseErrorE3Err(new _M0DTPC15error5Error51moonbitlang_2fcore_2fjson_2eParseError_2eInvalidEof());
  }
}`;
const stringify = String.raw`function _M0MPC14json4Json17stringify_2einner(self, escape_slash, indent, replacer) {
  if(replacer !== undefined || indent > 10) throw Error('probe: custom formatting not supported');
  function native(value) {
    switch(value.$tag) {
      case 0:return null;
      case 1:return true;
      case 2:return false;
      case 3:return value._1 !== undefined ? JSON.rawJSON(value._1) : Object.is(value._0,-0) ? JSON.rawJSON("-0.0") : value._0;
      case 4:return value._0;
      case 5:return value._0.buf.slice(0,value._0.len).map(native);
      case 6:{
        const iterator = _M0MPB3Map4iterGsRPC14json4JsonE(value._0), keys=[], values=new Map();
        for(let pair; (pair=_M0MPB4Iter4nextGUsRPC14json4JsonEE(iterator))!==undefined;) {keys.push(pair._0);values.set(pair._0,native(pair._1));}
        return new Proxy(Object.create(null),{ownKeys:()=>keys,getOwnPropertyDescriptor:()=>({enumerable:true,configurable:true}),get:(_,key)=>values.get(key)});
      }
    }
  }
  const result = JSON.stringify(native(self),undefined,indent);
  return escape_slash ? result.replaceAll('/','\\/') : result;
}`;
function transform(mode: string) {
  let code = original;
  if (mode.includes("base64")) {
    code = body(
      code,
      "_M0FPC28encoding6base6414encode_2einner",
      String.raw`function _M0FPC28encoding6base6414encode_2einner(bytes,padding) { return bytes.buf.subarray(bytes.start,bytes.end).toBase64({omitPadding:!padding}); }`,
    );
    code = body(
      code,
      "_M0FPC28encoding6base6414decode_2einner",
      String.raw`function _M0FPC28encoding6base6414decode_2einner(text,ignore_whitespace) {
 try {
  let input=text.str.slice(text.start,text.end);
  if(ignore_whitespace) input=input.replace(/[ \t\r\n]/g,'');
  if(/[^A-Za-z0-9+/=]/.test(input))throw Error('base64');
  if(!input.includes('=')) input+='='.repeat((4-input.length%4)%4);
  return new _M0DTPC16result6ResultGzRPC28encoding6base649MalformedE2Ok(Uint8Array.fromBase64(input,{lastChunkHandling:'strict'}));
 }catch(error){return new _M0DTPC16result6ResultGzRPC28encoding6base649MalformedE3Err(new _M0DTPC15error5Error62moonbitlang_2fcore_2fencoding_2fbase64_2eMalformed_2eMalformed(text));}
}`,
    );
  }
  if (mode.includes("parse"))
    code = body(code, "_M0FPC14json13parse_2einner", parse);
  if (mode.includes("stringify"))
    code = body(code, "_M0MPC14json4Json17stringify_2einner", stringify);
  return code;
}
const size = (value: string | Uint8Array) => {
  const bytes =
    typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
  return {
    raw: bytes.length,
    gzip: gzipSync(bytes, { level: 9 }).length,
    brotli: brotliCompressSync(bytes, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    }).length,
  };
};
const directory = await mkdtemp(join(tmpdir(), "web-platform-probe-")),
  results = [];
const catalog = buildCatalog({
  schema: ["CREATE TABLE t(id INTEGER PRIMARY KEY,n REAL,b BLOB)"],
  queries: [
    { name: "add", sql: "INSERT INTO t VALUES(?,?,?)" },
    { name: "read", sql: "SELECT * FROM t ORDER BY id" },
    { name: "json", sql: "SELECT json_extract(?,'$.x')" },
  ],
});
function smoke(engine: typeof current, artifact: string, bindings: string) {
  const db = engine.aot_open(artifact, "");
  const status = JSON.parse(engine.aot_info(db));
  if (status.error) throw Error(status.error);
  const inserted = JSON.parse(engine.aot_execute(db, "add", bindings));
  if (inserted.error) throw Error(inserted.error);
  const image = engine.aot_dump(db),
    reopened = engine.aot_open(artifact, image);
  const data = engine.aot_export_sqlite(reopened);
  if (JSON.parse(engine.sqlite_info(data)).error)
    throw Error(engine.sqlite_info(data));
  const encoded = engine.encode_ltx(
    new Uint8Array(),
    engine.sqlite_data(data),
    "1",
    "1",
    "0",
  );
  if (JSON.parse(engine.ltx_info(encoded)).error)
    throw Error(engine.ltx_info(encoded));
  const cases = [
    `{"x":{"10":1,"2":2}}`,
    `{"x":9223372036854775807}`,
    `{"x":-0.0}`,
    `{"x":1.2345678901234567}`,
  ];
  return {
    rows: JSON.parse(engine.aot_execute(reopened, "read", "[]")),
    image: JSON.parse(image),
    sqlite: btoa(String.fromCharCode(...engine.sqlite_data(data))),
    ltx: engine.ltx_data_base64(encoded),
    json: cases.map((text) =>
      JSON.parse(
        engine.aot_execute(
          db,
          "json",
          JSON.stringify([{ t: "text", v: text }]),
        ),
      ),
    ),
  };
}
const browser = await chromium.launch(),
  page = await browser.newPage();
const params = aotBindings([9007199254740993n, -0, new Uint8Array([0, 255])]);
async function browserSmoke(code: string) {
  return page.evaluate(
    async ({ code, artifact, bindings, source }) => {
      const url = URL.createObjectURL(
        new Blob([code], { type: "text/javascript" }),
      );
      try {
        const engine = await import(url);
        const run = eval("(" + source + ")");
        return run(engine, artifact, bindings);
      } finally {
        URL.revokeObjectURL(url);
      }
    },
    {
      code,
      artifact: catalog.artifact,
      bindings: params,
      source: smoke.toString(),
    },
  );
}
try {
  const expected = await browserSmoke(original);
  for (const mode of [
    "baseline",
    "base64",
    "stringify",
    "parse",
    "parse-stringify",
    "base64-parse-stringify",
  ]) {
    const code = transform(mode),
      path = join(directory, `${mode}.mjs`);
    await writeFile(path, code);
    const engine = (await import(pathToFileURL(path).href)) as typeof current;
    let checks: Record<string, unknown>;
    try {
      const actual = await browserSmoke(code);
      checks = Object.fromEntries(
        Object.entries(expected).map(([key, value]) => [
          key,
          isDeepStrictEqual(value, actual[key as keyof typeof actual]),
        ]),
      );
    } catch (error) {
      checks = { error: String(error) };
    }
    const built = await build({
      configFile: false,
      worker: { format: "es" },
      input: resolve("src/aot-worker.ts"),
      publicDir: false,
      logLevel: "silent",
      build: { write: false, target: "esnext", minify: true },
      plugins: [
        {
          name: "web-platform-size-probe",
          transform(source, id) {
            if (id === runtimePath) return { code, map: null };
          },
        },
      ],
    });
    if (Array.isArray(built) || !("output" in built))
      throw Error("unexpected build result");
    const chunks = built.output.filter((chunk) => chunk.type === "chunk");
    if (chunks.length !== 1) throw Error("unexpected chunk graph");
    const result = { mode, bytes: size(chunks[0]!.code), checks };
    results.push(result);
    console.log(JSON.stringify(result));
  }
  const lazyLtx = [];
  for (const lazy of [false, true]) {
    const worker = resolve("src/worker.ts");
    const output = await build({
      configFile: false,
      worker: { format: "es" },
      input: worker,
      publicDir: false,
      logLevel: "silent",
      build: { write: false, target: "esnext", minify: true },
      plugins: [
        {
          name: "lazy-ltx-probe",
          transform(source, id) {
            if (!lazy || id !== worker) return;
            return source
              .replace(
                'import { OpfsImages } from "../adapters/opfs-images.ts";',
                "",
              )
              .replace('import { LtxTransport } from "./ltx-transport.ts";', "")
              .replace(
                "if (options.directLtx) {",
                'if (options.directLtx) { const [{OpfsImages},{LtxTransport}] = await Promise.all([import("../adapters/opfs-images.ts"),import("./ltx-transport.ts")]);',
              );
          },
        },
      ],
    });
    const assembled = Array.isArray(output) ? output[0] : output;
    if (!assembled || !("output" in assembled))
      throw Error("unexpected output");
    const chunks = assembled.output.filter((chunk) => chunk.type === "chunk"),
      entry = chunks.find((chunk) => chunk.isEntry)!;
    const selected = new Map<string, ReturnType<typeof size>>();
    function walk(name: string) {
      const chunk = chunks.find((chunk) => chunk.fileName === name);
      if (!chunk || selected.has(name)) return;
      selected.set(name, size(chunk.code));
      for (const name of chunk.imports) walk(name);
    }
    walk(entry.fileName);
    const bytes = [...selected.values()].reduce(
      (a, b) => ({
        raw: a.raw + b.raw,
        gzip: a.gzip + b.gzip,
        brotli: a.brotli + b.brotli,
      }),
      { raw: 0, gzip: 0, brotli: 0 },
    );
    const item = { lazy, bytes, staticFiles: [...selected.keys()] };
    lazyLtx.push(item);
    console.log(JSON.stringify(item));
  }
  const libraries = [];
  for (const [name, path] of [
    ["sqlike", "_build/js/release/build/mizchi/sqlike/full/full.js"],
    ["litestream", "_build/js/release/build/mizchi/litestream/litestream.js"],
  ] as const) {
    const output = await build({
      configFile: false,
      worker: { format: "es" },
      publicDir: false,
      logLevel: "silent",
      build: {
        write: false,
        minify: true,
        target: "esnext",
        lib: { entry: resolve(path), formats: ["es"] },
      },
    });
    const assembled = Array.isArray(output) ? output[0] : output;
    if (!assembled || !("output" in assembled))
      throw Error("unexpected output");
    const chunk = assembled.output.find((chunk) => chunk.type === "chunk")!;
    const item = { name, path, bytes: size(chunk.code) };
    libraries.push(item);
    console.log(JSON.stringify(item));
  }
  const turso = [];
  for (const external of [false, true]) {
    const entry = resolve("adapters/turso-executor.ts");
    const output = await build({
      configFile: false,
      worker: { format: "es" },
      input: entry,
      publicDir: false,
      logLevel: "silent",
      build: { write: false, target: "esnext", minify: true },
      plugins: [
        {
          name: "external-turso-wasm-probe",
          transform(source, id) {
            if (external && id === entry)
              return source.replace(
                "@tursodatabase/database-wasm/bundle",
                "@tursodatabase/database-wasm",
              );
          },
        },
      ],
    });
    const assembled = Array.isArray(output) ? output[0] : output;
    if (!assembled || !("output" in assembled))
      throw Error("unexpected output");
    const files = assembled.output.map((file) => ({
      name: file.fileName,
      bytes: size(file.type === "chunk" ? file.code : file.source),
    }));
    const bytes = files.reduce(
      (a, file) => ({
        raw: a.raw + file.bytes.raw,
        gzip: a.gzip + file.bytes.gzip,
        brotli: a.brotli + file.bytes.brotli,
      }),
      { raw: 0, gzip: 0, brotli: 0 },
    );
    const item = { external, bytes, files };
    turso.push(item);
    console.log(JSON.stringify(item));
  }
  const features = await page.evaluate(() => ({
    base64: typeof (Uint8Array as any).fromBase64 === "function",
    rawJSON: typeof (JSON as any).rawJSON === "function",
    compression: Object.fromEntries(
      ["gzip", "deflate", "deflate-raw", "brotli", "zstd", "lz4"].map(
        (format) => {
          try {
            new CompressionStream(format as CompressionFormat);
            return [format, true];
          } catch {
            return [format, false];
          }
        },
      ),
    ),
  }));
  const report = {
    measuredAt: new Date().toISOString(),
    runtimeSHA256: createHash("sha256").update(original).digest("hex"),
    method:
      "In-memory replacement of generated JS helpers; paired Vite minified DB Worker builds with the same catalog and host adapter. Production sources are unchanged. Native JSON is an optimistic size probe: duplicate-key, nesting-limit, error-position, formatting and numeric-key-order parity are not established. No size deltas are additive.",
    results,
    lazyLtx,
    libraries,
    turso,
    features,
    chromium: browser.version(),
    nodeFeatures: {
      base64: "fromBase64" in Uint8Array,
      rawJSON: "rawJSON" in JSON,
    },
  };
  await writeFile(
    "measurements/web-platform-probe.json",
    JSON.stringify(report, null, 2) + "\n",
  );
} finally {
  await browser.close();
  await rm(directory, { recursive: true, force: true });
}
