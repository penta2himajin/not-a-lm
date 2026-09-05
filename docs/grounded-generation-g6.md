# 接地生成 G6: 多ターン接地

G5 までで **1 ターン**の grounded reply（宣言的 `OperationPlan` → render）は揃った。G6 はそれを **時間方向**へ拡張する: 履歴をコピー単位で指差し、照応を解決し、必要なら意図を明確化する。

制約は不変: **コーパス／履歴スパンのコピー + 閉じた糊 + クエリ／履歴から抜いた topic**。トークン生成なし。

## Grosz & Sidner 三層との対応（S1）

話題グラフ作業 SoT の S1 で固定。詳細対応表: [`research-reports/topic-graph-s1-centering-mapping.md`](research-reports/topic-graph-s1-centering-mapping.md)。

| 層 | G6 での意味 | 主な記号 |
|----|-------------|----------|
| **Linguistic** | 発話の分割・融合セグメント | `segmentCandidates` / `compoundSegments` / fuse |
| **Intentional** | claim（proto-QUD）。明示 QUD 木は S2 | `chunk.claim` / `OperationPlan` / `ChainPlan` |
| **Attentional** | **実行時のみ**の焦点（世界 KG ではない） | `TurnGrounding` / anaphora / proximal / continuity |

監査: `trace.debug.discourseLayerHints`（linguistic / intentional / attentional）。

## ロードマップ番号（合意）

| 番号 | 内容 |
|---|---|
| **G6** | 多ターン接地（本ドキュメント） |
| **G7** | コーパス編集オペレータ（作者側） |
| **G8** | ANN・自律収集・依存監査 |
| **G9** | 検証・自己監査ループ（出力 ⊆ コーパス ∪ 閉じた糊） |

## 照応の二分類

| クラス | 例（ja） | 振る舞い |
|---|---|---|
| **Proximal** | それ／その／これ／この／上記 | 直前 bot grounding を指差しコピー |
| **Non-proximal** | さっきの／先ほど… | 例示 + 閉じた聞き返し（勝手に1件選ばない） |

## 段階

| 段階 | 内容 | 状態 |
|---|---|---|
| **G6a** | `TurnGrounding` 持ち越し | ✅ |
| **G6b-proximal / clarify** | 照応二分類 | ✅ |
| **G6c** | 継続バイアス ↔ `usedIds` | ✅ |
| **G6d** | 連鎖の計画化（`ChainPlan`） | ✅ |

### unify-workflow 更新（追加モデルなし）

- Proximal: excerpt を検索クエリへ連結しない（`proximalFocusRef` → compose focus のみ）
- G6c: `anaphora === "proximal"` のときだけ continuity
- 短い追従「何が」「どういうこと」も proximal（規則）
- bot 本線は常に接地計画（UI の generate トグル廃止）

## G6d: 連鎖プラン

オープンループの `predict-user` → `reply` を、**宣言的な多ターンレシピ**に置き換える。

```ts
type ChainStep = {
  index: number;
  role: "user" | "bot";
  claim?: string;
  resolve: "corpus" | "generate"; // user=corpus, bot=generate（自由度）
  reason: string;
};
type ChainPlan = { id; lang; seedClaim; pairCount; steps; reasons };
```

- **監査**: 各ターンに `trace.chain`（planId / stepIndex / claim / resolve / reason）。UI に `chain-plan · …`
- **自由度**: bot は `resolve:"generate"` のまま → 既存の G5 + G6a–c が効く。user だけ claim 固定で再現可能
- **API**: `mode: "chain-plan"` / `mode: "emit-claim"`
- **レシピ**: `CHAIN_DEMO_USER_CLAIMS`（言語別 claim 列）。拡張は配列を足すだけ

```
chain-plan → seed reply(chain-start)
  → for step: emit-claim(user) | reply(bot, generate)
```

## パイプライン（1 ターン）

```
history(+ grounding)
  → classify anaphora → clarify | proximal focus-ref (no query concat)
  → retrieve (+ G6c if proximal) → gate → G5 → render
  → grounding + optional trace.chain
```

## G6b / G6c（unify-workflow 更新）

- **Proximal**: 直前 excerpt を検索クエリへ連結しない。`proximalFocusRef` で compose の focus にだけ渡す。
- **Continuity (G6c)**: `anaphora === "proximal"` のときだけ効かせる（話題転換での張り付き防止）。
- 短い追従「何が」「どういうこと」等も proximal 扱い（規則）。

## 評価

```bash
npm run eval:g6a
npm run eval:g6b
npm run eval:g6c
npm run eval:g6d
```

## フォローアップ

- レシピに bot claim 固定（`resolve:"corpus"`）を混ぜるモード
- 明確化文言のコーパス claim 化
- en/zh シード文言での連鎖ボタン（現状デモは ja 起点）
- **G7 コーパス編集** — [`grounded-generation-g7.md`](grounded-generation-g7.md)
