import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const json = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const text = (path) => readFileSync(join(root, path), "utf8");

const distribution = "ai-architect-mcp-spec";
const product = distribution;
const repository = distribution;
const registryId = `io.github.cdeust/${distribution}`;
const pkg = json("package.json");
const version = pkg.version;
const fullSkill = text("packages/skill/SKILL.md");
const fullSkillPackage = json("packages/skill/package.json");

assert.equal(pkg.name, distribution);
for (const path of [
  "manifest.json",
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  "gemini-extension.json",
  "mcp-server/package.json",
]) {
  assert.equal(json(path).version, version, `${path} version must be ${version}`);
}

const marketplace = json(".claude-plugin/marketplace.json");
assert.equal(marketplace.metadata.version, version);
assert.equal(marketplace.plugins.find(({ name }) => name === product)?.version, version);

const server = json("server.json");
assert.equal(server.name, registryId);
assert.equal(server.repository.url, `https://github.com/cdeust/${repository}`);
assert.equal(server.version, version);
assert.equal(server.packages[0].version, version);
assert.equal(
  server.packages[0].identifier,
  `https://github.com/cdeust/${repository}/releases/download/v${version}/${distribution}.mcpb`,
);
if (server.packages[0].fileSha256 !== undefined) {
  assert.match(server.packages[0].fileSha256, /^[a-f0-9]{64}$/);
  assert.notEqual(
    server.packages[0].fileSha256,
    "0".repeat(64),
    "fileSha256 must be omitted before release or contain the real artifact digest",
  );
}

assert.match(text("README.md"), new RegExp(`<!-- mcp-name: ${registryId} -->`));
assert.match(fullSkill, new RegExp(`^---\\nname: ${distribution}\\nversion: ${version.replaceAll(".", "\\.")}\\n`));
assert.equal(fullSkillPackage.name, "@ai-architect-mcp-spec/skill");
assert.doesNotMatch(text("packages/mcp-server/src/index.ts"), /skills\", \"prd-spec-generator/);
assert.match(text("CHANGELOG.md"), new RegExp(`^## \\[${version.replaceAll(".", "\\.")}\\]`, "m"));
const release = text(".github/workflows/release.yml");
assert.match(release, new RegExp(`${distribution}\\.mcpb`));
assert.doesNotMatch(release, /prd-spec-generator\.mcpb/);
assert.match(release, new RegExp(`${distribution}\\.cdx\\.json`));

console.log(`Distribution identity is consistent at ${distribution} v${version}.`);
