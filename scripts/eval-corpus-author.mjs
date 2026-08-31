/**
 * G7a authoring helpers unit eval.
 * Run: npm run eval:corpus-author
 */
import {
  autoSpans,
  deriveKey,
  finalizeClaim,
  finalizeSurface,
  joinAuthorSpans,
} from "../src/lib/notalm/corpus-author.ts";

let pass = 0;
let total = 0;

function check(name, ok, detail = "") {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "OK" : "FAIL"} ${name}${detail ? " " + detail : ""}`);
}

{
  const spans = autoSpans("あ。い。", "ja");
  check("ja split 2", spans.length === 2);
  check("ja join", joinAuthorSpans(spans, "ja") === "あ。い。");
}

{
  const spans = autoSpans("Hello there. Next line.", "en");
  check("en split 2", spans.length === 2, String(spans.length));
  check(
    "en join",
    joinAuthorSpans(spans, "en") === "Hello there. Next line.",
  );
}

{
  // arrow-heavy values may not split cleanly → full fallback
  const v = "Add → embed → search.";
  const spans = autoSpans(v, "en");
  check("en fallback reconstruct", joinAuthorSpans(spans, "en") === v);
}

{
  const key = deriveKey("霧の日はどうするの？", "迷子になる。", "ja");
  check("ja key non-empty", key.length > 0, key);
}

{
  const s = finalizeSurface(
    { nat: "Who are you?", value: "A dictionary of lines." },
    "en",
  );
  check("auto key", !!s.key && s.key.includes("who"));
  check("auto spans join", joinAuthorSpans(s.spans, "en") === s.value);
}

{
  const c = finalizeClaim({
    claim: "weather-fog",
    speaker: "bot",
    ja: {
      nat: "霧の日はどうするの？",
      value: "コーパスの奥で迷子になる。近いキーを手探りする日だね。",
    },
  });
  check("ja-only ok", !!c.ja && !c.en && !c.zh);
  check("default tags", c.tags?.[0] === "untagged");
  check("ja spans", (c.ja?.spans?.length ?? 0) >= 1);
}

console.log(`\ncorpus-author: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
