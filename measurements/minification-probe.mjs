// Reproducible size experiment; does not replace production bundles.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
const root = process.cwd();
const toolPath = path.resolve(
  process.argv[2] ||
    "/tmp/browser-litestream-terser-tools/node_modules/terser/main.js",
);
if (!fs.existsSync(toolPath))
  throw Error("Terser is missing; run just probe-minification");
const { minify } = await import(pathToFileURL(toolPath));
const { buildSqlikeRuntime } = await import(
  pathToFileURL(path.join(root, "scripts/build-sqlike-runtime.ts"))
);
const { defineSqlike, allSqlikeFeatures, primaryKeyIndex } = await import(
  pathToFileURL(path.join(root, "src/sqlike-features.ts"))
);
const features = allSqlikeFeatures.filter(
  (f) => !["binarySync", "sqlitePages", "ltx"].includes(f.name),
);
for (const [profile, selected] of [
  ["notes-minimal", [primaryKeyIndex]],
  [
    "without-all-three",
    features.filter(
      (f) => !["dateTime", "sqlJson", "windowFunctions"].includes(f.name),
    ),
  ],
  ["all-execution", features],
])
  await buildSqlikeRuntime(
    defineSqlike({ mode: "defined", features: selected }),
    {
      outDir: path.join(root, "generated/terser-probe/inputs", profile),
      targets: ["js"],
      minify: false,
    },
  );
