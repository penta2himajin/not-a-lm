# リランカー ＋ 信頼度ゲート（v1.5）

多言語化 v1 で「言語ルーティングは正しいが、bi-encoder 単段の選択精度が一部（特に中国語の言い換え）で甘い」という弱点が見えた。これを、生成を足さずに retrieval の質で解消するのが v1.5。

## 2段構成

1. **Stage 1 — bi-encoder（`embed.ts`）**: 多言語埋め込みで cosine 上位 `RERANK_CANDIDATES` 件を高速に絞る（言語・話者フィルタ込み）。
2. **Stage 2 — cross-encoder リランカー（`rerank.ts`）**: `(query, chunk.key)` を同時符号化して関連度を直接採点し、最終順位を決める。クエリはアンカー発話（`composeQueryVector` の `anchorText`）。

キー側（トリガー文脈）でリランクする。value（返答文）や key+value も試したが、`help-2`（例文キー）などが「磁石」化して過剰発火し、key 単体が最も安定して正確だった。

## モデル選定

`Xenova/bge-reranker-base`（多言語 XLM-RoBERTa cross-encoder, Transformers.js/ONNX）。
- `onnx-community/gte-multilingual-reranker-base` は transformers.js が未対応（`Unsupported model type: new`）。

### 重要な実装上の落とし穴（実機で判明）

- **量子化(q8/int8)は使用不可**: onnxruntime-node 上で数値的に不安定。同一入力に対して非決定的なスコア（例：0.07, 0.07, 0.99）を返し、無関係キーに誤って高スコアを付ける。→ **fp32 必須**（fp16 は CPU 実行が非対応でロード失敗）。代償として初回ダウンロードが大きい（一度キャッシュされれば以後は速い）。
- **バッチ＋パディングも不可**: 複数候補を1バッチで採点すると、パディングが相互にスコアを歪め、バッチ構成次第で同一ペアのスコアが変わる。→ **1ペアずつ（バッチサイズ1）で採点**して決定的にする。候補数は `RERANK_CANDIDATES=10` に抑え、逐次フォワードのレイテンシを許容範囲に保つ。

## 信頼度ゲート（graceful refusal）

fp32 bge-reranker-base のスコア分布は、コーパス内一致 ~0.1–0.99、明確なコーパス外 <~0.01 と分離する。返答モードで最良スコアが `RERANK_MIN_SCORE=0.03` 未満なら、無関係チャンクを貼らず、その言語の `limit-1`（「近いキーがないと的外れが勝つ」）を返し、トレースに `lowConfidence` を立てる。

- 例：「What is the capital of France?」「東京駅への行き方は？」→ rr≈0.00 → 拒否。
- 連鎖（predict-user）モードでは拒否しない（探索的なため）。
- 再利用ペナルティは Stage 1（候補選択）のみに適用。Stage 2 に掛けると低スコアの正当な一致を潰し、誤って拒否してしまうため掛けない。

## 既知の限界・次

- キーがキーワード列のため、「how does it work / 使い方 / 你是怎么运作的」のような "how" 系はリランカーがヘルプ/挨拶チャンクと近いと判断することがある（on-topic ではある）。キーを自然文へ整える、あるいは NLI ベースの操作分類（融合/編集型の接地生成）で更に改善可能。
