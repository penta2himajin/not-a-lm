# NLI 量子化評価（接地生成）

`onnx-community/multilingual-MiniLMv2-L6-mnli-xnli-ONNX` の q8 量子化を、埋め込み・リランカー（PR #7/#8）と同様に再検証した。

## 結論

**q8 は不採用。fp32 必須のまま。**

q8 は決定的だが、接地生成の核心指標である **negate-correct が 9/9 → 4/9 に劣化**する。閾値（`NLI_ENTAIL_MIN=0.5`）の調整では中立質問の誤補正リスクとトレードオフになり、実用不可。

## 評価結果

| 検査 | fp32 | q8 |
|---|---|---|
| 5連続推論の決定性 | 0 fail | **0 fail** |
| negate-correct（偽前提→entailment） | **9/9** | 4/9 |
| neutral（誤補正なし） | 3/3 | 3/3 |
| affirm | 1/3 | 1/3 |

### q8 で落ちる例（fp32 では entail ≥ 0.5）

| 言語 | 質問 | fp32 entail | q8 entail / ラベル |
|---|---|---|---|
| en | Do you generate with RAG? | entail ~0.99 | neutral 0.41 |
| en | Write me some code | entail ~0.99 | neutral 0.29 |
| zh | 帮我写点代码 | entail ~0.99 | neutral 0.39 |
| ja | 意識はある？ | entail ~0.99 | neutral 0.42 |
| en | Are you conscious? | entail ~0.99 | entail 0.40（< 0.5） |

## サイズ（参考）

| dtype | ONNX 目安 |
|---|---|
| fp32 | ~428MB |
| q8 | ~107MB |

約 75% 削減可能だが、接地生成のテーゼ（偽前提補正）が壊れるため採用しない。

## 環境変数

- `NLI_DTYPE` — デフォルト `fp32`。A/B 評価用に `q8` を指定可能（本番非推奨）。

## 評価スクリプト

```bash
npm run eval:nli:q8          # fp32 vs q8 ペア比較
npm run eval:nli:engine      # API 経由 negate-correct 9件（dev サーバー要）
```

## 今後の軽量化案

- 別の小型多言語 NLI モデルの探索（現行と同フレーミング premise=質問 / hypothesis=主張 で 9/9 を満たすもの）
- fp32 NLI の遅延ロードは既に実装済み（接地生成トグル ON 時のみ必要）
