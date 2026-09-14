import fs from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const outputDirectory = path.join(root, ".build");
await fs.mkdir(outputDirectory, { recursive: true });
const result = await build({
  entryPoints: [path.join(root, "ui", "admin.js")],
  bundle: true,
  minify: true,
  format: "esm",
  platform: "browser",
  write: false,
});
const [html, css] = await Promise.all([
  fs.readFile(path.join(root, "ui", "admin.html"), "utf8"),
  fs.readFile(path.join(root, "ui", "admin.css"), "utf8"),
]);
const javascript = result.outputFiles[0].text;
const generated = [
  `export const ADMIN_HTML = ${JSON.stringify(html)};`,
  `export const ADMIN_CSS = ${JSON.stringify(css)};`,
  `export const ADMIN_JS = ${JSON.stringify(javascript)};`,
  "",
].join("\n");
await fs.writeFile(
  path.join(root, "src", "generated", "admin-assets.js"),
  generated,
);
