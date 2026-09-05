# S3 調査記録：RST 風静的辺と nuclearity

日付: 2026-09-05  
段階: 話題グラフ SoT **S3 [R]**  
上位: [`../topic-graph-work-sot.md`](../topic-graph-work-sot.md)  
前提: [`topic-graph-related-work.md`](topic-graph-related-work.md) / S1・S2 メモ

目的: claim 間の **著者定義・情報的（informational）静的辺** の最小語彙と、現行 fuse の full/partial との対応を固定する。  
非目標: 自由生成、世界 KG、対話辺（follow-up / QAP → S4）、注意スタックの置換。

---

## 1. RST の要点（対話ボット向けに削る）

文献:

- Mann, W. & Thompson, S. (1987/88). Rhetorical Structure Theory.
- SFU RST サイト（関係定義・nuclearity）: <https://www.sfu.ca/rst/01intro/intro.html>
- Moore, J. & Pollack, M. (1992). *A Problem for RST: The Need for Multi-Level Discourse Analysis.* CL 18(4). <https://aclanthology.org/J92-4007.pdf>

RST は EDU（節相当）を **核（nucleus）／衛星（satellite）** 付きの関係で木にまとめる。

| 区分 | 意味 | 例 |
|------|------|----|
| **単核（mononuclear）** | 一方が目的の中心、他方が補助 | Elaboration, Evidence, Background |
| **多核（multinuclear）** | 両方が同格 | Contrast, Parallel / List, Sequence |

対話ボット（コピー融合）に必要なのは「全文法」ではなく、**融合と話題つなぎに効く少数ラベル**である。

---

## 2. 最小関係集合（本段階の提案）

STAC / SDRT 系の対話頻度と、現行 fuse（複合質問の二部マッチ）を踏まえ、S3 では次の **3 ラベルのみ**とする。

| ラベル | RST 対応 | nuclearity | not-a-lm での意味 |
|--------|----------|------------|-------------------|
| `elaborates` | Elaboration | 単核: **from=核, to=衛星** | 詳細化・一段深い説明（S2 `detailClaim` のグラフ形） |
| `contrasts` | Contrast | 多核 | 対比・できる／できない等の並置 |
| `parallel` | Parallel / Joint | 多核 | 同格の並列トピック（複合 fuse の典型） |

**採らない（S3）:** Evidence, Cause, Antithesis, Solutionhood, Restatement, Sequence など。  
**S4 へ先送り:** `follow-up`, QAP, Acknowledgment 等の **対話（intentional）辺**。

---

## 3. nuclearity ↔ 現行 fuse compose

現行 `planFuseParts`:

- 先頭パート → compose `full`（核相当・狭めにくい）
- 2 番目以降 → compose `partial` + `stripFiller`（衛星相当・焦点に合わせて削る）

対応規則（S3 凍結案）:

1. 融合パート集合に `elaborates(A→B)` があるとき、**A を先頭（full）・B を後段（partial）** に並べ替える。
2. `parallel` / `contrasts` は多核 → **セグメント順（クエリ順）を維持**。CE 二部マッチの割当は崩さない。
3. 辺は **候補の優先・並べ替え・監査** に使い、`classifyAnaphora` や注意スタックを置換しない（S1 境界）。

---

## 4. Moore & Pollack：情報辺だけでは follow-up に足りない

Moore & Pollack (1992) の主張の要約:

- RST の関係には **情報的** と **意図的** が混在し、1:1 対応しない。
- インタラクティブな説明対話では、**意図構造**（Grosz & Sidner の DSP）がないと「なぜそう言ったか」への follow-up に答えられない。
- したがって RST 表現だけでは対話システムの応答制御に不十分。

**本リポジトリへの橋:**

| 層 | S3 での扱い | 次段 |
|----|-------------|------|
| 情報辺（elaborates / contrasts / parallel） | 静的コーパス辺として導入 | — |
| 意図・対話辺（follow-up / QAP） | **作らない** | S4 |
| 注意スタック | 実行時のまま（G6） | 静的辺とマージしない |

S3 完了後も「詳しく」は S2 の `detailClaim` / proximal 経路が主。静的 `elaborates` は fuse・検索ボーナスと監査用の正本に寄せる。

---

## 5. コーパス上の書き方（[D] へ渡す草案）

claim YAML 直下:

```yaml
edges:
  - rel: elaborates
    to: mech-1-detail
  - rel: parallel
    to: mech-existing
```

- `rel` ∈ `elaborates | contrasts | parallel`
- `to` は他 claim id（同一ファイル内自己辺禁止）
- `parallel` / `contrasts` は索引時に **無向化**（両方向参照）
- `elaborates` は **有向**（核 → 衛星）
- S2 `detailClaim` がある場合、対応する `elaborates` 辺を推奨（糖衣として `detailClaim` は残す）

---

## 6. retrieval / fuse への効かせ方（[D] 草案）

| 経路 | 効かせ方 | 理由 |
|------|----------|------|
| **fuse 二部マッチ** | 辺で結ばれた claim ペアに小さな CE スコアボーナス | 複合質問で意図した並置を選びやすくする |
| **fuse 並べ替え** | `elaborates` 核を full 側へ | nuclearity ↔ full/partial |
| **retrieval** | continuity 先の辺隣接に小さな加算 | 話題のつなぎを弱く助ける（注意置換ではない） |
| **表示** | `discourseLayerHints.intentional` に使用辺を監査 | 本番本文はコピーのみ |

非採用: 辺だけで候補をハードフィルタする（カバレッジ低下のリスク）。

---

## 7. [R] 結論チェックリスト

- [x] 関係最小集合: `elaborates | contrasts | parallel`
- [x] nuclearity ↔ full/partial 対応を定義
- [x] Moore & Pollack 限界を明示し S4 へ橋渡し
- [ ] [D] で SoT に凍結文を書き込む（次ゲート）
