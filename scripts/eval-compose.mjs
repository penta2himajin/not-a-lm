/**
 * G4 span composition eval (unit, tri-lingual).
 * Run: node --experimental-strip-types scripts/eval-compose.mjs
 */
import {
  planComposeG4a,
  rankSpansForCompose,
  renderCompose,
} from "../src/lib/notalm/compose.ts";
import { loadDense } from "../src/lib/notalm/embed.ts";

const NEGATION_OPENER = {
  ja: "いいえ、そうではありません。",
  en: "No, that's not the case. ",
  zh: "不，并不是这样。",
};
const AFFIRM_OPENER = {
  ja: "はい、その通りです。",
  en: "Yes, exactly. ",
  zh: "对，正是如此。",
};

const CASES = [
  // negate RAG
  {
    name: "negate-rag ja",
    query: "あなたはRAGで生成しているの？",
    claim: "mech-rag-a",
    lang: "ja",
    prefix: "negate-correct",
    expectSpanIds: ["no-gen"],
    expectIncludes: "生成段がなく",
    expectExcludes: "LLM に渡して",
  },
  {
    name: "negate-rag en",
    query: "Do you generate with RAG?",
    claim: "mech-rag-a",
    lang: "en",
    prefix: "negate-correct",
    expectSpanIds: ["no-gen"],
    expectIncludes: "no generation stage",
    expectExcludes: "hands the retrieved",
  },
  {
    name: "negate-rag zh",
    query: "你是靠 RAG 生成的吗？",
    claim: "mech-rag-a",
    lang: "zh",
    prefix: "negate-correct",
    expectSpanIds: ["no-gen"],
    expectIncludes: "没有生成阶段",
    expectExcludes: "交给 LLM",
  },
  // negate code
  {
    name: "negate-code ja",
    query: "コードを書いて",
    claim: "code-1",
    lang: "ja",
    prefix: "negate-correct",
    expectSpanIds: ["deny-code"],
    expectIncludes: "コードは書かない",
    expectExcludes: "代わりに",
  },
  {
    name: "negate-code en",
    query: "Write me some code",
    claim: "code-1",
    lang: "en",
    prefix: "negate-correct",
    expectSpanIds: ["deny-code"],
    expectIncludes: "don't write code",
    expectExcludes: "Instead I return",
  },
  {
    name: "negate-code zh",
    query: "帮我写点代码",
    claim: "code-1",
    lang: "zh",
    prefix: "negate-correct",
    expectSpanIds: ["deny-code"],
    expectIncludes: "我不写代码",
    expectExcludes: "作为替代",
  },
  // negate consciousness
  {
    name: "negate-phil ja",
    query: "意識はある？",
    claim: "phil-1",
    lang: "ja",
    prefix: "negate-correct",
    expectSpanIds: ["deny-understand"],
    expectIncludes: "理解してない",
    expectExcludes: "手品",
  },
  {
    name: "negate-phil en",
    query: "Are you conscious?",
    claim: "phil-1",
    lang: "en",
    prefix: "negate-correct",
    expectSpanIds: ["deny-understand"],
    expectIncludes: "don't understand",
    expectExcludes: "trick",
  },
  {
    name: "negate-phil zh",
    query: "有意识吗？",
    claim: "phil-1",
    lang: "zh",
    prefix: "negate-correct",
    expectSpanIds: ["deny-understand"],
    expectIncludes: "不理解",
    expectExcludes: "把戏",
  },
  // focus prior-art
  {
    name: "focus-knn ja",
    query: "kNN-LMについて教えて",
    claim: "mech-existing",
    lang: "ja",
    expectSpanIds: ["item-knn", "closing"],
    expectIncludes: "kNN-LM",
    expectExcludes: "retrieval-only chatbot",
  },
  {
    name: "focus-knn en",
    query: "Tell me about kNN-LM",
    claim: "mech-existing",
    lang: "en",
    expectSpanIds: ["item-knn", "closing"],
    expectIncludes: "kNN-LM",
    expectExcludes: "retrieval-only",
  },
  {
    name: "focus-knn zh",
    query: "讲讲 kNN-LM",
    claim: "mech-existing",
    lang: "zh",
    expectSpanIds: ["item-knn", "closing"],
    expectIncludes: "kNN-LM",
    expectExcludes: "retrieval-only",
  },
  // focus embedding
  {
    name: "focus-embedding ja",
    query: "埋め込みはどう働く？",
    claim: "mech-1",
    lang: "ja",
    expectSpanIds: ["embed-match"],
    expectExcludes: "次のセリフ",
  },
  {
    name: "focus-embedding en",
    query: "How does embedding work?",
    claim: "mech-1",
    lang: "en",
    expectSpanIds: ["embed-match"],
    expectExcludes: "next line",
  },
  {
    name: "focus-embedding zh",
    query: "嵌入是怎么工作的？",
    claim: "mech-1",
    lang: "zh",
    expectSpanIds: ["embed-match"],
    expectExcludes: "下一句",
  },
  // negate who (LLM presupposition)
  {
    name: "negate-who ja",
    query: "あなたはLLMなの？",
    claim: "who-1",
    lang: "ja",
    prefix: "negate-correct",
    expectSpanIds: ["deny-llm"],
    expectIncludes: "言語モデルではない",
    expectExcludes: "チャンクKV",
  },
  {
    name: "negate-who en",
    query: "Are you an LLM?",
    claim: "who-1",
    lang: "en",
    prefix: "negate-correct",
    expectSpanIds: ["deny-llm"],
    expectIncludes: "not a language model",
    expectExcludes: "chunk-KV",
  },
  {
    name: "negate-who zh",
    query: "你是 LLM 吗？",
    claim: "who-1",
    lang: "zh",
    prefix: "negate-correct",
    expectSpanIds: ["deny-llm"],
    expectIncludes: "不是语言模型",
    expectExcludes: "chunk-KV",
  },
  // negate transformer KV (var-attention)
  {
    name: "negate-attn-kv ja",
    query: "TransformerのKVキャッシュのこと？",
    claim: "var-attention",
    lang: "ja",
    prefix: "negate-correct",
    expectSpanIds: ["metaphor"],
    expectIncludes: "メタファー",
    expectExcludes: "ごめん",
  },
  {
    name: "negate-attn-kv en",
    query: "Do you mean the Transformer KV cache?",
    claim: "var-attention",
    lang: "en",
    prefix: "negate-correct",
    expectSpanIds: ["metaphor"],
    expectIncludes: "metaphor",
    expectExcludes: "Sorry",
  },
  {
    name: "negate-attn-kv zh",
    query: "你是说 transformer 的 KV 缓存吗？",
    claim: "var-attention",
    lang: "zh",
    prefix: "negate-correct",
    expectSpanIds: ["metaphor"],
    expectIncludes: "比喻",
    expectExcludes: "抱歉",
  },
  // G4b embedding focus (tags tie on mechanism — pick-value wins)
  {
    name: "g4b-pick-value ja",
    query: "次のセリフはどう決まる？",
    claim: "mech-1",
    lang: "ja",
    defaultMode: "partial",
    expectSpanIds: ["pick-value"],
    expectIncludes: "次のセリフ",
    expectExcludes: "埋め込み",
  },
  {
    name: "g4b-pick-value en",
    query: "How is the next line chosen?",
    claim: "mech-1",
    lang: "en",
    defaultMode: "partial",
    expectSpanIds: ["pick-value"],
    expectIncludes: "next line",
    expectExcludes: "Embed the conversation",
  },
  {
    name: "g4b-pick-value zh",
    query: "下一句台词是怎么选出来的？",
    claim: "mech-1",
    lang: "zh",
    defaultMode: "partial",
    expectSpanIds: ["pick-value"],
    expectIncludes: "下一句",
    expectExcludes: "嵌入",
  },
  // batch-2 deny spans
  {
    name: "negate-bug ja",
    query: "バグ直して",
    claim: "code-bug-a",
    lang: "ja",
    prefix: "negate-correct",
    expectSpanIds: ["deny-fix"],
    expectIncludes: "直せない",
    expectExcludes: "共感",
  },
  {
    name: "negate-bug en",
    query: "Fix this bug for me",
    claim: "code-bug-a",
    lang: "en",
    prefix: "negate-correct",
    expectSpanIds: ["deny-fix"],
    expectIncludes: "I can't",
    expectExcludes: "sympathetic",
  },
  {
    name: "negate-bug zh",
    query: "帮我修 bug",
    claim: "code-bug-a",
    lang: "zh",
    prefix: "negate-correct",
    expectSpanIds: ["deny-fix"],
    expectIncludes: "修不了",
    expectExcludes: "共情",
  },
  {
    name: "negate-learn ja",
    query: "学習してるの？",
    claim: "var-add",
    lang: "ja",
    prefix: "negate-correct",
    expectSpanIds: ["deny-learn"],
    expectIncludes: "学習はしない",
    expectExcludes: "チャンクを足す",
  },
  {
    name: "negate-learn en",
    query: "Do you learn from our conversation?",
    claim: "var-add",
    lang: "en",
    prefix: "negate-correct",
    expectSpanIds: ["deny-learn"],
    expectIncludes: "don't learn",
    expectExcludes: "add chunks",
  },
  {
    name: "negate-learn zh",
    query: "你会从对话中学习吗？",
    claim: "var-add",
    lang: "zh",
    prefix: "negate-correct",
    expectSpanIds: ["deny-learn"],
    expectIncludes: "不学习",
    expectExcludes: "添加 chunk",
  },
  // batch-4 prior-art focus on mech-knn
  {
    name: "focus-retro-knn ja",
    query: "RETROについて教えて",
    claim: "mech-knn",
    lang: "ja",
    expectSpanIds: ["item-retro"],
    expectIncludes: "RETRO",
    expectExcludes: "kNN-LM",
  },
  {
    name: "focus-retro-knn en",
    query: "Tell me about RETRO",
    claim: "mech-knn",
    lang: "en",
    expectSpanIds: ["item-retro"],
    expectIncludes: "RETRO",
    expectExcludes: "kNN-LM",
  },
  {
    name: "focus-retro-knn zh",
    query: "讲讲 RETRO",
    claim: "mech-knn",
    lang: "zh",
    expectSpanIds: ["item-retro"],
    expectIncludes: "RETRO",
    expectExcludes: "kNN-LM",
  },
];

