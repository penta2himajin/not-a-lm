# S1 調査記録：Grosz & Sidner 三層 ↔ 現行 G6 / anaphora / fuse

日付: 2026-09-05  
段階: 話題グラフ SoT **S1 [R]**  
上位: [`../topic-graph-work-sot.md`](../topic-graph-work-sot.md)  
前提調査: [`topic-graph-related-work.md`](topic-graph-related-work.md)

目的: 「話題グラフ」実装に入る前に、Grosz & Sidner (1986) の三層が現行コードのどこに既にあるか／どこが未分離かを固定する。  
非目標: 世界 Knowledge Graph の導入、応答本文の自由生成。

---

## 1. Grosz & Sidner (1986) の三層（要約）

文献: Grosz, B. & Sidner, C. (1986). *Attention, Intentions, and the Structure of Discourse.* Computational Linguistics 12(3).  
Anthology: <https://aclanthology.org/J86-3001/>

| 層 | 内容 | 性質 |
|----|------|------|
| **Linguistic structure** | 発話が談話セグメントにまとまる表面構造 | 観測可能な分割 |
| **Intentional structure** | 各セグメントの談話目的（DSP）と支配／満足先行 | 比較的安定した目的の木 |
| **Attentional state** | 焦点空間の **スタック**（動的） | ターンごとに push/pop。意図構造そのものではない |

要点（本リポジトリ向け）:

1. **注意はスタック**であり、明示グラフで全枝をマージすると局所一貫性が壊れやすい（近年の Context-Agent も同主張）。
2. 焦点スタックは、支配候補の DSP を **局所化**する（遠い焦点への「それ」は曖昧 → clarify）。
3. 言語・意図・注意は **混ぜて一つの「トピックスコア」にしない**。

---

## 2. 現行 not-a-lm との対応表

### 2.1 層マッピング

| Grosz & Sidner | 現行の主な置き場 | 記号・ファイル | 備考 |
|----------------|------------------|----------------|------|
| **Linguistic** | クエリ分割・融合パーティション | `segmentCandidates` / `compoundSegments`（`segment.ts`, `engine.ts`）; fuse の `fuseParts` | 文／セグメント境界。CE 再スコア済み。静的コーパス辺ではない |
| **Intentional（proto）** | claim を答えの単位として扱う | `chunk.claim`, `OperationPlan`, G5d plan score, G6d `ChainPlan` | まだ明示 QUD 木ではない。S2 で claim = QUD に硬化 |
| **Attentional** | 直前接地・照応・連続 | `TurnGrounding`, `classifyAnaphora`, `proximalFocusRef`, `continuityFromPrior`（`grounding.ts`）; trace の `anaphora` / `continuity` / `proximalFocus` | **実行時のみ**。コーパス JSON にスタックを書かない |

### 2.2 振る舞いの同型

| 談話現象 | Grosz & Sidner | 現行実装 |
|----------|----------------|----------|
| 直前への短い追従 | トップ焦点の維持 | `anaphora === "proximal"` → focus-ref（クエリ連結なし）+ G6c continuity |
| 「さっきの」「先ほど」 | スタック上の非局所参照 | `non-proximal` → clarify（勝手に1件選ばない） |
| 話題転換 | pop / 新 DSP | continuity を proximal 時のみ（張り付き防止） |
| 複合発話 | 複数セグメント | fuse + segment CE rescoring |
| 割り込み後の復帰 | スタック pop で下位へ | 明示スタック未実装。現状は「直前1ホップ + clarify」が近似 |

### 2.3 明示的に「ない」もの（S1 で確認）

| 概念 | 状態 |
|------|------|
| 世界 KG（実体グラフ） | **作らない**（接地契約・SoT 非目標） |
| 永続的な注意スタック永続化 | なし。クライアントが `message.grounding` を履歴でエコー |
| 静的 claim 間修辞辺 | なし → S3 |
| 対話関係 DAG（QAP 等） | なし → S4 |
| claim の閉じたパラフレーズ集合 | 部分的（natKey 等）→ S2 |

---

## 3. 近年の non-linear dialogue から、生成なしで使える着想

### 3.1 Context-Agent / dynamic discourse trees（ACL Findings 2026 系）

- 対話履歴を平坦系列ではなく **動的木／森**として扱う。
- 明示的に Attentional State（Grosz & Sidner）に整合: **焦点はスタック／木のパス**であり、意味類似だけでノードをマージするグラフは枝を混線させやすい。
- NTM 等の非線形ベンチは生成 LLM 前提が多い。

**生成なしで持ち帰れるもの**

| 着想 | not-a-lm での使い方 |
|------|---------------------|
| 枝の論理的隔離 | proximal 以外で continuity を切る（既存）。将来の注意スタックも「同一枝のみ参照可」 |
| ナビ意図（topic switch / refine） | dialog-act 風ゲート属性として S5。辺ラベル本体にはしない |
| パス検索（孤立ノード検索ではない） | retrieval は claim／span。履歴側は grounding チェーンでパス近似 |
| 意味類似だけの統合を避ける | fuse / segment は CE、照応は規則。埋め込みだけで「同じ話題」と決めない |

### 3.2 STAC / Right Frontier（関連調査から再掲）

- 付けられる談話関係の場所は限られる ≈ 遠い焦点は clarify。
- 静的辺は浅い DAG でよいが、**実行時の現在焦点はスタック／右端**に留める（静的グラフで注意を置換しない）。

### 3.3 UMLF 系（話題分割 × 修辞）

- 話題境界と修辞辺は別モジュール（S5）。S1 時点では linguistic = 分割、intentional/修辞辺 = 未、attentional = 実行時、と分離できていれば十分。

---

## 4. 設計結論（S1 [R] → [D] への入力）

1. **KG を作らない。** ノード候補は claim / QUD のみ。
2. **注意 = 実行時スタック（現状は1ホップ grounding + anaphora）。** コーパスに焦点を永続化しない。
3. **静的に置くもの**は後段: claim メタ（S2）、修辞辺（S3）、対話辺（S4）。
4. **言語層**は既に `segment` / fuse にあり、話題グラフの静的辺と混ぜない。
5. 近年の discourse tree 研究からは **枝隔離・ナビ意図・パス一貫性**だけを借り、GNN／生成は借りない。

完了条件チェック（SoT S1）:

- [x] 対応表が research-reports に残った（本ファイル）
- [x] 「KG を作らない」「注意は実行時スタック」を明文にした（§2.3, §4）

---

## 変更履歴

- 2026-09-05: S1 [R] 初版。三層対応表・非線形対話からの借用範囲・非目標の固定。
