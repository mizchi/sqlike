import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
const files = (await readdir("dist", { recursive: true, withFileTypes: true }))
  .filter((e) => e.isFile() && e.name !== "sw.js")
  .map((e) => `${e.parentPath}/${e.name}`.replace(/^dist/, ""));
const hash = createHash("sha256");
const manifest = JSON.parse(await readFile("dist/.vite/manifest.json", "utf8"));
for (const file of files) hash.update(await readFile(`dist${file}`));
const version = hash.digest("hex").slice(0, 16);
for (const [entry, root, script, family] of [
  ["index.html", "/", "dist/sw.js", "browser-litestream-main-"],
  ["lite/index.html", "/lite/", "dist/lite/sw.js", "browser-litestream-lite-"],
]) {
  if (!manifest[entry]) continue;
  const precache = new Set([root, `/${entry}`]);
  function seed(key) {
    const asset = manifest[key];
    if (!asset || precache.has(`/${asset.file}`)) return;
    precache.add(`/${asset.file}`);
    for (const file of [...(asset.css ?? []), ...(asset.assets ?? [])])
      precache.add(`/${file}`);
    for (const dependency of asset.imports ?? []) seed(dependency);
  }
  // The HTML URL must already be cached, but its imports still need traversing.
  const html = manifest[entry];
  precache.add(`/${html.file}`);
  for (const file of [...(html.css ?? []), ...(html.assets ?? [])])
    precache.add(`/${file}`);
  for (const dependency of html.imports ?? []) seed(dependency);
  // Vite emits the page's entry JS directly on the HTML manifest record.
  if (html.file.endsWith(".js")) precache.add(`/${html.file}`);
  const cache = family + version;
  await mkdir(script.slice(0, script.lastIndexOf("/")), { recursive: true });
  await writeFile(
    script,
    `const CACHE=${JSON.stringify(cache)};\nconst FAMILY=${JSON.stringify(family)};\nconst FILES=${JSON.stringify([...precache])};
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith(FAMILY)&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
 const url=new URL(e.request.url);
 if(e.request.method!=='GET'||url.origin!==self.location.origin||/^\\/(api|do-api|relay|do-relay|aot-ltx|do-aot-ltx)\\//.test(url.pathname))return;
 e.respondWith(caches.open(CACHE).then(async c=>{
  const hit=await c.match(e.request,{ignoreSearch:e.request.mode==='navigate',ignoreVary:true});if(hit)return hit;
  const response=await fetch(e.request);if(response.ok)await c.put(e.request,response.clone());return response;
 }));
});\n`,
  );
}
