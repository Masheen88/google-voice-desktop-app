const fs = require("node:fs");
const path = require("node:path");

const packagePath = path.resolve(__dirname, "..", "package.json");
const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));

const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(pkg.version);

if (!match) {
  throw new Error(
    `Cannot automatically increment unsupported version: ${pkg.version}`,
  );
}

const oldVersion = pkg.version;

const major = Number(match[1]);
const minor = Number(match[2]);
const patch = Number(match[3]) + 1;

pkg.version = `${major}.${minor}.${patch}`;

fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

console.log(`Version bumped: ${oldVersion} -> ${pkg.version}`);