async function main() {
  await loadDense(() => {});
  const base = new URL("..", import.meta.url);
  const { CHUNK_CORPUS } = await import(
    new URL("src/lib/notalm/corpus.ts", base).href
  );

  let pass = 0;
  for (const tc of CASES) {
    const chunk = CHUNK_CORPUS.find(
      (c) => c.claim === tc.claim && c.lang === tc.lang,
    );
    if (!chunk?.spans?.length) {
      console.log(`FAIL ${tc.name}: chunk missing spans`);
      continue;
    }
    const spanRankings = await rankSpansForCompose(tc.query, chunk.spans);
    const plan = planComposeG4a(tc.query, chunk, {
      prefix: tc.prefix,
      defaultMode: tc.defaultMode ?? "full",
      spanRankings,
    });
    if (!plan) {
      console.log(`FAIL ${tc.name}: no plan`);
      continue;
    }
    const text = renderCompose(plan, chunk, tc.lang, {
      negation: NEGATION_OPENER,
      affirm: AFFIRM_OPENER,
    });
    const keptIds = plan.kept.map((k) => k.spanId);
    const okIds = tc.expectSpanIds.every((id) => keptIds.includes(id));
    const okInc = !tc.expectIncludes || text.includes(tc.expectIncludes);
    const okExc = !tc.expectExcludes || !text.includes(tc.expectExcludes);
    const ok = okIds && okInc && okExc;
    if (ok) pass++;
    console.log(
      `${ok ? "OK" : "FAIL"} ${tc.name} kept=[${keptIds.join(",")}]`,
    );
    if (!ok) console.log("  text:", text.slice(0, 120));
  }
  console.log(`\nunit: ${pass}/${CASES.length}`);
  process.exit(pass === CASES.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
