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
  → classify anaphora → clarify | proximal inject
  → retrieve (+ G6c) → gate → G5 → render
  → grounding + optional trace.chain
```

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
