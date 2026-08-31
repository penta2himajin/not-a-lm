# 接地生成 G4: スパン単位の合成（compose）

G3 までで「チャンク丸ごとの融合＋極性前置」は実装済み。G4 は **チャンク内 `value` を著者定義スパンに分解し、KEEP / 閉じた PREFIX だけで応答を組み立てる** 段階です。

## 設計方針（合意内容）

| 項目 | 決定 |
|---|---|
| スパン表現 | **案A**: コーパス著者時 `spans[]`（`SpanRecord`） |
| 粒度 | v1 は **1文 = 1スパン**。不足時のみ句単位へ細分化 |
| プランナー | **G4a** ルールベース（タグマッチ）。後から G4b/c で高解像度化 |
| 「完全」 | 出力はスパン text のコピー ＋ 閉じた PREFIX（G2）のみ |

## データモデル

```ts
type SpanRecord = { id: string; text: string; tags?: string[] };
type ComposePlan = {
  prefix?: "negate-correct" | "affirm-confirm";
  kept: { chunkId: string; spanId: string }[];
};
```

- `value` は表示用の結合済み文字列（`spans` と一致すること）
- トレース: `operation: "compose"`, `composePlan` に KEEP 一覧

## G4a プランナー規則（v1）

1. **極性 + deny** — `negate-correct` 時、タグ `correction` / `no-generation` / `deny-core` のスパンのみ KEEP
2. **焦点** — クエリがスパンタグにマッチしたら、該当スパン（＋ `summary`）のみ KEEP
3. **列挙部分** — `prior-art-item` が絞られたとき `summary` を付与

変更がなければ `null`（G2 レガシー: prefix + 全文）。

## パイロットクレーム（選定理由）

| claim | 理由 |
|---|---|
| `mech-rag-a` | 否定補正 + **correction スパンのみ**抽出（G4 の看板例） |
| `code-1`, `phil-1` | deny 系で **deny-core スパン** に絞る |
| `mech-existing` | 列挙型 **部分 KEEP**（kNN-LM / RETRO 等） |
| `mech-1`, `mech-2` | 複文 value の **焦点抽出**（embedding / mechanism） |
| `who-1` | 否定補正で **deny-llm** のみ（identity） |
| `var-attention` | Transformer KV 誤解 → **metaphor** 補正 |
| `greet-intro` | 挨拶 + not-lm + mechanism 3 スパン |
| `who-diff-a` | LLM との対比（2 スパン） |
| `help-1` | 使い方 UI / 連鎖ボタン（3 スパン） |
| `var-kv` | attention KV との区別（2 スパン） |

計 **12 claim × 3 言語 = 36 chunks** に spans（2026-08 拡張）。

## パイプライン位置

```
retrieve → G2 NLI (prefix 決定) → G3 fusion (+ G4 per segment) → G4 compose (single-chunk) → reply
```

- G3 融合時は **各セグメントに G4a compose を適用**（`fuseCompound` 内、`composePartBody`）
- **G4b**: タグ Rule 2 で絞れないとき `rankSpansForCompose`（dense cosine + `indexTextForSpan`）で Rule 2b 焦点
- 単一チャンク応答は Stage 4 の G4a+G4b（dual-index の `focusSpanId` 優先）
- `trace.fuseParts[]` にセグメントごとの `composePlan` を記録
- `trace.fusedCompose`: 融合パートのいずれかが G4 で狭められたとき true

## 評価

```bash
npm run eval:corpus-spans     # spans/value 整合性
npm run eval:compose          # ユニット（プランナー + render）
npm run eval:fusion-g4        # G3×G4 ユニット（prior-art 部分 KEEP）
npm run eval:fusion-g4:engine # G3×G4 API（dev server 要）
npm run eval:nli:engine       # E2E negate（G2+G4 連携）
npm run eval:reranker:engine  # fusion 発火（G3）
```

## フォローアップ（G4.2+）

- **Dual-index retrieval** — [`retrieval-dual-index.md`](retrieval-dual-index.md) ✅
- **G3×G4** — 融合各パートへの compose ✅
- スパン embedding / cross-encoder マッチ（G4b）— ✅ Rule 2b `rankSpansForCompose` + `spanRankings`
- NLI per-span（G4c）
- 句単位スパンへの細分化
- コーパス spans 拡張 — 12 claim（残り ~40 claim は G4b/c 向けに段階追加）
