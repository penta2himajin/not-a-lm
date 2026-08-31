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
type SpanRecord = { id: string; text: string; tags?: string[]; nliHypothesis?: string };
type ComposePlan = {
  prefix?: "negate-correct" | "affirm-confirm";
  kept: { chunkId: string; spanId: string }[];
};
```

- `value` は表示用の結合済み文字列（`spans` と一致すること）
- トレース: `operation: "compose"`, `composePlan` に KEEP 一覧

## G4a プランナー規則（v1）

1. **極性 + deny** — `negate-correct` 時、タグ `correction` / `no-generation` / `deny-core` のスパンのみ KEEP
1d. **G4c 否定 refine** — 上記 correction 集合に `nliHypothesis` 付き span があるとき、NLI entail ≥ 0.5 でさらに絞る
2. **焦点** — クエリがスパンタグにマッチしたら、該当スパン（＋ `summary`）のみ KEEP
2b. **G4b** — タグで絞れないとき dense cosine で焦点
2c. **G4c** — タグ + G4b でも絞れないとき `span.nliHypothesis` への NLI entail で焦点
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
| `greet-howreply-a` | 返答パイプライン 4 ステップ + 生成ゼロ |
| `who-2` | AI/チャットボット → 近傍探索メタファー（2 スパン） |
| `mech-3` | 連鎖ループ 4 ステップ（append → embed → search → effect） |
| `code-bug-a` | deny 系 **deny-fix** のみ（coding） |
| `var-add` | deny 系 **deny-learn** のみ（学習誤解） |
| `greet-welcome` | 挨拶 + welcome + chunk-KV 連鎖 |
| `who-1b` | 名前 / 略称 / セリフ辞書（identity） |
| `food-old-a` | 古いネタ再利用 + 非生成の強み |
| `limit-2` | 新嘘不可 + 無関係な真実事故 |
| `var-feel` | 「見える」/ 類似度ソート / 不気味の谷 |

計 **22 claim × 3 言語 = 66 chunks** に spans（batch-3: +5 claim）。

## パイプライン位置

```
retrieve → G2 NLI (prefix 決定) → G3 fusion (+ G4 per segment) → G4 compose (single-chunk) → reply
```

- G3 融合時は **各セグメントに G4a compose を適用**（`fuseCompound` 内、`composePartBody`）
- **G4b**: タグ Rule 2 で絞れないとき `rankSpansForCompose`（dense cosine + `indexTextForSpan`）で Rule 2b 焦点
- **G4c**: `rankSpansByNli` — `nliHypothesis` 付き span を NLI(premise=query) で採点。Rule 1d（否定 refine）/ Rule 2c（焦点）
- 単一チャンク応答は Stage 4 の G4a+G4b+G4c（dual-index の `focusSpanId` 優先）
- `trace.fuseParts[]` にセグメントごとの `composePlan` を記録
- `trace.fusedCompose`: 融合パートのいずれかが G4 で狭められたとき true

## 評価

```bash
npm run eval:corpus-spans     # spans/value 整合性
npm run eval:compose          # ユニット（プランナー + render）
npm run eval:g4c:compose      # G4c per-span NLI（unit + NLI 統合）
npm run eval:fusion-g4        # G3×G4 ユニット（prior-art 部分 KEEP）
npm run eval:fusion-g4:engine # G3×G4 API（dev server 要）
npm run eval:nli:engine       # E2E negate（G2+G4 連携）
npm run eval:reranker:engine  # fusion 発火（G3）
```

## フォローアップ（G4.2+）

- **Dual-index retrieval** — [`retrieval-dual-index.md`](retrieval-dual-index.md) ✅
- **G3×G4** — 融合各パートへの compose ✅
- スパン embedding / cross-encoder マッチ（G4b）— ✅ Rule 2b `rankSpansForCompose` + `spanRankings`
- NLI per-span（G4c）— ✅ Rule 1d/2c `rankSpansByNli` + `nliHypothesis`
- 句単位スパンへの細分化（batch-2 では **不要** — 1文=1スパンで十分だった claim のみ追加）
- コーパス spans 拡張 — 22 claim（残り ~30 claim は段階追加）
