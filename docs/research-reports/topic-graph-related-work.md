# 調査記録：話題グラフ周辺の関連研究

日付: 2026-09-05  
文脈: not-a-lm の融合・多ターン接地を保ちつつ、「生成 LLM なしで LLM っぽい対話」に寄せる設計相談。  
前提方針:

- 応答本文の自由生成はしない（接地契約を維持）
- 言い換えはモデル生成ではなく **閉じた内部パラフレーズパターン** に留める
- 「話題グラフ」は世界の Knowledge Graph（KG）ではなく、**応答可能な話題（claim / QUD）と対話上の関係** の地図

「話題グラフ」という単一名の分野はない。近い知見は複数系統に散在する。本メモはその地図と、not-a-lm への示唆、読む優先順を固定する。

---

## 1. 系統マップ

| 系統 | 何を構造化するか | not-a-lm への近さ |
|------|------------------|-------------------|
| 意図・注意の談話理論 | 目的の木 + 注意スタック | ★★★（多ターン接地） |
| 修辞・談話関係（RST / SDRT） | 文・発話間の関係ラベル | ★★★（辺の語彙） |
| QUD（Questions Under Discussion） | 暗黙の「今答えるべき問い」の木 | ★★★（claim 設計） |
| 話題分割・トピック連続 | どこで話題が切れるか | ★★☆（分割・連続） |
| 対話行為（dialog acts） | ask / answer / clarify 等 | ★★☆（ルーティング属性） |
| 対話談話グラフ（近年 ML） | 発話ノード + 関係辺 + GNN 等 | ★☆（手法より関係集合） |
| 世界 KG / ISO Topic Maps | 実体・事実・文書索引 | ★（別物・補助程度） |

### KG との違い（再掲）

| | 通常の KG | ここで言う話題グラフ |
|--|-----------|----------------------|
| ノード | 実体・概念 | claim / 答えうる問い（QUD） |
| エッジ | 世界の関係（所属・因果など） | 対話・検索の関係（詳細化・対比・次問） |
| 目的 | 事実推論 | retrieval・融合・多ターン連続 |
| 出力 | しばしば文生成 | value / spans のコピー（現行契約） |

---

## 2. 主要文献と知見

### 2.1 Grosz & Sidner（1986）— 意図と注意

- Grosz, B. & Sidner, C. (1986). *Attention, Intentions, and the Structure of Discourse.* Computational Linguistics.
- PDF 例: <https://nlp.stanford.edu/acvogel/groszsidner.pdf>

談話を **3 層** に分ける:

1. **言語構造** — 発話がセグメントにまとまる  
2. **意図構造** — 各セグメントの目的（DSP）と支配関係  
3. **注意状態** — 焦点のスタック（動的）

**示唆**

- 「話題」は語の袋ではなく **目的 + 焦点**
- 割り込み・復帰はスタック push/pop（現行の proximal / non-proximal anaphora と同型）
- 静的コーパス辺と、実行時の注意スタックは **分けて設計**する

近年の非線形対話管理（例: Context-Agent / dynamic discourse trees）も、明示的にこの枠を参照することが多い。

### 2.2 RST — 修辞関係（辺語彙の出発点）

- Mann, W. & Thompson, S. (1987/88). Rhetorical Structure Theory.
- 対話への限界: Moore & Pollack 系（情報関係だけでは follow-up に足りない）。例: <https://aclanthology.org/J92-4007.pdf>

代表関係: Elaboration, Contrast, Evidence, Antithesis, Solutionhood など。

**示唆**

- コーパス辺ラベルの初期集合として実用的
- **nuclearity（核／衛星）** は fuse の primary=full / secondary=partial と対応づけやすい
- 対話だけでは不十分 → 意図層（Grosz）や QUD を併用

### 2.3 SDRT / STAC — 対話向け談話グラフ

- Asher & Lascarides, Segmented Discourse Representation Theory (SDRT)
- Asher et al., STAC corpus — multiparty dialogue + discourse relations  
  <https://aclanthology.org/L16-1432.pdf>

対話で多い関係の例: **QAP**（問い−答え）、Question-Elaboration、Acknowledgment、Correction、Elaboration、Contrast、Parallel。

**示唆**

- 厳密にやるなら構造は **木より DAG**（1 claim が複数の親関係を持てる）
- fuse の `parallel`、追い質問の `QAP` / Question-Elaboration が UX に直結
- Right Frontier（付けられる場所は限られる）≈ 遠い焦点への「それ」は clarify

### 2.4 QUD — 問いの木としての談話

- Roberts, Ginzburg, Beaver & Clark など
- 概説例: Riester et al., *Constructing QUD trees*  
  <https://www.ims.uni-stuttgart.de/documents/team/arndt/doc/17riesterQUDtrees.pdf>

談話は（暗黙の）問いの木で進み、各断言はどれかの QUD への答え、という見方。

**示唆（本リポジトリ向き）**

- claim を「文」ではなく **答えうる問いの集合** として書く
- 内部パラフレーズ / 厚い natKey = 同じ QUD への別入口（`same-intent`）
- follow-up 辺 = 子 QUD
- 拒否 = その QUD の答えがコーパスにない

エンティティ中心の KG より、**QUD / claim ノード**の方が現行コーパスと一致する。

### 2.5 話題分割・トピック連続