async function probeSizes() {
  const root = process.cwd(),
    require = createRequire(path.join(root, "package.json"));
  const { build, resolveConfig } = await import(
    pathToFileURL(require.resolve("vite"))
  );
  const terserPath = toolPath;
  const { minify } = await import(pathToFileURL(terserPath));
  const { parse } = await import(
    pathToFileURL(createRequire(fs.realpathSync(terserPath)).resolve("acorn"))
  );
  const out = path.join(root, "generated/terser-probe");
  fs.mkdirSync(out, { recursive: true });
  const sizes = (code) => {
    const b = Buffer.from(code);
    return {
      raw: b.length,
      gzip: gzipSync(b, { level: 9 }).length,
      brotli: brotliCompressSync(b, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
      }).length,
    };
  };
  const hash = (s) => createHash("sha256").update(s).digest("hex");
  function names(code) {
    const source = parse(code, { ecmaVersion: "latest", sourceType: "module" }),
      ids = new Map(),
      props = new Map();
    const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
    function visit(n) {
      if (n.type === "Identifier") bump(ids, n.name);
      if (
        n.type === "MemberExpression" &&
        !n.computed &&
        n.property.type === "Identifier"
      )
        bump(props, n.property.name);
      if (n.type === "Property" && !n.computed && n.key.type === "Identifier")
        bump(props, n.key.name);
      for (const value of Object.values(n)) {
        if (Array.isArray(value)) {
          for (const child of value)
            if (child && typeof child.type === "string") visit(child);
        } else if (value && typeof value.type === "string") visit(value);
      }
    }
    visit(source);
    const rows = (m) =>
      [...m]
        .map(([name, count]) => ({
          name,
          count,
          characters: name.length * count,
        }))
        .sort((a, b) => b.characters - a.characters);
    return {
      longIdentifiers: rows(ids)
        .filter((r) => r.name.length > 12)
        .slice(0, 15),
      properties: rows(props).slice(0, 15),
      moonIdentifierCharacters: rows(ids)
        .filter((r) => /^_M/.test(r.name))
        .reduce((s, r) => s + r.characters, 0),
      lineCount: code.split("\n").length,
    };
  }
  const common = {
    module: true,
    ecma: 2022,
    format: { preserve_annotations: true },
  };
  const variants = [
    ["whitespace-only", { compress: false, mangle: false }],
    ["identifiers-only", { compress: false, mangle: true }],
    ["compress-1", { compress: { passes: 1 }, mangle: true }],
    ["compress-2", { compress: { passes: 2 }, mangle: true }],
    ["compress-3", { compress: { passes: 3 }, mangle: true }],
    [
      "generated-properties",
      {
        compress: { passes: 2 },
        mangle: {
          properties: { regex: /^(_M|_[0-9]+$|\$tag$)/, keep_quoted: true },
        },
      },
    ],
  ];
  const results = [];
  for (const profile of [
    "notes-minimal",
    "without-all-three",
    "all-execution",
  ]) {
    const entry = path.join(
      root,
      "generated/terser-probe/inputs",
      profile,
      "runtime.js",
    );
    const input = fs.readFileSync(entry, "utf8");
    const result = await build({
      configFile: false,
      publicDir: false,
      logLevel: "silent",
      build: {
        write: false,
        minify: true,
        target: "esnext",
        lib: { entry, formats: ["es"] },
      },
    });
    const output = (Array.isArray(result) ? result[0] : result).output.find(
      (c) => c.type === "chunk",
    );
    const baseline = output.code;
    const original = await import(pathToFileURL(entry));
    const record = {
      profile,
      inputSHA256: hash(input),
      baseline: { ...sizes(baseline), analysis: names(baseline) },
      variants: [],
    };
    fs.writeFileSync(path.join(out, `${profile}-baseline.mjs`), baseline);
    console.log(
      JSON.stringify({
        profile,
        variant: "baseline",
        ...sizes(baseline),
        moonNames: record.baseline.analysis.moonIdentifierCharacters,
      }),
    );
    for (const [variant, options] of variants) {
      const start = performance.now(),
        result = await minify(baseline, { ...common, ...options });
      assert.ok(result.code);
      const ms = performance.now() - start;
      const file = path.join(out, `${profile}-${variant}.mjs`);
      fs.writeFileSync(file, result.code);
      const candidate = await import(pathToFileURL(file));
      assert.deepEqual(
        Object.keys(candidate).sort(),
        Object.keys(original).sort(),
      );
      const row = {
        variant,
        ...sizes(result.code),
        milliseconds: ms,
        SHA256: hash(result.code),
        analysis: names(result.code),
        exportsPreserved: true,
      };
      record.variants.push(row);
      console.log(
        JSON.stringify({
          profile,
          variant,
          ...sizes(result.code),
          ms: Math.round(ms),
          moonNames: row.analysis.moonIdentifierCharacters,
        }),
      );
    }
    const start = performance.now(),
      direct = await minify(input, {
        ...common,
        compress: { passes: 2 },
        mangle: true,
      });
    const file = path.join(out, `${profile}-direct-2.mjs`);
    fs.writeFileSync(file, direct.code);
    const candidate = await import(pathToFileURL(file));
    assert.deepEqual(
      Object.keys(candidate).sort(),
      Object.keys(original).sort(),
    );
    record.variants.push({
      variant: "direct-2",
      ...sizes(direct.code),
      milliseconds: performance.now() - start,
      SHA256: hash(direct.code),
      analysis: names(direct.code),
      exportsPreserved: true,
    });
    console.log(
      JSON.stringify({ profile, variant: "direct-2", ...sizes(direct.code) }),
    );
    results.push(record);
  }
  fs.writeFileSync(
    path.join(out, "sizes.json"),
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        node: process.version,
        terser: JSON.parse(
          fs.readFileSync(path.join(path.dirname(terserPath), "package.json")),
        ).version,
        minifier: (await resolveConfig({ configFile: false }, "build")).build
          .minify,
        results,
      },
      null,
      2,
    ),
  );
}

