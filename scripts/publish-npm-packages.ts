import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { publicationAction, publicationMode, releaseVersion, verifyPublishedArchive, type RegistryPackage } from "./npm-publication.ts";

const audit = JSON.parse(readFileSync("generated/npm/audit.json", "utf8"));
assert.equal(audit.version, JSON.parse(readFileSync("package.json", "utf8")).version);
const mode = publicationMode(process.argv.slice(2), process.env);
if (mode === "oidc") releaseVersion(process.env.GITHUB_REF_NAME ?? "", audit.version,
  ["sqlike", "litestream"].map((name) => JSON.parse(readFileSync(`npm/${name}/package.json`, "utf8"))));
else {
  const owner = execFileSync("npm", ["whoami"], { encoding: "utf8" }).trim();
  assert.equal(owner, "mizchi", "authenticate the owner of the @mizchi scope first");
}
for (const pkg of audit.packages) {
  assert.ok(["@mizchi/sqlike", "@mizchi/litestream"].includes(pkg.name));
  // Do not retry a package that was already accepted during a partial release.
  let registry: RegistryPackage | undefined;
  try {
    registry = JSON.parse(execFileSync("npm", ["view", pkg.name, "name", "versions", "repository", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  } catch (error) {
    const response = JSON.parse((error as { stdout?: string }).stdout ?? "{}");
    if (response.error?.code !== "E404") throw error;
  }
  if (registry?.versions.includes(audit.version))
    registry.integrity = JSON.parse(execFileSync("npm", ["view", `${pkg.name}@${audit.version}`, "dist.integrity", "--json"], { encoding: "utf8" }));
  const integrity = "sha512-" + createHash("sha512").update(readFileSync(pkg.tarball)).digest("base64");
  if (publicationAction({ name: pkg.name, version: audit.version, repository: "git+https://github.com/mizchi/sqlike.git", integrity }, registry,
    () => verifyPublishedArchive(resolve(pkg.tarball), pkg.name, audit.version, registry!.integrity!)) === "skip") {
    console.log(`${pkg.name}@${audit.version}: already published`);
    continue;
  }
  execFileSync("npm", ["publish", resolve(pkg.tarball), "--access", "public", "--tag", audit.version.includes("-") ? "next" : "latest"], { stdio: "inherit" });
}
