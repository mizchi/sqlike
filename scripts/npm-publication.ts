import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Publication {
  name: string;
  version: string;
  repository: string;
  integrity: string;
}
export interface RegistryPackage {
  name: string;
  repository: { url: string };
  versions: string[];
  integrity?: string;
}
export function publicationAction(expected: Publication, registry?: RegistryPackage, verifyContents?: () => void): "publish" | "skip" {
  if (!registry) return "publish";
  assert.equal(registry.name, expected.name);
  assert.equal(registry.repository?.url, expected.repository, "npm repository differs");
  if (!registry.versions.includes(expected.version)) return "publish";
  if (registry.integrity !== expected.integrity) {
    assert.ok(verifyContents, "published npm integrity differs; inspect all package contents before skipping");
    verifyContents();
  }
  return "skip";
}

export function assertPackageContents(expected: ReadonlyMap<string, Buffer>, actual: ReadonlyMap<string, Buffer>): void {
  assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort(), "published package files differ");
  assert.ok(expected.has("package/package.json"), "package manifest missing");
  for (const [name, bytes] of expected) {
    const published = actual.get(name)!;
    if (name === "package/package.json")
      assert.deepEqual(JSON.parse(published.toString("utf8")), JSON.parse(bytes.toString("utf8")), "published manifest differs");
    else assert.ok(bytes.equals(published), `published contents differ: ${name}`);
  }
}

function archiveContents(path: string): Map<string, Buffer> {
  const run = (args: string[]) => execFileSync("tar", args, { maxBuffer: 32 * 1024 * 1024 });
  const types = run(["-tvzf", path]).toString("utf8").trim().split("\n");
  assert.ok(types.every((line) => /^[d-]/.test(line)), "package must contain regular files or directories only");
  const paths = run(["-tzf", path]).toString("utf8").trim().split("\n");
  assert.equal(new Set(paths).size, paths.length, "duplicate archive paths");
  assert.ok(paths.every((name) => name.startsWith("package/") && !name.includes("\\") && !name.split("/").includes("..")), "invalid archive paths");
  return new Map(paths.filter((name) => !name.endsWith("/")).map((name) => [name, run(["-xOzf", path, name])]));
}

/** Check registry SRI first, then allow only manifest formatting and archive metadata changes. */
export function verifyPublishedArchive(localTarball: string, name: string, version: string, integrity: string): void {
  assert.match(integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
  const dir = mkdtempSync(join(tmpdir(), "sqlike-published-"));
  try {
    const output = JSON.parse(execFileSync("npm", ["pack", `${name}@${version}`, "--ignore-scripts", "--json", "--pack-destination", dir], {
      encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, npm_config_userconfig: "/dev/null" },
    }));
    const filename: string = output[0].filename;
    assert.ok(filename && !filename.includes("/") && !filename.includes("\\"));
    const published = join(dir, filename);
    assert.equal("sha512-" + createHash("sha512").update(readFileSync(published)).digest("base64"), integrity, "registry tarball integrity differs");
    assertPackageContents(archiveContents(localTarball), archiveContents(published));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export function publicationMode(args: string[], env: NodeJS.ProcessEnv): "local" | "oidc" {
  if (args.length === 0) return "local";
  assert.deepEqual(args, ["--oidc"], "unknown publish arguments");
  assert.equal(env.GITHUB_ACTIONS, "true", "OIDC requires GitHub Actions");
  assert.equal(env.GITHUB_REPOSITORY, "mizchi/sqlike", "unexpected OIDC repository");
  assert.equal(env.GITHUB_EVENT_NAME, "push", "OIDC requires a tag push");
  assert.match(env.GITHUB_REF ?? "", /^refs\/tags\/v\d/, "OIDC requires a release tag");
  assert.ok(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, "id-token: write is required");
  const url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL ?? "");
  assert.equal(url.protocol, "https:", "OIDC request requires HTTPS");
  assert.ok(!env.NPM_TOKEN && !env.NODE_AUTH_TOKEN, "remove npm tokens before OIDC publishing");
  return "oidc";
}

export function releaseVersion(tag: string, version: string, packages: { name: string; version: string }[]): string {
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/, "invalid release version");
  assert.equal(tag, `v${version}`, "release tag and workspace version differ");
  assert.deepEqual(packages.map((p) => p.name).sort(), ["@mizchi/litestream", "@mizchi/sqlike"], "unexpected release packages");
  for (const pkg of packages) assert.equal(pkg.version, version, `${pkg.name} version differs`);
  return version;
}
