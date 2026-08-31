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
- 前回の `composePlan` / `claim` / kept span は **トレースに残るだけで次ターンへ渡らない**

## 照応の二分類（設計合意）

| クラス | 例（ja） | 振る舞い |
|---|---|---|
| **Proximal（直前照応）** | それ／その／これ／この／上記 | 直前 bot の `TurnGrounding`（kept span / claim）を指差しコピー |
| **Non-proximal（非直前）** | さっきの／前の／先ほど／前に話した | **勝手に1件選ばない**。直近数ターンの例示（履歴スパンのコピー）+ 閉じた聞き返し |

「さっきの」で履歴≤1 のときのみ proximal にフォールバックしてよい。

明確化返答の骨格（コピーのみ）:

1. 閉じたオープナー（「どれのことですか。」系 — 言語別・コーパスまたは閉じた糊）
2. 直近 bot grounding の `excerptTexts` を短い例として列挙
3. 閉じた締め（「それ以外なら、どんなものだったか思い出せる範囲で教えて。」）

構造は G5 `OperationPlan` の分岐（例: `clarify-recent`）とし、文言の置き場はコーパス／閉じた糊。例示本文はコーパス固定ではなく **実行時履歴からコピー**。

## データモデル（G6a）

```ts
type TurnGrounding = {
  chunkId: string;
  claim?: string;
  lang?: Lang;
  kept?: SpanRef[];
  /** kept span texts, or full value when no compose — copy-only */
  excerptTexts: string[];
  operation?: "as-is" | "negate-correct" | "affirm-confirm" | "fuse" | "compose";
  /** fuse 追加パート（任意） */
  parts?: { chunkId: string; claim?: string; excerptTexts: string[] }[];
};

// ChatMessage.grounding — クライアントが history に載せて次ターンへ渡す
// TraceStep.priorGrounding — 直前 bot から読んだ grounding（監査）
// TraceStep.turnGrounding — 今ターンが付けた grounding（message と同内容）
```

## 段階

| 段階 | 内容 | 状態 |
|---|---|---|
| **G6a** | `TurnGrounding` の付与・history 持ち越し・`priorGrounding` トレース（挙動ほぼ同一） | ✅ |
| **G6b-proximal** | それ／その → 直前 grounding を実効クエリ／focus に注入 | 予定 |
| **G6b-clarify** | さっきの → 例示 + 閉じた聞き返し（plan + 糊／コーパス） | 予定 |
| **G6c** | 前ターン claim/span 継続バイアス（`usedIds` と両立） | 予定 |
| **G6d** | 連鎖の計画化（任意・後回し可） | 任意 |

## パイプライン（G6 完成形のイメージ）

```
history(+ grounding) → retrieve → gate
  → (G6b) proximal resolve | clarify plan
  → G5 candidates → G5d select → render
  → message.grounding + trace.prior/turnGrounding
```

## 評価

```bash
npm run eval:g6a              # TurnGrounding 抽出・直前参照
# G6b 以降で eval:g6 / engine ケースを追加
```

## フォローアップ

- en/zh の proximal / non-proximal 閉じた語彙表
- 明確化オープナー／締めのコーパス claim
- G6d 連鎖プランナーの要否（G6a–c 完了後に判断）
