import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";

const paths = [
  "lang.html",
  "lang_corefunc.html",
  "lang_aggfunc.html",
  "lang_datefunc.html",
  "lang_mathfunc.html",
  "windowfunctions.html",
  "json1.html",
  "pragma.html",
  "c3ref/funclist.html",
  "c3ref/objlist.html",
  "c3ref/constlist.html",
  "docs.html",
  "testing.html",
];
const cache = process.argv.find((a) => a.startsWith("--cache="))?.slice(8);
const pages = new Map<string, string>();
const sources = [];
for (const path of paths) {
  const url = `https://www.sqlite.org/${path}`;
  const body = cache
    ? await readFile(`${cache}/${path.replaceAll("/", "-")}`, "utf8")
    : await fetch(url).then((r) => {
        if (!r.ok) throw Error(`${url}: ${r.status}`);
        return r.text();
      });
  if (!body.includes("SQLite")) throw Error(`Unexpected source: ${url}`);
  pages.set(path, body);
  sources.push({
    url,
    sha256: createHash("sha256").update(body).digest("hex"),
    bytes: Buffer.byteLength(body),
  });
}
function text(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&")
    .replaceAll("&nbsp;", " ")
    .trim();
}
function section(path: string, start: string, end: string): string {
  const body = pages.get(path)!;
  const a = body.indexOf(start),
    b = body.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw Error(`Section drift: ${path}`);
  return body.slice(a, b);
}
function anchors(body: string) {
  return [
    ...body.matchAll(/<a\b[^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/g),
  ].map((m) => ({
    href: m[1]!,
    title: text(m[2]!),
    listLink: /class=['"]sh_link['"]/.test(m[0]),
  }));
}
const entries: { category: string; name: string; source: string }[] = [];
function add(category: string, name: string, path: string, href = path) {
  entries.push({
    category,
    name,
    source: new URL(href, `https://www.sqlite.org/${path}`).href,
  });
}
for (const a of anchors(section("lang.html", "<div class='columns'", "</div>")))
  add("language", a.title, "lang.html", a.href);
for (const [category, path, start, end] of [
  [
    "scalar",
    "lang_corefunc.html",
    'id="list_of_core_functions"',
    'id="descriptions_of_built_in_scalar_sql_functions"',
  ],
  [
    "aggregate",
    "lang_aggfunc.html",
    'id="list_of_built_in_aggregate_functions"',
    'id="descriptions_of_built_in_aggregate_functions"',
  ],
  [
    "math",
    "lang_mathfunc.html",
    'id="overview"',
    'id="descriptions_of_built_in_scalar_sql_math_functions"',
  ],
] as const)
  for (const a of anchors(section(path, start, end)).filter((a) =>
    a.title.includes("("),
  ))
    add(category, a.title, path, a.href);
for (const a of anchors(
  section("pragma.html", "<h2>List Of PRAGMAs", "</div>"),
))
  add("pragma", a.href.split("pragma_")[1]!, "pragma.html", a.href);
for (const item of section("lang_datefunc.html", "<ol>", "</ol>").matchAll(
  /<li>([\s\S]*?)<\/li>/g,
))
  add("date", text(item[1]!).replaceAll(" ", ""), "lang_datefunc.html");
for (const item of section(
  "windowfunctions.html",
  'id="built_in_window_functions"',
  'id="window_chaining"',
).matchAll(/<dt><p><b>([\s\S]*?)<\/b>/g))
  for (const signature of item[1]!.split("<br>"))
    add("window", text(signature), "windowfunctions.html");
for (const a of anchors(
  section("json1.html", 'id="overview"', 'id="compiling_in_json_support"'),
).filter((a) => /^(json\w*|->>?)$/.test(a.title)))
  add("json", a.title, "json1.html", a.href);
for (const [category, path, pattern] of [
  ["api-function", "c3ref/funclist.html", /^sqlite3_\w+$/],
  ["api-object", "c3ref/objlist.html", /^sqlite\w+$/],
  ["api-constant", "c3ref/constlist.html", /^SQLITE_\w+$/],
] as const) {
  const body = section(path, "<div class='columns'", "</div>");
  for (const item of body.matchAll(/<li>([\s\S]*?)<\/li>/g)) {
    const name = text(item[1]!).replace(/\s*\(exp\)$/, "");
    if (pattern.test(name))
      add(
        category,
        name,
        path,
        anchors(item[1]!)[0]?.href ?? path.split("/").at(-1)!,
      );
  }
}
for (const a of anchors(
  section("docs.html", "> Extensions</a>", "id='sh_mark_6'"),
).filter((a) => a.listLink))
  add("extension", a.title, "docs.html", a.href);
const unique = [
  ...new Map(entries.map((e) => [`${e.category}/${e.name}`, e])).values(),
];
const counts = Object.fromEntries(
  [...new Set(unique.map((e) => e.category))].map((c) => [
    c,
    unique.filter((e) => e.category === c).length,
  ]),
);
for (const [category, count] of Object.entries(counts))
  if (count < 5) throw Error(`Incomplete catalog ${category}: ${count}`);
await mkdir("tests/fixtures/sqlite-catalog", { recursive: true });
await writeFile(
  "tests/fixtures/sqlite-catalog/catalog.json",
  JSON.stringify(
    {
      format: 1,
      retrievedAt: new Date().toISOString(),
      scope:
        "Entry-point inventory from official indexes; not an exhaustive list of behavioral requirements or SQL combinations",
      sources,
      counts,
      entries: unique,
    },
    null,
    2,
  ) + "\n",
);
console.log(counts);
