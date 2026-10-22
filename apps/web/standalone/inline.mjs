// Makes dist/verifier.html at the repo root: the built page with its script and stylesheet inside
// it, one file. Another build's: node standalone/inline.mjs <its build folder> <file name>.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const [folder, name = "verifier.html"] = process.argv.slice(2);
const built = folder
  ? pathToFileURL(`${folder.replace(/\/$/, "")}/`)
  : new URL("./dist/", import.meta.url);
const out = new URL("../../../dist/", import.meta.url);
let html = readFileSync(new URL("index.html", built), "utf8");
const read = (href) => readFileSync(new URL(`.${href}`, built), "utf8");
html = html.replace(
  /<link rel="stylesheet" crossorigin href="([^"]+)">/g,
  (_, href) => `<style>${read(href)}</style>`
);
html = html.replace(
  /<script type="module" crossorigin src="([^"]+)"><\/script>/g,
  (_, src) => `<script type="module">${read(src).replaceAll("</script", "<\\/script")}</script>`
);
if (/src="\/assets|href="\/assets/.test(html))
  throw new Error("an asset was left outside the file");
mkdirSync(out, { recursive: true });
writeFileSync(new URL(name, out), html);
// Only the one file is kept: the build folder was the way to it.
rmSync(built, { recursive: true });
console.log(`${new URL(name, out).pathname}: ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB`);
