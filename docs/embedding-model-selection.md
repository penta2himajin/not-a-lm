# 埋め込みモデル選定（多言語化 v1）

多言語化（日本語・英語・中国語(簡体)）にあたり、日本語特化の `hotchpotch/bekko-embedding-v1-a8m` から多言語文埋め込みモデルへ差し替える。候補を実機（Transformers.js v4.2.0 / ONNX / Node・CPU）で試験ロードして比較した。

## 評価方法

- 各候補を int8 量子化（`dtype: "q8"`）で `feature-extraction` パイプラインとしてロードし、`{ pooling: "mean", normalize: true }` で埋め込み。
- 短発話（このアプリの実入力に近い）で以下を測定：
  - **言語横断整合**：意味的に等価な「あなたは誰？ / Who are you? / 你是谁？」の cos。高いほど良い。
  - **話題分離**：同一言語で別話題（「あなたは誰？」↔「こんにちは」／「仕組みを教えて」）の cos。**低いほど良い**（top-K で正解を分離できる）。
- 検索品質で効くのは絶対値ではなく「関連は高く・無関係は低い」**分離幅**。

## 結果

| モデル | 次元 | 言語横断 ja-en / ja-zh / en-zh | 別話題 who-greet / who-mech | 推論(5文) |
|---|---|---|---|---|
| granite-107m-multilingual (community ONNX) | 384 | 0.946 / 0.957 / 0.923 | 0.667 / 0.629 | 12ms |
| granite-311m-multilingual-r2 (onnx-community) | 768 | 0.775 / 0.969 / 0.800 | 0.720 / 0.647 | 53ms |
| **paraphrase-multilingual-MiniLM-L12-v2 (Xenova)** | 384 | **0.991 / 0.994 / 0.990** | **0.489 / 0.317** | 24ms |

## 分析

- **paraphrase-MiniLM**：言語横断はほぼ 0.99 で揃い、別話題は 0.317 まで落ちる＝**分離が最良**。384 次元で既存の `HASH_DIM` と一致し改修最小、対称類似で現行の平均処理に素直、ロードも軽量。
- **granite-107m**：言語横断は良好だが別話題でも 0.63〜0.67 と高止まりし**弁別力が弱い**（int8＋超短文の影響もあるが、top-K 分離に不利）。384 次元で統合は容易。
- **granite-311m-r2**：**ja-en=0.775 / en-zh=0.800 と言語横断が不安定**で別話題(0.72)とほぼ差がなく、ja/en/zh 混在では**言語取り違えリスク**。768 次元で重い。→ 非推奨。

## 決定

**v1 は `Xenova/paraphrase-multilingual-MiniLM-L12-v2`（384 次元・対称・多言語）を採用**。

## フォローアップ

- 新モデルは cos 分布が bekko と異なる（別話題が 0.3〜0.5 帯）ため、`query-vector.ts` の閾値（`QUERY_PAIR_ANCHOR_MIN`, `QUERY_PAIR_CHAIN_MIN`）を再調整する。
- granite は本来長文で強い可能性があり、コーパスが長文寄りになった段階で fp32 も含め再評価の余地あり。今回は fp32 の再測定は行っていない。
- 言語判定は v1 では字種ベースのヒューリスティック（かな→ja / 漢字のみ→zh / ラテン→en）。

## q8 量子化（2026-08 再検証）

PR #7（リランカー q8）に続き、同一モデルの ONNX 量子化を再検証。

| 検査 | fp32 | q8 |
|---|---|---|
| 5連続推論の決定性 | 0 fail | **0 fail** |
| batch≡single（embedMany 経路） | 0 fail | **0 fail** |
| 言語横断 cos (ja-en / ja-zh / en-zh) | 0.994 / 0.997 / 0.992 | 0.991 / 0.994 / 0.990 |
| 別話題分離 (who-greet / who-mech) | 0.496 / 0.310 | 0.489 / 0.317 |
| natKey top-1（15クエリ簡易） | 9/15 | 8/15（zh「你好」→ greet-welcome のみ q8 差分） |

**結論**: q8 は決定的かつ分離幅は fp32 と実質同等。ONNX ~470MB → ~118MB（約 75% 削減）。デフォルト `EMBED_DTYPE=q8`（`EMBED_DTYPE=fp32` で復帰可）。

評価: `npm run eval:embed:q8` / `npm run eval:embed:retrieval`
