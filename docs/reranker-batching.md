# リランカー・バッチ化メモ（P0 調査）

目的: gate / fuseRerank の CE を「可変長パッド + attention_mask」でバッチ化し RTT を短縮できるか。

## 結論（実測・Transformers.js 4.2 / onnxruntime-node / CPU）

| dtype | pad-to-longest バッチ ≡ 単独 | CPU での速度感 |
|---|---|---|
| **fp32** | **一致（diff = 0）** | バッチしても q8 逐次より遅い |
| **q8（現行デフォルト）** | **不一致**（単独を長くパッドするだけで点が動く） | バッチは僅かに速いが品質不可 |

つまり「attn mask 付きバッチ」自体は正しい手法だが、**現行 q8 ONNX 経路ではパディングがスコアを汚染する**。mask テンソルは `1n/0n` で正しく付いている（読み取りミスではない）。

### 再現の要点

- 同一 `(query, key)` を自然長で採点 → q8 ≈ 0.70
- 同じペアを `padding: max_length` (128/512) → q8 ≈ 0.50（大きく変化）
- 同じ比較を **fp32** で行う → 両方が一致、バッチ12件でも diff 0

## 他手法

- **同一トークン長だけバッチ（bucketing）**: q8 でも差は ~1e-3 程度に収まる例あり。ただしコーパスキー長がバラけるとバッチが細切れになり、CPU では加速がほぼ出ない。
- **FlashAttention varlen / packing**: pad なしで安全だが CUDA 前提。Transformers.js CPU ONNX では非現実的。
- **fp32 + バッチを本番デフォルトにする**: 正しさは取れるが、この環境では **q8 逐次より遅い**ため RTT 目的では不利。

## 運用

- 本番デフォルト: `rerankScores` = **逐次**（q8）
- 実験: `RERANK_DTYPE=fp32 RERANK_BATCH=1`
- 回帰: `npm run eval:rerank-batch`

## 含意（RTT）

gate/fuse の CE 高速化は「素朴バッチ」では伸びない。次に効くのは **呼び出し回数の削減**（条件付き gate、fuse 候補数、スコア再利用）側。
