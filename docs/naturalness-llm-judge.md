# 自然さ LLM-as-judge（オフライン）

SoT [`topic-graph-work-sot.md`](topic-graph-work-sot.md) §2 の **自然さ系統**用ハーネス。  
接地は採点しない。本番チャット経路には載せない。

## 必要な環境変数

| 変数 | 必須 | 説明 |
|------|------|------|
| `OPENROUTER_API_KEY` | はい | OpenRouter API キー（Cloud Agent Secrets 推奨） |
| `JUDGE_MODEL` | いいえ | 既定: `nvidia/nemotron-3-super-120b-a12b:free` |

## 既定モデル（無料枠）

実機スモーク（2026-09-05）で JSON 判定が通った無料モデル:

| 優先 | Model ID | メモ |
|------|----------|------|
| 既定 | `nvidia/nemotron-3-super-120b-a12b:free` | 速い・JSON 安定 |
| フォールバック | `minimax/minimax-m2.7:free` | JSON 安定 |
| フォールバック | `inclusionai/ling-3.0-flash-sante:free` | 可用時 |
| 最終 | `openrouter/free` | ルータ任せ（thinking 系に当たると失敗しうる） |

有料の Sonnet 等に切り替える場合:

```bash
JUDGE_MODEL=anthropic/claude-sonnet-4.6 npm run eval:naturalness-judge
```

## 使い方

```bash
npm run eval:naturalness-judge
npm run eval:naturalness-judge -- --no-debias   # 位置入れ替えなし（1パス）
npm run eval:naturalness-judge -- --limit=2     # 先頭 N 件だけ
```

Fixture: [`fixtures/naturalness-judge/cases.json`](../fixtures/naturalness-judge/cases.json)  
実装: [`src/lib/notalm/naturalness-judge.ts`](../src/lib/notalm/naturalness-judge.ts)

## 判定仕様

1. システムプロンプトで **tempo / coherence / humanlikeness** のみ採点。
2. **質問への噛み合い・話題維持**は coherence（自然さ）として評価。雑談逸脱を「人間らしい」として過大評価しない。
3. 出力は JSON のみ（`winner`: `A` \| `B` \| `tie`）。
4. 既定で **A/B を入れ替えた 2 パス**を取り、多数決で位置バイアスを緩和。
5. `429` / JSON パース失敗時は無料フォールバックモデルへ順にリトライ。

## 非目標

- 接地・事実正誤の採点（別系統）。
- 本番 API への組み込み。
- 自由言い換え生成。
