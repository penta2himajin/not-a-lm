# 接地生成 G6: 多ターン接地

G5 までで **1 ターン**の grounded reply（宣言的 `OperationPlan` → render）は揃った。G6 はそれを **時間方向**へ拡張する: 履歴をコピー単位で指差し、照応を解決し、必要なら意図を明確化する。

制約は不変: **コーパス／履歴スパンのコピー + 閉じた糊 + クエリ／履歴から抜いた topic**。トークン生成なし。

## ロードマップ番号（合意）

| 番号 | 内容 |
|---|---|
| **G6** | 多ターン接地（本ドキュメント） |
| **G7** | コーパス編集オペレータ（作者側） |
| **G8** | ANN・自律収集・依存監査 |
| **G9** | 検証・自己監査ループ（出力 ⊆ コーパス ∪ 閉じた糊） |

（初期案で「後回し G6」だった ANN 束は **G8** へ。旧「検証 G8」は **G9** へずらす。）

## 現状（G5 まで）の多ターン

- `composeQueryVector` … 直近ペアの埋め込みブレンド（構造参照ではない）
- `usedIds` … 再利用ペナルティ（継続とは逆方向に効きやすい）
- UI 連鎖デモ … `predict-user` → `reply` のオープンループ
- 前回の `composePlan` / `claim` / kept span は **トレースに残るだけで次ターンへ渡らない**（→ G6a で解消）

## 照応の二分類（設計合意）

| クラス | 例（ja） | 振る舞い |
|---|---|---|
| **Proximal（直前照応）** | それ／その／これ／この／上記 | 直前 bot の `TurnGrounding`（kept span / claim）を指差しコピー |
| **Non-proximal（非直前）** | さっきの／前の／先ほど／前に話した | **勝手に1件選ばない**。直近数ターンの例示（履歴スパンのコピー）+ 閉じた聞き返し |

「さっきの」で履歴 bot ≤1 のときのみ proximal にフォールバック。

明確化返答の骨格（コピーのみ）:

1. 閉じたオープナー（`CLARIFY_OPEN`）
2. 直近 bot grounding の `excerptTexts` を `echo` で列挙（`CLARIFY_SEP` 区切り）
3. 閉じた締め（`CLARIFY_CLOSE`）

`OpStep`: `closed`（clarify-open/sep/close）+ `echo`（履歴コピー）。`operation: "clarify"`。

## データモデル

```ts
type TurnGrounding = {
  chunkId: string;
  claim?: string;
  lang?: Lang;
  kept?: SpanRef[];
  excerptTexts: string[];
  operation?: ... | "clarify";
  parts?: { chunkId; claim?; excerptTexts }[];
};

// ChatMessage.grounding / TraceStep.priorGrounding / turnGrounding / anaphora
```

## 段階

| 段階 | 内容 | 状態 |
|---|---|---|
| **G6a** | `TurnGrounding` の付与・history 持ち越し・`priorGrounding` トレース | ✅ |
| **G6b-proximal** | それ／その → `injectProximal` で検索・gate・plan 用クエリに excerpt を前置 | ✅ |
| **G6b-clarify** | さっきの → retrieve 前に `planClarifyRecent`（例示+聞き返し） | ✅ |
| **G6c** | 前ターン claim/span 継続バイアス（`usedIds` と両立） | 予定 |
| **G6d** | 連鎖の計画化（任意・後回し可） | 任意 |

## パイプライン

```
history(+ grounding)
  → classify anaphora
  → (non-proximal ∧ ≥2 bots) clarify short-circuit
  → (proximal) inject prior excerpt into planning query
  → retrieve → gate → G5 candidates → G5d → render
  → message.grounding + trace
```

## 評価

```bash
npm run eval:g6a
npm run eval:g6b
npm run eval:plan
```

## フォローアップ

- G6c 継続バイアス
- 明確化文言のコーパス claim 化（任意）
- G6d 連鎖プランナーの要否
