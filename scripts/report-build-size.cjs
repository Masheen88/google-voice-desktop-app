const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist", "win");

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }

  return `${value.toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}

function walk(directory) {
  const files = [];
  if (!fs.existsSync(directory)) return files;

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...walk(fullPath));
    } else if (entry.isFile()) {
      files.push({ path: fullPath, size: fs.statSync(fullPath).size });
    }
  }

  return files;
}

if (!fs.existsSync(dist)) {
  console.log(`No Windows build directory found at: ${dist}`);
  process.exit(0);
}

const files = walk(dist).sort((a, b) => b.size - a.size);
const total = files.reduce((sum, file) => sum + file.size, 0);

console.log(`Windows dist total: ${formatBytes(total)}`);
console.log("Largest files:");

for (const file of files.slice(0, 20)) {
  console.log(
    `${formatBytes(file.size).padStart(10)}  ${path.relative(dist, file.path)}`,
  );
}
