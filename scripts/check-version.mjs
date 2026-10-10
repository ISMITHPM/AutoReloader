// Fails if manifest.json and package.json disagree on the version, or (when a git tag
// such as "v1.3.0" is passed as the first argument) if the tag disagrees with them.
// The Chrome Web Store requires a higher manifest version on every upload, so a
// mismatch here is much cheaper to catch than a rejected upload.
import { readFileSync } from "node:fs";

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

const manifestVersion = readJson("manifest.json").version;
const packageVersion = readJson("package.json").version;
const tag = process.argv[2]?.replace(/^v/, "");

const problems = [];

if (manifestVersion !== packageVersion) {
  problems.push(
    `manifest.json is ${manifestVersion} but package.json is ${packageVersion}. Make them match.`
  );
}
if (tag && tag !== manifestVersion) {
  problems.push(`Git tag is ${tag} but manifest.json is ${manifestVersion}.`);
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`✗ ${problem}`);
  process.exit(1);
}

console.log(`✓ Version ${manifestVersion} is consistent.`);