- TextTiling（Hearst）— 文書の話題境界
- SuperDialseg 等 — 対話 topic segmentation。対話行為が境界と相関しやすい（解決・無解のあとで区切られる等）  
  例: <https://arxiv.org/pdf/2305.08371>
- Xu et al. (2024). *Unsupervised Mutual Learning of Dialogue Discourse Parsing and Topic Segmentation*  
  <https://arxiv.org/html/2405.19799v1>  
  → **修辞構造と話題構造は別物だが相互に助ける**（言語学の古典的主張の計算版）
- Alexa 系 contextual topic modeling — 話題の深さ ↔ 対話評価の相関

**示唆**

- 「修辞辺」と「話題同一／転換」を同一ヒューリスティックに混ぜない
- 文内分割・ターン間シフト・claim リンクは別モジュール
- 対話行為（解決済みか）を話題転換のゲートに使える

### 2.6 近年の Dialogue Graph（ML）

例:

- DADgraph — discourse-aware dialogue GNN for multiparty MRC  
  <https://arxiv.org/pdf/2104.12377>
- MUDI 等 — discourse relations graph + persona
- Context-Agent — dynamic discourse trees for non-linear dialogue  
  <https://aclanthology.org/2026.findings-acl.1472.pdf>

多くは生成 LLM 前提。not-a-lm には **GNN 自体より、関係集合・非線形トピック木・topic-shift 明示** が参考になる。

### 2.7 隣接だが別物

| 名前 | 中身 | 扱い |
|------|------|------|
| Knowledge Graph | 世界の実体関係 | 中心にしない。用語定義など必要な claim のみ局所利用可 |
| ISO Topic Maps | 主題・出現・関連の索引 | 文書管理寄り。対話意図は薄い |
| FrameNet / スクリプト | 事象の役割構造 | タスク型の「次スロット」辺に吸収できる程度 |
| DAMSL 等の対話行為 | 発話の行為型 | 辺というよりノード／ゲート属性 |

---

## 3. not-a-lm への設計示唆（要約）

1. **層を分ける**（Grosz & Sidner / Moore & Pollack）  
   - 静的: claim 間の情報辺（Contrast, Elaboration, Parallel）  
   - 動的: 注意スタック（現行 grounding）  
   - 意図: 今の QUD

2. **辺ラベルは少数・対話向け**（RST ⊂ SDRT）  
   初期案: `elaborates | contrasts | parallel | follow-up | same-intent`

3. **ノードは QUD / claim**（エンティティではない）  
   パラフレーズは `same-intent`、融合は `parallel`、詳細は `elaborates`

4. **構造は浅い DAG**（STAC）

5. **話題境界 ≠ 修辞関係**（UMLF / 言語学）

6. **Right frontier / 焦点** — 既に近い実装あり。辺導入時も維持

7. **核／衛星** — fuse の full/partial の理論的裏付け

実装するなら、動的層（grounding）より先に効くのは **静的な claim 間の少数関係辺 + QUD としての claim 設計**。

---

## 4. 読む優先順

実装前の読書・共有用の推奨順。

| 優先 | 文献・資料 | 持ち帰ること |
|------|------------|--------------|
| 1 | Grosz & Sidner 1986 | 意図 / 注意 / 言語の三層。スタックとしての焦点 |
| 2 | QUD 入門（Roberts 概説、または Riester *Constructing QUD trees*） | claim = 答えうる問い、という設計単位 |
| 3 | RST 関係一覧（Mann & Thompson 系の短いサーベイで可） | 辺ラベルの出発点、nuclearity |
| 4 | STAC 論文の関係頻度表（L16-1432） | 対話で実際に多い関係（QAP 等） |
| 5 | UMLF 2024（話題分割 × 修辞の相互学習） | 話題構造と修辞構造を混ぜない理由の現代版 |
| 6（任意） | DADgraph / Context-Agent | グラフ実装の雰囲気。手法そのものは必須でない |
| 7（任意） | SuperDialseg | 対話行為と話題境界の相関 |

---

## 5. 本リポジトリ内の関連ドキュメント

- **作業 SoT（段階・ゲート・評価方針）:** [`../topic-graph-work-sot.md`](../topic-graph-work-sot.md)
- 上位契約: [`../grounding-contract.md`](../grounding-contract.md)
- 融合・分割: [`../grounded-generation.md`](../grounded-generation.md)
- 多ターン接地: [`../grounded-generation-g6.md`](../grounded-generation-g6.md)
- 埋め込み / リランカ / NLI 選定:  
  [`../embedding-model-selection.md`](../embedding-model-selection.md),  
  [`../reranker-model-selection.md`](../reranker-model-selection.md),  
  [`../nli-model-selection.md`](../nli-model-selection.md)

---

## 6. 未決・次の相談メモ

作業プログラムへ移行済み（[`../topic-graph-work-sot.md`](../topic-graph-work-sot.md)）。残る詳細は各段階の [R][D] で凍結する。

- 辺をコーパス JSON にどう書くか（著者編集 vs 半自動提案）→ S3/S4
- 実行時の効かせ方（retrieval ボーナス / fuse 候補制約 / follow-up 提案）→ S3/S4
- 自然さ LLM-as-judge のルーブリック第1版 → S2 [D]
- 接地ゲートの機械チェック項目の拡充 → 評価方針どおり SoT §2 で分離維持

---

## 変更履歴

- 2026-09-05: 初版（対話調査・設計相談の記録）
