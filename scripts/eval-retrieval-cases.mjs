/**
 * Shared retrieval eval cases (importable from eval scripts).
 */

/** Span/dual-index focus: answer-side vocabulary, expects partial compose */
export const FOCUS_CASES = [
  { lang: "ja", query: "kNN-LMについて教えて", claim: "mech-existing", spanId: "item-knn" },
  { lang: "en", query: "Tell me about kNN-LM", claim: "mech-existing", spanId: "item-knn" },
  { lang: "zh", query: "讲讲 kNN-LM", claim: "mech-existing", spanId: "item-knn" },
  { lang: "ja", query: "埋め込みはどう働く？", claim: "mech-1", spanId: "embed-match" },
  { lang: "en", query: "How does embedding work?", claim: "mech-1", spanId: "embed-match" },
  { lang: "zh", query: "嵌入是怎么工作的？", claim: "mech-1", spanId: "embed-match" },
];

/** mech-2 is correct when asking what embedding IS (conceptual) */
export const MECH2_CASES = [
  { lang: "ja", query: "埋め込み（エンベディング）って何？", claim: "mech-2" },
  { lang: "en", query: "What is an embedding?", claim: "mech-2" },
  { lang: "zh", query: "嵌入（embedding）是什么？", claim: "mech-2" },
];

/** Must not regress vs natKey-only baseline */
export const BASELINE_CASES = [
  { lang: "ja", query: "あなたは誰？", claim: "who-1" },
  { lang: "ja", query: "仕組みを教えて", claim: "mech-1" },
  { lang: "ja", query: "KVキャッシュって何？", claim: "var-attention" },
  { lang: "ja", query: "コード書ける？", claim: "code-1" },
  { lang: "ja", query: "こんにちは", claim: "greet-intro" },
  { lang: "en", query: "Who are you?", claim: "who-1" },
  { lang: "en", query: "How does this work?", claim: "mech-1" },
  { lang: "en", query: "What do you mean by KV?", claim: "var-attention" },
  { lang: "en", query: "Can you write code?", claim: "code-1" },
  { lang: "en", query: "Hello there", claim: "greet-intro" },
  { lang: "zh", query: "你是谁？", claim: "who-1" },
  { lang: "zh", query: "工作原理是什么？", claim: "mech-1" },
  { lang: "zh", query: "KV缓存是什么？", claim: "var-attention" },
  { lang: "zh", query: "你会写代码吗？", claim: "code-1" },
  { lang: "zh", query: "你好", claim: "greet-intro" },
];

/** API-only: must not hit low-confidence refusal */
export const GATE_SAFETY_CASES = [
  { lang: "ja", query: "埋め込みはどう働く？", rejectClaim: "limit-1" },
  { lang: "ja", query: "kNN-LMについて教えて", rejectClaim: "limit-1" },
  { lang: "en", query: "Tell me about kNN-LM", rejectClaim: "limit-1" },
];
