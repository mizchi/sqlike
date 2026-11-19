import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

// Build-only tooling; never linked into the JS/Wasm database runtime.
const revision = "dd8c9ebab659cf5cd039342704e42aca88b2b34a";
const repository = "https://github.com/moonbitlang/tree-sitter-moonbit.git";
const root = resolve(import.meta.dirname, "..");
const directory = resolve(root, ".jev-lint/parsers");
const source = resolve(directory, "tree-sitter-moonbit");
const output = resolve(directory, "moonbit.so");
const stamp = resolve(directory, "moonbit.json");
const identity = JSON.stringify({
  revision,
  platform: process.platform,
  arch: process.arch,
  build: 1,
});

if (!["darwin", "linux"].includes(process.platform))
  throw Error(
    "jev-lint parser setup supports macOS and Linux; configure a native MoonBit parser for this platform",
  );

if (
  existsSync(output) &&
  existsSync(stamp) &&
  readFileSync(stamp, "utf8") === identity
) {
  console.log("jev-lint MoonBit parser is ready");
} else {
  const run = (command: string, args: string[], cwd = root) =>
    execFileSync(command, args, { cwd, stdio: "inherit", timeout: 120_000 });
  mkdirSync(source, { recursive: true });
  if (!existsSync(resolve(source, ".git"))) {
    run("git", ["init", "--quiet"], source);
    run("git", ["remote", "add", "origin", repository], source);
  }
  // Always fetch the pinned repository/revision when rebuilding, never a moving branch.
  run(
    "git",
    ["fetch", "--quiet", "--depth", "1", repository, revision],
    source,
  );
  run("git", ["checkout", "--quiet", "--detach", revision], source);
  const temporary = `${output}.tmp`;
  try {
    run(
      process.env.CC ?? "cc",
      [
        "-shared",
        "-fPIC",
        "-O2",
        "-std=c11",
        "-I",
        "src",
        "src/parser.c",
        "src/scanner.c",
        "-o",
        temporary,
      ],
      source,
    );
    renameSync(temporary, output);
    writeFileSync(stamp, identity);
  } finally {
    rmSync(temporary, { force: true });
  }
  console.log(`built jev-lint MoonBit parser (${revision})`);
}