async function probeClient() {
  const root = process.cwd(),
    require = createRequire(path.join(root, "package.json"));
  const { build } = await import(pathToFileURL(require.resolve("vite")));
  const { minify } = await import(pathToFileURL(toolPath));
  const sizes = (code) => {
    const b = Buffer.from(code);
    return {
      raw: b.length,
      gzip: gzipSync(b, { level: 9 }).length,
      brotli: brotliCompressSync(b, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
      }).length,
    };
  };
  const results = [];
  for (const profile of [
    "notes-minimal",
    "without-all-three",
    "all-execution",
  ]) {
    const entry = path.join(
      root,
      "generated/terser-probe/inputs",
      profile,
      "runtime.js",
    );
    const result = await build({
      configFile: false,
      publicDir: false,
      logLevel: "silent",
      input: entry,
      build: {
        write: false,
        minify: true,
        target: "esnext",
        rolldownOptions: { preserveEntrySignatures: "strict" },
      },
    });
    const chunk = (Array.isArray(result) ? result[0] : result).output.find(
      (c) => c.type === "chunk",
    );
    const original = await import(pathToFileURL(entry));
    const file = path.join(
      root,
      "generated/terser-probe",
      `${profile}-oxc-client.mjs`,
    );
    fs.writeFileSync(file, chunk.code);
    assert.deepEqual(
      Object.keys(await import(pathToFileURL(file))).sort(),
      Object.keys(original).sort(),
    );
    console.log(
      JSON.stringify({ profile, variant: "oxc-client", ...sizes(chunk.code) }),
    );
    results.push({ profile, variant: "oxc-client", ...sizes(chunk.code) });
    const terser = await minify(chunk.code, {
      module: true,
      ecma: 2022,
      compress: { passes: 2 },
      mangle: true,
      format: { preserve_annotations: true },
    });
    fs.writeFileSync(
      path.join(
        root,
        "generated/terser-probe",
        `${profile}-oxc-client-terser-2.mjs`,
      ),
      terser.code,
    );
    results.push({
      profile,
      variant: "oxc-client-terser-2",
      ...sizes(terser.code),
    });
    console.log(JSON.stringify(results.at(-1)));
  }
  if (fs.existsSync("dist/lite/assets")) {
    const worker = fs
      .readdirSync("dist/lite/assets")
      .find((x) => /^aot-worker.*\.js$/.test(x));
    const code = fs.readFileSync(path.join("dist/lite/assets", worker), "utf8");
    results.push({
      profile: "production-aot-worker",
      variant: "baseline",
      path: path.join("dist/lite/assets", worker),
      ...sizes(code),
    });
    for (const passes of [1, 2, 3]) {
      const r = await minify(code, {
        module: true,
        ecma: 2022,
        compress: { passes },
        mangle: true,
        format: { preserve_annotations: true },
      });
      fs.writeFileSync(
        path.join(
          root,
          "generated/terser-probe",
          `production-aot-worker-terser-${passes}.mjs`,
        ),
        r.code,
      );
      results.push({
        profile: "production-aot-worker",
        variant: `terser-${passes}`,
        ...sizes(r.code),
      });
    }
    console.log(
      JSON.stringify(
        results.filter((x) => x.profile === "production-aot-worker"),
      ),
    );
  }
  fs.writeFileSync(
    "generated/terser-probe/final-sizes.json",
    JSON.stringify(results, null, 2),
  );
}

async function probeProperties() {
  const properties = [
    "capacity_mask",
    "decimal_point",
    "mantissa_bits",
    "exponent_bits",
    "method_table",
    "window_values",
    "primary_indexes",
    "declaration_sources",
    "failed_statement",
    "prior_changes",
  ];
  const privatePattern = new RegExp(
    `^(?:_M.*|_[0-9]+|\\$tag|${properties.join("|")})$`,
  );
  const sizes = (code) => {
    const b = Buffer.from(code);
    return {
      raw: b.length,
      gzip: gzipSync(b, { level: 9 }).length,
      brotli: brotliCompressSync(b, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
      }).length,
    };
  };
  const results = [];
  for (const profile of [
    "notes-minimal",
    "without-all-three",
    "all-execution",
  ]) {
    const code = fs.readFileSync(
      `generated/terser-probe/${profile}-baseline.mjs`,
      "utf8",
    );
    const cache = {};
    const result = await minify(code, {
      module: true,
      ecma: 2022,
      compress: { passes: 2 },
      mangle: { properties: { regex: privatePattern, keep_quoted: true } },
      format: { preserve_annotations: true },
      nameCache: cache,
    });
    assert.ok(result.code);
    fs.writeFileSync(
      `generated/terser-probe/${profile}-private-properties.mjs`,
      result.code,
    );
    results.push({
      profile,
      variant: "private-properties",
      ...sizes(result.code),
      propertyMap: cache.props?.props,
      allowlist: properties,
    });
    console.log(JSON.stringify(results.at(-1)));
  }
  fs.writeFileSync(
    "generated/terser-probe/properties-sizes.json",
    JSON.stringify(results, null, 2),
  );
}

