/**
 * Multilingual NLI (stage 3 / grounded generation) for NOT A LM.
 *
 * Used to detect a false presupposition in the user's question: given the
 * retrieved chunk's declarative `assertion` (hypothesis) and the user's
 * question (premise), NLI(premise=question, hypothesis=assertion) = entailment
 * means the question presupposes the assertion. If the chunk's stance denies
 * that assertion, the presupposition is false → grounded generation prepends a
 * correction (see engine.ts). No token generation: the reply is a closed
 * negation opener + the chunk's own (copied) value.
 *
 * Model: onnx-community/multilingual-MiniLMv2-L6-mnli-xnli-ONNX. fp32 (the q8
 * variant is unreliable in onnxruntime-node, like the reranker); scored one pair
 * at a time for determinism.
 */

export const NLI_MODEL_ID =
  "onnx-community/multilingual-MiniLMv2-L6-mnli-xnli-ONNX";
export const NLI_MODEL_LABEL = "MiniLMv2-L6-xnli";

type Tokenizer = (
  text: string,
  options: { text_pair: string; padding: boolean; truncation: boolean },
) => Promise<Record<string, unknown>>;

type SeqClsModel = ((
  inputs: Record<string, unknown>,
) => Promise<{ logits: { tolist: () => number[][] | number[] } }>) & {
  config?: { id2label?: Record<string, string> };
};

let tokenizer: Tokenizer | null = null;
let model: SeqClsModel | null = null;
let id2label: Record<string, string> = {};
let loading: Promise<void> | null = null;
let lastProgress = "idle";

export function getNliProgress(): string {
  return lastProgress;
}

export function isNliReady(): boolean {
  return tokenizer != null && model != null;
}

export async function loadNli(
  onProgress?: (msg: string) => void,
): Promise<void> {
  if (isNliReady()) return;
  if (loading) return loading;

  loading = (async () => {
    const report = (msg: string) => {
      lastProgress = msg;
      onProgress?.(msg);
    };

    report("NLI読込中…");
    const { AutoTokenizer, AutoModelForSequenceClassification, env } =
      await import("@huggingface/transformers");
    env.allowLocalModels = false;
    if (typeof process !== "undefined") {
      env.cacheDir =
        process.env.EMBED_CACHE_DIR ||
        process.env.BEKKO_CACHE_DIR ||
        "/tmp/notalm-embed-cache";
    }

    report(`${NLI_MODEL_ID} を取得中…`);
    const progress_callback = (p: {
      status?: string;
      progress?: number;
      file?: string;
    }) => {
      if (p?.status === "progress" && p.progress != null && p.file) {
        report(`${p.file} ${Math.round(p.progress)}%`);
      } else if (p?.status) {
        report(String(p.status));
      }
    };

    tokenizer = (await AutoTokenizer.from_pretrained(NLI_MODEL_ID, {
      progress_callback,
    })) as unknown as Tokenizer;
    model = (await AutoModelForSequenceClassification.from_pretrained(
      NLI_MODEL_ID,
      { dtype: "fp32", device: "cpu", progress_callback },
    )) as unknown as SeqClsModel;
    id2label = model.config?.id2label ?? {
      "0": "entailment",
      "1": "neutral",
      "2": "contradiction",
    };

    report(`${NLI_MODEL_LABEL} ready`);
  })();

  try {
    await loading;
  } catch (e) {
    loading = null;
    tokenizer = null;
    model = null;
    lastProgress = e instanceof Error ? e.message : "nli load failed";
    throw e;
  }
}

function softmax(a: number[]): number[] {
  const m = Math.max(...a);
  const e = a.map((x) => Math.exp(x - m));
  const s = e.reduce((p, c) => p + c, 0);
  return e.map((x) => x / s);
}

export type NliResult = {
  /** top label (entailment | neutral | contradiction) */
  label: string;
  /** probability of the top label */
  score: number;
  /** probability of the entailment class specifically */
  entail: number;
};

/**
 * NLI(premise, hypothesis). Throws if not loaded — check isNliReady() first.
 */
export async function nliClassify(
  premise: string,
  hypothesis: string,
): Promise<NliResult> {
  if (!tokenizer || !model) throw new Error("nli not ready");
  const inputs = await tokenizer(premise, {
    text_pair: hypothesis,
    padding: true,
    truncation: true,
  });
  const { logits } = await model(inputs);
  const rows = logits.tolist();
  const row: number[] = Array.isArray(rows[0])
    ? (rows as number[][])[0]
    : (rows as number[]);
  const probs = softmax(row);

  let entailIdx = -1;
  for (const [idx, label] of Object.entries(id2label)) {
    if (String(label).toLowerCase().includes("entail")) entailIdx = Number(idx);
  }
  const entail = entailIdx >= 0 ? probs[entailIdx] : 0;

  let topI = 0;
  for (let i = 1; i < probs.length; i++) if (probs[i] > probs[topI]) topI = i;
  return {
    label: id2label[String(topI)] ?? String(topI),
    score: probs[topI],
    entail,
  };
}
