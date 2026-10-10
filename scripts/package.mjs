// Builds the Chrome Web Store upload: dist/autoreloader-v<version>.zip
//
// It uses `git archive`, so the zip has manifest.json at its root and contains only
// COMMITTED files that are not marked `export-ignore` in .gitattributes (no node_modules,
// tests, CI config, etc.). Commit your changes before packaging.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("manifest.json", "utf8"));
const output = `dist/autoreloader-v${version}.zip`;

const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim();
if (dirty) {
  console.warn(`⚠ You have uncommitted changes. They are NOT included in the zip:\n${dirty}\n`);
}

mkdirSync("dist", { recursive: true });
execFileSync("git", ["archive", "--format=zip", `--output=${output}`, "HEAD"], {
  stdio: "inherit",
});

console.log(`✓ Created ${output}`);
