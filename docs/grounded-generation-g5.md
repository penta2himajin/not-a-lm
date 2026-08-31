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
```

- `trace.operationPlan` — 監査用の完全なレシピ
- `trace.operation` — 互換のための派生ラベル（`deriveOperationLabel`）。移行完了後に plan のみへ切り替え予定

## パイプライン

```
retrieve → gate → G5 plan → render → reply
```

1. reranker 可なら `fuseCompound` マッチを試す（**G5c**: トップチャンクの極性で fuse を阻害しない）
2. fuse 成功 → `planFuseParts`（**セグメントごと** NLI + G4 compose）
3. 否则 `planSingleChunk`
4. `renderOperationPlan` → reply

## G5a / G5b / G5c

| 段階 | 内容 | 状態 |
|---|---|---|
| G5a | plan/render 切り出し・挙動同一 | ✅ |
| G5b | トレース UI に `plan · …` と `reasons` | ✅ |
| G5c | 極性×fuse 共存（パート単位 NLI） | ✅ |

## 評価

```bash
npm run eval:plan             # render / derive / G5c polarity×fuse
npm run eval:compose
npm run eval:g4c:compose
npm run eval:fusion-g4
npm run eval:corpus-spans
```

## フォローアップ

- **G5d** — 複数 candidate plan のスコア選択
- 操作粒度: ラベル互換を保ったまま移行できたら `operation` を plan 派生のみ／廃止
