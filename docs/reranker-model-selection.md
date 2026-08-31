# リランカー軽量化の評価

案B以降、リランカーは**ランキングではなく** (1) 信頼度ゲート（キーワード列キーでの in/out 分離）と (2) 融合のセグメント×候補マッチングに限定されている。PR #6 マージ後に、より小さい多言語 cross-encoder へ差し替え可能か検証した。

## 候補

| モデル | 規模 | fp32 ONNX | 多言語 | Transformers.js | 結果 |
|---|---|---|---|---|---|
| **Xenova/bge-reranker-base**（現行） | 278M | ~1.1GB | ja/zh/en | 公式 | ベースライン |
| **SugoLabs/mmarco-mMiniLMv2-L12-H384-v1** | 118M | ~471MB | 14言語 | あり | **不採用** |
| ms-marco-MiniLM-L6-v2 | 23M | ~91MB | 英語のみ | あり | 除外（単言語） |

## mmarco-mMiniLMv2 の評価（不採用）

同一コーパス・同一 API 経由で dense 埋め込み + ゲート + 融合を比較。

| 指標 | bge-reranker-base (fp32) | mmarco-mMiniLMv2 (fp32) |
|---|---|---|
| 融合（3言語 compound） | **3/3** | **0/3** |
| 英語ゲート「How does this work?」 | 0.95（通過） | 0.0004（**誤拒否**） |
| 英語融合 seg「Explain the mechanism」→ mech-1 | 0.89 | 0.0007 |
| 日本語融合 seg「動作原理」→ mech-1 | 0.61 | 0.03（FUSE_MIN 未満） |

**結論**: サイズは約半分だが、英語のゲート誤拒否と融合マッチングが実用不可。閾値調整では救えない（スコアが桁違いに低い）。ゲート用途に限定しても、融合が cross-encoder 品質に依存するため現構成では差し替え不可。

## 採用した軽量化: bge-reranker-base の q8 量子化

小型モデル差し替えが不成立だったため、**同一モデルで ONNX 量子化**を再検証。

- `RERANK_DTYPE=q8`（デフォルト）: ONNX ~280MB（fp32 の ~1.1GB から約 75% 削減）
- `@huggingface/transformers` 4.2.0 / onnxruntime-node 上で、ゲート・融合に使う代表ペアで **5 連続推論が決定的**（旧ドキュメントの q8 非決定性は再現せず）
- ゲート・融合の挙動は fp32 と同等（スコア絶対値は僅かに異なるが順位・通過/拒否は一致）

環境変数:

- `RERANK_MODEL_ID` — モデル ID（デフォルト `Xenova/bge-reranker-base`）
- `RERANK_DTYPE` — `q8`（デフォルト）| `fp32` | `q4`
- `RERANK_MODEL_LABEL` — UI 表示用ラベル

## 評価スクリプト

```bash
# ペア単位のゲート分離比較
npm run eval:reranker

# API 経由 E2E（dev サーバー起動中）
npm run eval:reranker:engine
```

## 次の検討

- ~~埋め込みの q8 再検証~~ → 採用済（[`embedding-model-selection.md`](embedding-model-selection.md)）
- ~~NLI の q8 再検証~~ → **不採用**（[`nli-model-selection.md`](nli-model-selection.md)）
- 融合を bi-encoder に落とせばリランカー依存を減らせるが、誤対応リスク要実測
- q8 非決定性の旧事象は別 ORT バージョン由来の可能性 — 回帰テストを CI に載せる価値あり
