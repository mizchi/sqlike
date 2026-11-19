import { glob, readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { migrationStatements } from "../src/migration-statements.ts";
import type { CatalogSource, QuerySource } from "../src/aot-contract.ts";
import type { SqlikeAotOptions } from "../src/sqlike-vite-contract.ts";

export const digest = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
export function sqlPatterns(
  value: string | readonly string[] | undefined,
): string[] {
  const patterns =
    value === undefined ? [] : typeof value === "string" ? [value] : [...value];
  for (const p of patterns)
    if (
      typeof p !== "string" ||
      !p ||
      isAbsolute(p) ||
      p.replaceAll("\\", "/").split("/").includes("..") ||
      p.startsWith("!")
    )
      throw Error(
        "SQL patterns must be relative to the Vite root; use exclude for exclusions",
      );
  return patterns.map((p) => p.replaceAll("\\", "/"));
}

/** Headers are recognized only in leading SQL trivia, never inside SQL strings or bodies. */
export function parseQueryFile(file: string, text: string): QuerySource[] {
  try {
    const statements = migrationStatements(text),
      names = new Set<string>();
    return statements.map((sql) => {
      let rest = sql,
        name: string | undefined;
      for (;;) {
        rest = rest.trimStart();
        if (rest.startsWith("--")) {
          const end = rest.indexOf("\n"),
            line = end < 0 ? rest : rest.slice(0, end);
          if (/^--\s*name:/.test(line)) {
            const match =
              /^--\s*name:\s+([A-Za-z_][\w./-]*)(?:\s+:[a-z][a-z0-9]*)?\s*$/.exec(
                line,
              );
            if (!match || name)
              throw Error("ambiguous or invalid -- name: header");
            name = match[1]!;
          }
          rest = end < 0 ? "" : rest.slice(end + 1);
        } else if (rest.startsWith("/*")) {
          rest = rest.slice(rest.indexOf("*/") + 2);
        } else break;
      }
      if (!name && statements.length !== 1)
        throw Error(
          "each statement in a multi-query file needs a -- name: header",
        );
      name ??= basename(file, ".sql");
      if (names.has(name)) throw Error(`duplicate query name ${name}`);
      names.add(name);
      return { name, sql };
    });
  } catch (error) {
    throw Error(`${file}: ${(error as Error).message}`, { cause: error });
  }
}

export async function scanSqlikeCatalog(
  root: string,
  options: SqlikeAotOptions,
) {
  root = resolve(root);
  const exclude = [
    "**/node_modules/**",
    "**/.git/**",
    ...sqlPatterns(options.exclude),
  ];
  const collect = async (patterns: string[]) => {
    const found = new Set<string>();
    for await (const file of glob(patterns, { cwd: root, exclude }))
      if (
        file.toLowerCase().endsWith(".sql") &&
        (await stat(join(root, file))).isFile()
      )
        found.add(resolve(root, file));
    return [...found].sort();
  };
  const schemaPatterns = sqlPatterns(options.schemaFiles);
  const schemaFiles = await collect(schemaPatterns);
  if (schemaPatterns.length && !schemaFiles.length)
    throw Error("no SQL schema files matched schemaFiles");
  const schemaSet = new Set(schemaFiles);
  const queryFiles = (
    await collect(sqlPatterns(options.include ?? "src/client/**/*.sql"))
  ).filter((file) => !schemaSet.has(file));
  const files = [...schemaFiles, ...queryFiles].sort();
  const contents = new Map(
    await Promise.all(
      files.map(async (file) => [file, await readFile(file, "utf8")] as const),
    ),
  );
  const source: CatalogSource = {
    schema: [
      ...(options.schema ?? []),
      ...schemaFiles.flatMap((file) => {
        try {
          return migrationStatements(contents.get(file)!);
        } catch (error) {
          throw Error(`${relative(root, file)}: ${(error as Error).message}`, {
            cause: error,
          });
        }
      }),
    ],
    queries: [],
  };
  const names = new Map<string, string>();
  for (const file of queryFiles)
    for (const q of parseQueryFile(relative(root, file), contents.get(file)!)) {
      const old = names.get(q.name);
      if (old)
        throw Error(
          `duplicate query name ${q.name}: ${old} and ${relative(root, file)}`,
        );
      names.set(q.name, relative(root, file));
      source.queries.push(q);
    }
  if (!source.queries.length) throw Error("no SQL queries matched include");
  return {
    source,
    files,
    fingerprint: digest(
      JSON.stringify({
        source,
        files: files.map((f) => relative(root, f).replaceAll("\\", "/")),
      }),
    ),
  };
}
