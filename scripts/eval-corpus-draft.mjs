/**
 * G7b draft eval — offline TranslateFn (no network).
 */
import assert from "node:assert/strict";
import {
  draftMissingLangs,
  unifiedDiff,
} from "../src/lib/notalm/corpus-draft.ts";

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log("OK", name);
  } catch (e) {
    failed++;
    console.error("FAIL", name, e.message || e);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    console.log("OK", name);
  } catch (e) {
    failed++;
    console.error("FAIL", name, e.message || e);
  }
}

const fakeTranslate = async (text, from, to) => {
  if (from === to) return text;
  return `[${to}]${text}`;
};

await checkAsync("draft en+zh from ja", async () => {
  const r = await draftMissingLangs(
    {
      claim: "x",
      speaker: "bot",
      ja: { nat: "こんにちは", value: "やあ。" },
    },
    { translate: fakeTranslate },
  );
  assert.deepEqual(r.drafted.sort(), ["en", "zh"]);
  assert.equal(r.claim.en?.nat, "[en]こんにちは");
  assert.equal(r.claim.zh?.value, "[zh]やあ。");
  assert.equal(r.sourceLang, "ja");
});

await checkAsync("skip existing lang", async () => {
  const r = await draftMissingLangs(
    {
      claim: "x",
      speaker: "bot",
      ja: { nat: "こんにちは", value: "やあ。" },
      en: { nat: "Hi", value: "Yo." },
    },
    { translate: fakeTranslate },
  );
  assert.deepEqual(r.drafted, ["zh"]);
  assert.equal(r.claim.en?.nat, "Hi");
  assert.ok(r.notes.some((n) => /en: skipped/.test(n)));
});

await checkAsync("overwrite existing", async () => {
  const r = await draftMissingLangs(
    {
      claim: "x",
      speaker: "bot",
      ja: { nat: "こんにちは", value: "やあ。" },
      en: { nat: "Hi", value: "Yo." },
    },
    { translate: fakeTranslate, overwrite: true, targets: ["en"] },
  );
  assert.deepEqual(r.drafted, ["en"]);
  assert.equal(r.claim.en?.nat, "[en]こんにちは");
});

check("unifiedDiff shows plus minus", () => {
  const d = unifiedDiff("a\nb\nc\n", "a\nB\nc\n");
  assert.ok(d.includes("-b"));
  assert.ok(d.includes("+B"));
  assert.ok(d.includes(" a") || d.includes(" a\n") || d.split("\n").some((l) => l === " a"));
});

check("unifiedDiff identical", () => {
  assert.equal(unifiedDiff("x\n", "x\n"), "(no diff)");
});

await checkAsync("no source throws", async () => {
  await assert.rejects(
    () =>
      draftMissingLangs(
        { claim: "x", speaker: "bot" },
        { translate: fakeTranslate },
      ),
    /下書き元/,
  );
});

console.log(`\ncorpus-draft: ${6 - failed}/6`);
process.exit(failed ? 1 : 0);
