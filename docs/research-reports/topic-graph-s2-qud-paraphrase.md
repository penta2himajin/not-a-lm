# S2 調査記録：claim = QUD と閉じたパラフレーズ

日付: 2026-09-05  
段階: 話題グラフ SoT **S2 [R]**  
上位: [`../topic-graph-work-sot.md`](../topic-graph-work-sot.md)  
前提: [`topic-graph-related-work.md`](topic-graph-related-work.md), [`topic-graph-s1-centering-mapping.md`](topic-graph-s1-centering-mapping.md)

目的: ノードを「答えうる問い（QUD）」として明示し、入口言い回しを **閉じた集合**で増やす設計を固定する。  
非目標: LLM による自由言い換え生成、世界 KG、本番経路での生成。

---

## 1. QUD と claim

Roberts / Riester 系の QUD 観では、談話は（暗黙の）問いのスタック／木で進み、各断言はどれかの QUD への答えである。

| QUD 概念 | not-a-lm での対応 |
|----------|-------------------|
| 今答えるべき問い | claim の代表問い `qud` |
| 同じ問への別の言い方 | `sameIntent[]`（閉じた入口） |
| 子問い・深掘り | `detailClaim`（詳しく／どういうこと → 別 claim のコピー） |
| 答えがない | 既存の拒否／低信頼ゲート |

近年の QUD パース（QUDEval, QUDSelect 等）は **問い生成**が中心で、本リポジトリの接地契約と衝突する。借りるのは「claim = 答えうる問い」という単位だけ。

---

## 2. 生成なしの intent / paraphrase 正規化

IR・対話の定石:

1. **著者定義の言い換えバンク**（クラシック）— 同義語・言い回しを人手で閉じた集合に置く。
2. **クエリ側の展開**（同義語辞書・テンプレ）— 実行時にクエリを膨らませる。
3. **文書側の展開**（厚い nat / alias をインデックス）— コーパス側に入口を増やす。
4. **LLM パラフレーズ／HyDE** — 本プログラムの非目標。

本リポジトリ向きは **(3) 文書側・閉じた `sameIntent`**。理由:

- 接地契約を破らない（生成なし）。
- 既存の「厚い nat」慣習と連続。
- クエリ書き換えより監査しやすい（YAML に残る）。

`same-intent` は **辺ラベルとしてはまだ持たない**（S3/S4）。S2 では同一 claim 内の入口集合として扱い、検索は natKey への連結で効かせる。

---

## 3. 「詳しく」問題（ベースライン観察）

pre-S2 ベースラインでは、proximal elaboration pin が **同一 claim を再掲**する。話題逸脱よりはマシだが、深掘りにならない。

対策（生成なし）:

- 親 claim に `detailClaim: <id>` を置き、elaboration 時は **子 claim の value をコピー**。
- 子 claim も通常の YAML（接地可能・トレース可能）。

---

## 4. [R] → [D] への入力

1. `qud`（代表問い）を claim メタに置く。
2. `sameIntent` は言語表面の閉じた文字列配列。インデックス時に natKey へ連結。
3. `same-intent` 辺やクエリ正規化 LLM は作らない。
4. `detailClaim` で elaboration を別コピーへ振る。
5. 自然さ評価は凍結ベースラインとの pairwise（A=新ライブ, B=凍結）。

---

## 変更履歴

- 2026-09-05: S2 [R] 初版。