async function verify() {
  const root = process.cwd();
  const imp = (p) => import(pathToFileURL(path.resolve(root, p)));
  const compiler = await imp(
    "_build/js/release/build/mizchi/sqlike/compiler/compiler.js",
  );
  const { parseLogicTest, verifyLogicResult } = await imp(
    "tests/compatibility/sqllogictest.ts",
  );
  const { aotBindings, aotValue } = await imp("src/aot-values.ts");
  const profiles = ["notes-minimal", "without-all-three", "all-execution"];
  const variants = [
    "baseline",
    "whitespace-only",
    "identifiers-only",
    "compress-1",
    "compress-2",
    "compress-3",
    "generated-properties",
    "private-properties",
    "direct-2",
    "oxc-client",
    "oxc-client-terser-2",
  ];
  const results = [];
  const checked = (text) => {
    const value = JSON.parse(text);
    assert.equal(value.error, undefined);
    return value;
  };
  const catalog = (source) => {
    const artifact = compiler.compile_program(JSON.stringify(source));
    checked(artifact);
    const p = compiler.pack_program_binary(artifact);
    checked(compiler.binary_catalog_info(p));
    return [
      compiler.binary_catalog_schema(p),
      compiler.binary_catalog_statements(p),
    ];
  };
  const open = (core, def, image = new Uint8Array()) => {
    const db = core.defined_open(...def, image);
    checked(core.defined_info(db));
    return db;
  };
  const exec = (core, db, name, params = []) =>
    checked(core.defined_execute(db, name, aotBindings(params)));
  const snapshot = (core, db) => {
    const r = core.defined_snapshot(db);
    checked(core.binary_info(r));
    return core.binary_data(r);
  };
  const text = fs.readFileSync(
    "tests/fixtures/sqllogictest/select1.test",
    "utf8",
  );
  assert.equal(
    createHash("sha256").update(text).digest("hex"),
    JSON.parse(fs.readFileSync("tests/fixtures/sqllogictest/upstream.json"))
      .sha256,
  );
  const records = parseLogicTest(text),
    statements = records.filter((r) => r.kind === "statement"),
    queries = records.filter((r) => r.kind === "query");
  assert.equal(queries.length, 1000);
  const schema = statements.filter((s) => /^CREATE TABLE /i.test(s.sql)),
    seeds = statements.filter((s) => !schema.includes(s));
  const native = new DatabaseSync(":memory:");
  for (const s of statements) native.exec(s.sql);
  const expected = queries.map((q) => {
    const s = native.prepare(q.sql);
    s.setReadBigInts(true);
    s.setReturnArrays(true);
    const rows = s.all();
    verifyLogicResult(q, rows);
    return rows;
  });
  native.close();
  const batches = [];
  for (let offset = 0; offset < queries.length; offset += 100) {
    const batch = queries.slice(offset, offset + 100);
    batches.push({
      offset,
      batch,
      def: catalog({
        schema: schema.map((s) => s.sql),
        queries: [
          ...seeds.map((s, i) => ({ name: `seed${i}`, sql: s.sql })),
          ...batch.map((q, i) => ({ name: `q${i}`, sql: q.sql })),
        ],
      }),
    });
  }
  const plain = catalog({
    schema: ["CREATE TABLE t(id INTEGER PRIMARY KEY,r REAL,b BLOB,v TEXT)"],
    queries: [
      { name: "put", sql: "INSERT INTO t VALUES(?,?,?,?) RETURNING *" },
      { name: "get", sql: "SELECT * FROM t ORDER BY id" },
      { name: "update", sql: "UPDATE t SET v=? WHERE id=? RETURNING id,v" },
      { name: "begin", sql: "BEGIN" },
      { name: "commit", sql: "COMMIT" },
      { name: "rollback", sql: "ROLLBACK" },
      {
        name: "cast",
        sql: "SELECT CAST('9007199254740993' AS INTEGER),CAST('12.5' AS REAL),1.0/0.0",
      },
    ],
  });
  const optional = catalog({
    schema: [
      "CREATE TABLE p(id INTEGER PRIMARY KEY) STRICT",
      "CREATE TABLE c(id INTEGER PRIMARY KEY,p INTEGER REFERENCES p(id),v TEXT CHECK(json_valid(v)),ts TEXT DEFAULT CURRENT_TIMESTAMP)",
      "CREATE TABLE audit(id INTEGER)",
      "CREATE TRIGGER tr AFTER INSERT ON c BEGIN INSERT INTO audit VALUES(NEW.id); END",
      "CREATE VIEW vv AS SELECT id,json_extract(v,'$.n') AS n FROM c",
    ],
    queries: [
      { name: "p", sql: "INSERT INTO p VALUES(?)" },
      { name: "c", sql: "INSERT INTO c(id,p,v) VALUES(?,?,?) RETURNING *" },
      { name: "get", sql: "SELECT * FROM vv ORDER BY id" },
      { name: "audit", sql: "SELECT id FROM audit ORDER BY id" },
      {
        name: "date",
        sql: "SELECT date('2000-02-28','+1 day'),strftime('%Y','2000-02-28')",
      },
      {
        name: "window",
        sql: "SELECT id,lag(id) OVER (ORDER BY id),sum(id) OVER (ORDER BY id) FROM c ORDER BY id",
      },
    ],
  });
  for (const profile of profiles) {
    const original = await imp(
      `generated/terser-probe/inputs/${profile}/runtime.js`,
    );
    const originalDB = open(original, plain);
    exec(original, originalDB, "put", [
      9007199254740993n,
      -0,
      new Uint8Array([0, 255, 0]),
      "\ufeffa\0b",
    ]);
    const expectedSnapshot = snapshot(original, originalDB);
    let optionalExpected;
    if (profile === "all-execution") {
      const d = open(original, optional);
      checked(original.defined_set_clock(d, "946684800000"));
      exec(original, d, "p", [1n]);
      exec(original, d, "c", [1n, 1n, '{"n":9007199254740993}']);
      exec(original, d, "c", [2n, 1n, '{"n":2}']);
      optionalExpected = {
        image: snapshot(original, d),
        rows: Object.fromEntries(
          ["get", "audit", "date", "window"].map((n) => [
            n,
            exec(original, d, n),
          ]),
        ),
      };
      optionalExpected.fkError = JSON.parse(
        original.defined_execute(d, "c", aotBindings([3n, 99n, "{}"])),
      );
      assert.ok(optionalExpected.fkError.error);
      optionalExpected.afterFK = snapshot(original, d);
    }
    for (const variant of variants) {
      const file = `generated/terser-probe/${profile}-${variant}.mjs`;
      const core = await imp(file);
      assert.deepEqual(Object.keys(core).sort(), Object.keys(original).sort());
      const d = open(core, plain);
      exec(core, d, "put", [
        9007199254740993n,
        -0,
        new Uint8Array([0, 255, 0]),
        "\ufeffa\0b",
      ]);
      assert.deepEqual(snapshot(core, d), expectedSnapshot);
      const before = snapshot(core, d);
      const rejected = JSON.parse(
        core.defined_execute(
          d,
          "put",
          aotBindings([9007199254740993n, 3, new Uint8Array(), "duplicate"]),
        ),
      );
      assert.ok(rejected.error);
      assert.deepEqual(snapshot(core, d), before);
      exec(core, d, "begin");
      exec(core, d, "update", ["rollback", 9007199254740993n]);
      exec(core, d, "rollback");
      assert.deepEqual(exec(core, d, "get"), exec(original, originalDB, "get"));
      const restored = open(core, plain, expectedSnapshot);
      assert.deepEqual(
        exec(core, restored, "get"),
        exec(original, originalDB, "get"),
      );
      assert.deepEqual(
        exec(core, d, "cast"),
        exec(original, originalDB, "cast"),
      );
      const beforeCorruption = snapshot(core, d);
      const corrupt = expectedSnapshot.slice();
      corrupt[corrupt.length - 1] ^= 1;
      assert.ok(JSON.parse(core.defined_restore(d, corrupt)).error);
      assert.deepEqual(snapshot(core, d), beforeCorruption);
      for (const { offset, batch, def } of batches) {
        const db = open(core, def);
        seeds.forEach((s, i) => exec(core, db, `seed${i}`));
        for (let i = 0; i < batch.length; i++) {
          const rows = exec(core, db, `q${i}`).rows.map((row) =>
            row.map(aotValue),
          );
          assert.deepEqual(
            rows,
            expected[offset + i],
            `${profile}/${variant}: ${batch[i].sql}`,
          );
          verifyLogicResult(batch[i], rows);
        }
      }
      if (optionalExpected) {
        const db = open(core, optional);
        checked(core.defined_set_clock(db, "946684800000"));
        exec(core, db, "p", [1n]);
        exec(core, db, "c", [1n, 1n, '{"n":9007199254740993}']);
        exec(core, db, "c", [2n, 1n, '{"n":2}']);
        assert.deepEqual(snapshot(core, db), optionalExpected.image);
        for (const name of ["get", "audit", "date", "window"])
          assert.deepEqual(exec(core, db, name), optionalExpected.rows[name]);
        assert.deepEqual(
          JSON.parse(
            core.defined_execute(db, "c", aotBindings([3n, 99n, "{}"])),
          ),
          optionalExpected.fkError,
        );
        assert.deepEqual(snapshot(core, db), optionalExpected.afterFK);
      }
      const code = fs.readFileSync(file);
      const record = {
        profile,
        variant,
        queries: 1000,
        exportsPreserved: true,
        snapshotBytesPreserved: true,
        typedValues: true,
        failedWriteRollback: true,
        corruptionRejected: true,
        optionalFeatures: !!optionalExpected,
        SHA256: createHash("sha256").update(code).digest("hex"),
        verified: true,
      };
      results.push(record);
      console.log(JSON.stringify(record));
    }
  }
  fs.writeFileSync(
    "generated/terser-probe/verification.json",
    JSON.stringify(
      {
        verified: true,
        method:
          "Each profile/variant: 1000 original upstream queries against native node:sqlite, exact exported names and binary snapshot bytes against unminified engine, Int64/negative zero/BLOB/BOM/NUL, duplicate PK/transaction rollback/corrupt snapshot; full profile also JSON/date/window/STRICT/FK/trigger/default timestamp.",
        results,
      },
      null,
      2,
    ),
  );
}

