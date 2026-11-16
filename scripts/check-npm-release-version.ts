import { readFileSync } from "node:fs";
import { releaseVersion } from "./npm-publication.ts";

const root = JSON.parse(readFileSync("package.json", "utf8"));
const packages = ["sqlike", "litestream"].map((name) => JSON.parse(readFileSync(`npm/${name}/package.json`, "utf8")));
console.log(`npm release: ${releaseVersion(process.argv[2] ?? "", root.version, packages)}`);
