import assert from "node:assert/strict";

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
export function publicationAction(expected: Publication, registry?: RegistryPackage): "publish" | "skip" {
  if (!registry) return "publish";
  assert.equal(registry.name, expected.name);
  assert.equal(registry.repository?.url, expected.repository, "npm repository differs");
  if (!registry.versions.includes(expected.version)) return "publish";
  assert.equal(registry.integrity, expected.integrity, "published npm integrity differs; never overwrite or silently skip");
  return "skip";
}
