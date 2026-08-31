# 接地生成 G5: 操作プランナー（OperationPlan）

G4 までで「1 ターンの grounded reply」（retrieve → gate → NLI → fuse → compose）は揃った。G5 は **判断（plan）と実行（render）を分離**し、返答構築を宣言的なステップ列として扱う。

## 動機

`engine.ts` の Stage 3–4 は if 連鎖で、極性 / fusion / compose が暗黙に排他されていた。G5 では:

- **Planner** が `OperationPlan`（`steps[]`）を組み立てる
- **Renderer** が steps を文字列化する（純関数に近い）
- 合成（極性×fuse 等）は steps の組み合わせで表現する

制約は不変: **コピー + 閉じた糊 + クエリから抜いた topic**。トークン生成なし。

## データモデル

```ts
type OpStep =
  | { kind: "prefix"; which: "negate-correct" | "affirm-confirm" }
  | { kind: "body"; chunkId: string; composePlan?: ComposePlan; stripFiller?: boolean }
  | { kind: "glue"; template: "topic"; topic: string };

type OperationPlan = { steps: OpStep[]; reasons: string[] };

type PlanCandidate = {
  id: "fuse" | "single";
  plan: OperationPlan;
  signals: { relevance; nliEntail?; bodies; hasCompose; hasPolarity };
};
```

- `trace.operationPlan` — 監査用の完全なレシピ（`reasons` に `g5d:pick` / `g5d:rank`）
- `trace.operation` — 互換のための派生ラベル（`deriveOperationLabel`）。移行完了後に plan のみへ切り替え予定

## パイプライン

```
retrieve → gate → G5 candidates → G5d score/select → render → reply
```

1. fuse 候補: `fuseCompound` → `planFuseParts`（**G5c**: セグメントごと NLI + G4 compose）
2. single 候補: `planSingleChunk`（極性 + compose）
3. **G5d** `selectBestPlan` — 閉じたヒューリスティックで最高スコアを採用（fuse 自動優先は廃止）
4. `renderOperationPlan` → reply

### G5d スコア（概要）

```
score ≈ 2·relevance·(1 + 0.35·(bodies−1))
      + 0.35·hasCompose
      + 0.4·max(nliEntail, 0.5)·hasPolarity
```

- `relevance`: fuse はパート rerank 平均、single は gate / top score
- 弱い fuse（境界付近のマッチ）は、強い極性+compose の single に負ける

## G5a–d

| 段階 | 内容 | 状態 |
|---|---|---|
| G5a | plan/render 切り出し・挙動同一 | ✅ |
| G5b | トレース UI に `plan · …` と `reasons` | ✅ |
| G5c | 極性×fuse 共存（パート単位 NLI） | ✅ |
| G5d | 複数 candidate のスコア選択 | ✅ |

## 評価

```bash
npm run eval:plan             # render / derive / G5c / G5d
npm run eval:compose
npm run eval:g4c:compose
npm run eval:fusion-g4
npm run eval:corpus-spans
```

## フォローアップ

- 操作粒度: ラベル互換を保ったまま移行できたら `operation` を plan 派生のみ／廃止
- （任意）候補 ID 拡張（例: second-hit single）や重みの調整は eval で回帰を見てから
- **G6 多ターン接地** — [`grounded-generation-g6.md`](grounded-generation-g6.md) ✅
- **G7 コーパス編集** — [`grounded-generation-g7.md`](grounded-generation-g7.md)
