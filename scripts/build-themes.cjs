const fs = require("node:fs");
const path = require("node:path");
const sass = require("sass");

const rootDir = path.resolve(__dirname, "..");
const themesDir = path.join(rootDir, "src", "themes");
const outputDir = path.join(rootDir, "src", "themes-compiled");
const basePath = path.join(themesDir, "base.scss");
const mappingsPath = path.join(themesDir, "mappings.scss");

const BASE_IMPORT = /@(?:use|import)\s+["']base(?:\.scss)?["']\s*;?/g;
const MAPPINGS_IMPORT = /@(?:use|import)\s+["']mappings(?:\.scss)?["']\s*;?/g;

function joinImports(source) {
  const base = fs.readFileSync(basePath, "utf8");
  const mappings = fs.readFileSync(mappingsPath, "utf8");

  let contents = source.replaceAll(BASE_IMPORT, base);
  contents = contents.replaceAll(MAPPINGS_IMPORT, mappings);
  contents = contents.replaceAll(BASE_IMPORT, "");
  contents = contents.replaceAll(MAPPINGS_IMPORT, "");

  return contents;
}

function forceImportant(css) {
  // Preserve the application's historical theme behavior: declarations injected
  // into Google Voice should win against Google's frequently changing selectors.
  return css.replace(/(?<!!important);/g, " !important;");
}

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });

const themeFiles = fs
  .readdirSync(themesDir, { withFileTypes: true })
  .filter(
    (entry) =>
      entry.isFile() &&
      entry.name.endsWith(".scss") &&
      !["base.scss", "mappings.scss"].includes(entry.name),
  )
  .map((entry) => entry.name)
  .sort();

for (const fileName of themeFiles) {
  const themeName = path.basename(fileName, ".scss");
  const source = fs.readFileSync(path.join(themesDir, fileName), "utf8");
  const combined = joinImports(source);

  const result = sass.compileString(combined, {
    loadPaths: [themesDir],
    style: "expanded",
  });

  const importantCss = forceImportant(result.css);
  const compressedCss = sass.compileString(importantCss, {
    style: "compressed",
  }).css;
  const outputPath = path.join(outputDir, `${themeName}.css`);

  fs.writeFileSync(outputPath, compressedCss, "utf8");
  console.log(`Compiled theme: ${themeName}`);
}
