# 接地生成 G5: 操作プランナー（OperationPlan）

G4 までで「1 ターンの grounded reply」（retrieve → gate → NLI → fuse → compose）は揃った。G5 は **判断（plan）と実行（render）を分離**し、返答構築を宣言的なステップ列として扱う。

## 動機

`engine.ts` の Stage 3–4 は if 連鎖で、極性 / fusion / compose が暗黙に排他されていた。G5 では:

- **Planner** が `OperationPlan`（`steps[]`）を組み立てる
- **Renderer** が steps を文字列化する（純関数に近い）
- 将来の合成（極性×fuse 等）は steps の組み合わせで表現する

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

## G5a（現行）

挙動は Stage 3–4 と同一:

1. `peekPolarity` — チャンク assertions の NLI
2. prefix が無いとき `fuseCompound` マッチ → `planFuseParts`
3. 否则 `planSingleChunk`（G4 compose / G2 legacy / as-is）
4. `renderOperationPlan` → reply

```
retrieve → gate → G5 plan → render → reply
```

## 評価

```bash
npm run eval:plan             # render / derive ユニット
npm run eval:compose          # G4 回帰
npm run eval:g4c:compose
npm run eval:fusion-g4
npm run eval:corpus-spans
```

## フォローアップ

- **G5b** — UI に `operationPlan.reasons` / steps を表示
- **G5c** — 極性×fuse 共存など、旧 if では無理だった合成を解禁
- **G5d** — 複数 candidate plan のスコア選択
- 操作粒度: ラベル互換を保ったまま移行できたら `operation` を plan 派生のみ／廃止