await probeSizes();
await probeClient();
await probeProperties();
await verify();
const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const sizes = read("generated/terser-probe/sizes.json");
const client = read("generated/terser-probe/final-sizes.json");
const props = read("generated/terser-probe/properties-sizes.json");
const verified = read("generated/terser-probe/verification.json");
const { sourceHashes, engineSourcePaths } = await import(
  pathToFileURL(path.join(root, "scripts/measurement-manifest.ts"))
);
const report = {
  format: 1,
  measuredAt: new Date().toISOString(),
  node: process.version,
  terser: sizes.terser,
  minifier: sizes.minifier,
  method:
    "Same binary core exports retained. Historical baseline is Vite ES library mode with whitespace retained. Oxc client keeps the same exports with preserveEntrySignatures=strict; Terser uses module=true, ecma=2022, unsafe defaults=false and preserve_annotations=true. gzip9/Brotli11 per core. No host/catalog/persistence or application total. 33 core variants each run the original 1000 queries against native SQLite; additional typed/persistence/optional-feature checks compare the unminified core. Existing production Worker is size-only if available. Experimental only: production configuration and dependencies are unchanged. No timing/speed guarantee or universal equivalence claim.",
  references: [
    "https://vite.dev/config/build-options.html#build-minify",
    "https://terser.org/docs/options/",
    "https://terser.org/docs/api-reference/",
  ],
  sourceHashes: sourceHashes([
    ...engineSourcePaths(),
    "measurements/minification-probe.mjs",
    "scripts/build-sqlike-runtime.ts",
    "scripts/oxc-runtime.ts",
    "scripts/sqlike-runtime-declarations.ts",
    "src/sqlike-features.ts",
    "src/aot-values.ts",
    "tests/compatibility/sqllogictest.ts",
    "tests/fixtures/sqllogictest/select1.test",
    "tests/fixtures/sqllogictest/upstream.json",
    "_build/js/release/build/mizchi/sqlike/compiler/compiler.js",
  ]),
  results: sizes.results,
  client,
  properties: props,
  verification: verified,
};
fs.writeFileSync(
  "measurements/minification-current.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  "Verified minification report: measurements/minification-current.json",
);
