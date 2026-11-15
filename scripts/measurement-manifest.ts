import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
export const fileHash = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
export function sourceHashes(paths: string[]) {
  return Object.fromEntries(
    [
      ...new Set([
        "scripts/measurement-manifest.ts",
        "package.json",
        "pnpm-lock.yaml",
        ...paths,
      ]),
    ]
      .sort()
      .map((p) => [p, fileHash(p)]),
  );
}
export function engineSourcePaths() {
  return ["packages/sqlike", "packages/litestream", "examples/aot"]
    .flatMap((dir) =>
      readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter(
          (e) =>
            e.isFile() &&
            (e.name.endsWith(".mbt") ||
              ["moon.mod", "moon.pkg"].includes(e.name)),
        )
        .map((e) => `${e.parentPath}/${e.name}`),
    )
    .filter((p) => !p.includes("/.mooncakes/") && !p.includes("/_build/"))
    .sort();
}
export function assertFileHashes(
  entries: Record<string, string>,
  read: (path: string) => string = fileHash,
) {
  const keys = Object.keys(entries);
  if (!keys.length) throw Error("missing source/artifact hashes");
  for (const path of keys) {
    if (!/^[0-9a-f]{64}$/.test(entries[path]!) || read(path) !== entries[path])
      throw Error(`stale source/artifact: ${path}`);
  }
}
