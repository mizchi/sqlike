import { test } from "node:test";
import assert from "node:assert/strict";
import { publicationAction } from "../scripts/npm-publication.ts";

const expected = { name: "@mizchi/sqlike", version: "0.1.0", repository: "git+https://github.com/mizchi/sqlike.git", integrity: "sha512-exact" };
test("npm publication accepts an absent package or an identical retry only", () => {
  assert.equal(publicationAction(expected, undefined), "publish");
  const registry = { name: expected.name, repository: { url: expected.repository }, versions: ["0.1.0"], integrity: expected.integrity };
  assert.equal(publicationAction(expected, registry), "skip");
  assert.throws(() => publicationAction(expected, { ...registry, integrity: "sha512-other" }), /integrity/);
  assert.throws(() => publicationAction(expected, { ...registry, repository: { url: "https://github.com/other/project" } }), /repository/);
  assert.equal(publicationAction(expected, { ...registry, versions: ["0.0.1"] }), "publish");
});
