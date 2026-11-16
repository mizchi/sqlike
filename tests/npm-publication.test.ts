import { test } from "node:test";
import assert from "node:assert/strict";
import { assertPackageContents, publicationAction, publicationMode, releaseVersion } from "../scripts/npm-publication.ts";

const expected = { name: "@mizchi/sqlike", version: "0.1.0", repository: "git+https://github.com/mizchi/sqlike.git", integrity: "sha512-exact" };
test("npm publication accepts an absent package or an identical retry only", () => {
  assert.equal(publicationAction(expected, undefined), "publish");
  const registry = { name: expected.name, repository: { url: expected.repository }, versions: ["0.1.0"], integrity: expected.integrity };
  assert.equal(publicationAction(expected, registry), "skip");
  assert.throws(() => publicationAction(expected, { ...registry, integrity: "sha512-other" }), /integrity/);
  let checked = false;
  assert.equal(publicationAction(expected, { ...registry, integrity: "sha512-normalized" }, () => { checked = true; }), "skip");
  assert.ok(checked);
  assert.throws(() => publicationAction(expected, { ...registry, integrity: "sha512-other" }, () => { throw new Error("changed contents"); }), /changed contents/);
  assert.throws(() => publicationAction(expected, { ...registry, repository: { url: "https://github.com/other/project" } }), /repository/);
  assert.equal(publicationAction(expected, { ...registry, versions: ["0.0.1"] }), "publish");
});

test("registry normalization allows JSON formatting only, never changed package contents", () => {
  const files = new Map([
    ["package/package.json", Buffer.from('{"name":"@mizchi/sqlike","version":"0.1.0"}')],
    ["package/dist/index.js", Buffer.from("export const value = 1;")],
  ]);
  const normalized = new Map(files);
  normalized.set("package/package.json", Buffer.from('{\n  "version": "0.1.0", "name": "@mizchi/sqlike"\n}\n'));
  assert.doesNotThrow(() => assertPackageContents(files, normalized));
  normalized.set("package/dist/index.js", Buffer.from("export const value = 2;"));
  assert.throws(() => assertPackageContents(files, normalized), /index.js/);
  normalized.set("package/dist/index.js", files.get("package/dist/index.js")!);
  normalized.set("package/package.json", Buffer.from('{"name":"@mizchi/sqlike","version":"0.2.0"}'));
  assert.throws(() => assertPackageContents(files, normalized), /manifest/);
  normalized.set("package/package.json", files.get("package/package.json")!);
  normalized.delete("package/dist/index.js");
  assert.throws(() => assertPackageContents(files, normalized), /files/);
  normalized.set("package/dist/index.js", files.get("package/dist/index.js")!);
  normalized.set("package/extra.js", Buffer.from("extra"));
  assert.throws(() => assertPackageContents(files, normalized), /files/);
});

test("OIDC publishing requires this repository's tag workflow and no token fallback", () => {
  const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "mizchi/sqlike", GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/tags/v0.1.0", ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.actions.githubusercontent.com/token", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "test-only" };
  assert.equal(publicationMode([], {}), "local");
  assert.equal(publicationMode(["--oidc"], env), "oidc");
  for (const key of Object.keys(env)) assert.throws(() => publicationMode(["--oidc"], { ...env, [key]: "" }));
  assert.throws(() => publicationMode(["--oidc"], { ...env, GITHUB_REPOSITORY: "other/sqlike" }));
  assert.throws(() => publicationMode(["--oidc"], { ...env, GITHUB_REF: "refs/heads/main" }));
  for (const key of ["NPM_TOKEN", "NODE_AUTH_TOKEN"]) assert.throws(() => publicationMode(["--oidc"], { ...env, [key]: "test-only" }));
  assert.throws(() => publicationMode(["--unknown"], env));
});

test("release tag, workspace and public package versions must agree", () => {
  const packages = [{ name: "@mizchi/sqlike", version: "0.1.0" }, { name: "@mizchi/litestream", version: "0.1.0" }];
  assert.equal(releaseVersion("v0.1.0", "0.1.0", packages), "0.1.0");
  assert.equal(releaseVersion("v0.2.0-rc.1", "0.2.0-rc.1", packages.map((p) => ({ ...p, version: "0.2.0-rc.1" }))), "0.2.0-rc.1");
  assert.throws(() => releaseVersion("v0.2.0", "0.1.0", packages));
  assert.throws(() => releaseVersion("v0.1.0", "0.1.0", [{ ...packages[0]!, version: "0.0.1" }, packages[1]!]));
  assert.throws(() => releaseVersion("v0.1.0", "0.1.0", [packages[0]!, packages[0]!]));
  assert.throws(() => releaseVersion("main", "0.1.0", packages));
});
