import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = process.cwd();
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const version: string = pkg.version;
assert.match(version, /^\d+\.\d+\.\d+$/);
assert.equal(pkg.private, true, "the root npm package is a private test/demo host");
assert.equal(pkg.license, "MIT");
assert.equal(pkg.repository.url, "git+https://github.com/mizchi/sqlike.git");
const example = readFileSync("examples/aot/moon.mod", "utf8");
assert.ok(example.includes(`version = "${version}"`));
const checksums: string[] = [];
const temp = mkdtempSync(join(tmpdir(), "browser-litestream-release-"));
try {
  const directories: Record<string, string> = {};
  for (const name of ["sqlike", "litestream"]) {
    assert.ok(example.includes(`"mizchi/${name}@${version}"`));
    const manifest = readFileSync(`packages/${name}/moon.mod`, "utf8");
    assert.ok(manifest.includes(`name = "mizchi/${name}"`));
    assert.ok(manifest.includes(`version = "${version}"`));
    assert.match(manifest, /^license = "MIT"$/m);
    assert.match(manifest, /^repository = "https:\/\/github\.com\/mizchi\/sqlike"$/m);
    const filename = `mizchi-${name}-${version}.zip`;
    const archive = resolve("_build/publish", filename);
    const entries = execFileSync("unzip", ["-Z1", archive], { encoding: "utf8" })
      .trim().split("\n");
    for (const required of ["moon.mod", "README.md", "LICENSE", "src/moon.pkg"]) {
      assert.ok(entries.includes(required), `${filename}: missing ${required}`);
    }
    for (const entry of entries) {
      assert.ok(!entry.startsWith("/") && !entry.split("/").includes(".."), entry);
      assert.ok(!/(^|\/)(_build|node_modules|\.mooncakes|\.git|\.wrangler)(\/|$)/.test(entry), entry);
    }
    assert.equal(execFileSync("unzip", ["-p", archive, "moon.mod"], { encoding: "utf8" }), manifest);
    assert.equal(
      execFileSync("unzip", ["-p", archive, "README.md"], { encoding: "utf8" }),
      readFileSync(`packages/${name}/README.md`, "utf8"),
    );
    const license = readFileSync("LICENSE", "utf8");
    assert.equal(readFileSync(`packages/${name}/LICENSE`, "utf8"), license);
    assert.equal(execFileSync("unzip", ["-p", archive, "LICENSE"], { encoding: "utf8" }), license);
    const directory = join(temp, name);
    execFileSync("unzip", ["-q", archive, "-d", directory]);
    directories[name] = directory;
    checksums.push(`${createHash("sha256").update(readFileSync(archive)).digest("hex")}  ${filename}`);
    console.log(`${filename}: ${entries.length} files, metadata and license verified`);
  }
  execFileSync(process.execPath, ["--import", "tsx", "--test", "tests/workspace.test.ts"], {
    cwd: root,
    env: { ...process.env, SQLIKE_MODULE_DIR: directories.sqlike, LITESTREAM_MODULE_DIR: directories.litestream, RELEASE_PACK_TARGETS: "js,wasm-gc" },
    stdio: "inherit",
    timeout: 180000,
  });
  writeFileSync("_build/publish/SHA256SUMS", `${checksums.join("\n")}\n`);
  console.log(`v${version}: both dry-run archives passed external JS / Wasm GC consumers`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
