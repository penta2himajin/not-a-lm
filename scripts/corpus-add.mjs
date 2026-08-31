/**
 * G7a: add a claim with minimal fields.
 *
 * Usage:
 *   npm run corpus:add -- --claim weather-fog --speaker bot \
 *     --ja-nat "霧の日はどうするの？" \
 *     --ja-value "コーパスの奥で迷子になる。近いキーを手探りする日だね。"
 *
 * Optional: --tags a,b --stance deny --ja-assertion "..." \
 *   --en-nat "..." --en-value "..." --zh-nat "..." --zh-value "..."
 */
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { spawnSync } from "node:child_process";
import { finalizeClaim } from "../src/lib/notalm/corpus-author.ts";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

const claim = arg("claim");
const speaker = arg("speaker", "bot");
const tags = (arg("tags", "") || "")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const stance = arg("stance");

if (!claim || !/^[a-z][a-z0-9-]*$/.test(claim)) {
  console.error("Usage: --claim <kebab-id> --ja-nat ... --ja-value ...");
  process.exit(1);
}
if (speaker !== "bot" && speaker !== "user") {
  console.error("--speaker must be bot|user");
  process.exit(1);
}

/** @type {import("../src/lib/notalm/corpus-author.ts").AuthorClaim} */
const draft = {
  claim,
  speaker,
  tags: tags.length ? tags : undefined,
  stance: stance === "affirm" || stance === "deny" ? stance : undefined,
};

function surface(prefix) {
  const nat = arg(`${prefix}-nat`);
  const value = arg(`${prefix}-value`);
  if (!nat && !value) return undefined;
  if (!nat || !value) {
    console.error(`both --${prefix}-nat and --${prefix}-value required`);
    process.exit(1);
  }
  const assertion = arg(`${prefix}-assertion`);
  const s = { nat, value };
  if (assertion) s.assertion = assertion;
  return s;
}

draft.ja = surface("ja");
draft.en = surface("en");
draft.zh = surface("zh");

if (!draft.ja && !draft.en && !draft.zh) {
  console.error("need at least one language surface (--ja-nat/--ja-value, …)");
  process.exit(1);
}

const finalized = finalizeClaim(draft);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const path = join(root, "corpus", "claims", `${claim}.yml`);

if (existsSync(path) && !flag("force")) {
  console.error(`exists: ${path} (pass --force to overwrite)`);
  process.exit(1);
}

writeFileSync(path, stringify(finalized, { lineWidth: 100 }), "utf8");
console.log(`wrote ${path}`);

const build = spawnSync("npm", ["run", "corpus:build"], {
  cwd: root,
  stdio: "inherit",
  shell: false,
});
process.exit(build.status ?? 1);
