# SoT：話題グラフ／対話自然さ改善プログラム

**Status:** Source of Truth（作業方針・段階ゲート）  
**Updated:** 2026-09-05  
**上位契約:** [`grounding-contract.md`](grounding-contract.md)  
**調査根拠（読み物）:** [`research-reports/topic-graph-related-work.md`](research-reports/topic-graph-related-work.md)  
**S1 対応表:** [`research-reports/topic-graph-s1-centering-mapping.md`](research-reports/topic-graph-s1-centering-mapping.md)

この文書は、話題グラフ寄りの改善を **5 段階**で進めるための方針と作業指示である。  
実装の細部は各段階の「研究レビュー → 詳細凍結」で決め、ここにゲートと非目標だけを固定する。

---

## 0. 置き場所について

| 種類 | 置き場 | 理由 |
|------|--------|------|
| **本 SoT（方針・段階・ゲート）** | `docs/topic-graph-work-sot.md`（本ファイル） | 接地契約と同じく **運用の正**。エージェント／人間が毎回開く |
| **調査スナップショット** | `docs/research-reports/` | 日付付きの文献メモ。改訂は追記・新ファイル可 |
| **機構ドキュメント** | `docs/grounded-generation*.md` 等 | 実装済み仕様。段階完了後にここへ反映 |

`research-reports` だけに SoT を置くと「読み物」と「今従う手順」が混ざる。  
**手順の正は `docs/` 直下、根拠の正は `research-reports/`** に分ける。

---

## 1. 目標と非目標

### 目標

- 生成 LLM なしで、**対話の流れ・話題の出し方・人間っぽさ**を上げる。
- 手段の中心は **話題グラフ**（claim / QUD ノード + 対話・修辞辺）と、それに整合する分割・融合・多ターン接地。
- 言い換えは **閉じた内部パラフレーズパターン**のみ（モデルによる自由言い換えはしない）。

### 非目標

- 本番経路での応答本文生成（接地契約に反する）。
- 世界 Knowledge Graph の本格導入（必要なら claim 局所の事実辺に限る）。
- 自然さ判定と接地判定を **同一の LLM judge** に混在させること。

---

## 2. 評価方針（固定）

二系統を **必ず分離**する。

| 系統 | 見るもの | 方法 |
|------|----------|------|
| **自然さ・人間っぽさ** | テンポ、話題遷移、つながり、違和感の少なさ | **LLM-as-judge（オフライン）**。好みの「生成っぽい上手さ」を明示的に採点してよい |
| **接地** | コーパス外主張、再構成可能性、トレース契約 | **別途**ルール／トレース／既存 CE・NLI 等。本プログラムの judge プロンプトには載せない |

運用ルール:

1. 回帰の主系列は、接地ゲートを通った出力だけを自然さ比較に回す（混線防止）。
2. 自然さは可能なら **改善前後 pairwise** を優先（絶対スコアは補助）。
3. Judge は本番 API に載せない（評価ハーネス／CI 任意ジョブ）。
4. 小さな金セットで人間との一致を時々校正する。

**実装（整備済み）:** OpenRouter 経由のオフライン pairwise judge。  
手順・無料モデル既定値: [`naturalness-llm-judge.md`](naturalness-llm-judge.md)。  
実行: `npm run eval:naturalness-judge`（要 `OPENROUTER_API_KEY`）。  
既定モデルは無料枠 `nvidia/nemotron-3-super-120b-a12b:free`（`JUDGE_MODEL` で変更可）。

段階ごとの具体ルーブリックは、その段階の研究レビュー後に凍結し、本 SoT の該当節へ追記する。

**自然さベースライン（pre-S3 固定・22件）:**  
[`fixtures/naturalness-judge/baselines/pre-s3-2026-09-05.json`](../fixtures/naturalness-judge/baselines/pre-s3-2026-09-05.json)  
（旧 pre-S2 の 5 件セットは履歴。S3 以降の回帰は pre-S3 を使う）  
比較: `npm run eval:naturalness-vs-baseline`（手順は [`naturalness-llm-judge.md`](naturalness-llm-judge.md)）。

---

## 3. 各段階の共通手順（必須）

**どの段階も、コーディングの前に次を完了すること。**

```
[R] 研究レビュー（最新知見の確認・本段階スコープの文献）
  → 短い検討メモを docs/research-reports/ に追記 or 新規
[D] 詳細凍結（データ形・辺ラベル・成功条件・非目標・eval 項目）
  → 本 SoT の該段階セクションを更新し、合意可能な粒度にする
[I] 実装（最小差分。接地契約を破らない）
[E] 評価
    - 接地: 既存/新規の機械チェック
    - 自然さ: LLM judge（本方針）
[W] 文書反映（grounded-generation* / コーパス規約）と SoT のステージ状態更新
```

ゲート:

- **[R][D] 未完了のまま [I] に入らない。**
- [E] で接地が落ちた変更は、自然さスコアが良くてもマージしない。
- 段階を飛ばさない。ただし前段階の「任意フォロー」は後段と並行してよい。

---

## 4. 五段階プログラム

優先文献の対応は [`research-reports/topic-graph-related-work.md`](research-reports/topic-graph-related-work.md) §4 と揃える。

| 段階 | 主題 | 主な理論的足場 | 状態 |
|------|------|----------------|------|
| **S1** | 三層の設計固定（言語／意図／注意） | Grosz & Sidner | **完了**（[R][D][I][W]） |
| **S2** | claim = QUD、閉じたパラフレーズ | QUD | **完了**（[R][D][I][E][W]） |
| **S3** | 静的辺語彙と核／衛星 | RST | **進行中**（[R][D][I]） |
| **S4** | 対話向け関係と浅い DAG | SDRT / STAC | 未着手 |
| **S5** | 話題構造と修辞構造の分離・硬化 | 話題分割 × 修辞（UMLF 等） | 未着手 |

---

### S1 — 三層アーキテクチャの固定

**目的:** 「話題グラフ」を実装する前に、現行システムのどこが静的辺・どこが注意スタック・どこが意図（QUD）かを言語化する。

**状態:** 完了（2026-09-05）  
**[R] 成果:** [`research-reports/topic-graph-s1-centering-mapping.md`](research-reports/topic-graph-s1-centering-mapping.md)

#### 明文（必須・変更禁止に近い）

- **世界 Knowledge Graph は作らない。** ノードは claim / QUD（答えうる問い）に限る。
- **注意（Attentional state）は実行時スタック**である。コーパス JSON に焦点スタックを永続化しない。現状近似は `TurnGrounding` + anaphora / proximal / continuity。
- **静的辺（修辞・対話関係）と注意スタックを同一構造にマージしない**（Context-Agent と同型の注意）。

#### [D] 凍結：静的 vs 実行時

| 置き場 | 置くもの | 置かないもの |
|--------|----------|--------------|
| **静的（コーパス / YAML）** | chunk・claim・natKey・spans・（S3〜）修辞辺・（S4）対話辺・（S2）閉じたパラフレーズ | 焦点スタック、anaphora 判定結果、continuity フラグ、ユーザー履歴そのもの |
| **実行時のみ** | `TurnGrounding`、`anaphora`、`proximalFocus`、`continuity`、segment パーティション、`OperationPlan`、trace の層ヒント | 世界実体の推論グラフ |

#### [D] 凍結：S2 以降のファイル境界

| 層 / 関心 | 主に触ってよい | 不用意に混ぜない |
|-----------|----------------|------------------|
| **Linguistic（分割）** | `segment.ts`, fuse 経路（`engine.ts` の fusion）, 分割関連 docs | claim メタ・修辞辺スキーマ |
| **Intentional（QUD / claim）** | コーパス claim メタ（S2）、`plan.ts` / G5d スコア連携、`chain-plan.ts` | `grounding.ts` の照応規則を QUD 木に置換すること |
| **Attentional（注意）** | `grounding.ts`, `types.ts` の `TurnGrounding` / `TraceStep`, `engine.ts` の G6 経路 | コーパスへの焦点永続化、意味類似だけで枝をマージ |
| **静的辺（S3/S4）** | コーパス辺スキーマ + retrieval/fuse ボーナス（[D] 後） | `classifyAnaphora` の置換 |
| **評価** | `naturalness-judge.ts` / eval スクリプト（自然さ）と接地トレースは **分離維持** | judge プロンプトへの接地採点混入 |

#### [I] 実装（S1 最小）

- research-reports 対応表 + 本節の凍結文
- `TraceDebug.discourseLayerHints` に linguistic / intentional / attentional の監査ラベル（本番行動は変えない）
- `grounded-generation-g6.md` に三層ポインタ

**完了条件（達成）**

- [x] 対応表が research-reports にある
- [x] 「KG を作らない」「注意は実行時スタック」が明文
- [x] 静的 vs 実行時とファイル境界が本節に凍結

---

### S2 — QUD としての claim／閉じたパラフレーズ

**目的:** ノードの正体を「答えうる問い」に揃え、入口（言い回し）を閉じたパターンで増やす。

**状態:** **完了**（2026-09-05）  
**[R] 成果:** [`research-reports/topic-graph-s2-qud-paraphrase.md`](research-reports/topic-graph-s2-qud-paraphrase.md)

#### [D] 凍結：スキーマ

| フィールド | 置き場 | 意味 |
|------------|--------|------|
| `qud` | claim 直下 | 代表問い（監査・設計の正。検索必須ではない） |
| `sameIntent` | 各言語 surface | **閉じた**言い回し配列。モデル生成禁止 |
| `detailClaim` | claim 直下 | 「詳しく」等の elaboration 時にコピーする子 claim id |

#### [D] 凍結：`same-intent` の扱い

- **文書側インデックス拡張**のみ（`natKey` に連結。CE 用 `key` には混ぜない）。
- クエリ正規化 LLM・実行時自由言い換えはしない。
- グラフ辺ラベル `same-intent` は S2 では作らない（同一 claim 内の入口集合）。

#### [D] 凍結：自然さ judge 第1版ルーブリック（短対話）

| 項目 | 見るもの |
|------|----------|
| tempo | 冗長すぎない／ぶつ切りすぎない |
| coherence | 直前ユーザー発話・文脈への噛み合い。逸脱減点 |
| humanlikeness | 機械的否定・棒読みの少なさ（ただし雑談逸脱を過大評価しない） |

比較プロトコル: 凍結ベースライン [`fixtures/naturalness-judge/baselines/pre-s3-2026-09-05.json`](../fixtures/naturalness-judge/baselines/pre-s3-2026-09-05.json)（22件）に対し `npm run eval:naturalness-vs-baseline`（A=新ライブ, B=凍結）。S2 当時の評価は pre-S2（5件）スナップショット。

#### [I] 実装（パイロット）

- `AuthorClaim` / flatten / `corpus:build` が `qud`・`sameIntent`・`detailClaim` を保持
- elaboration pin が `detailClaim` を優先コピー（生成なし）
- パイロット: `who-1b`, `help-1`/`help-2`, `mech-1` + 新規 `mech-1-detail`

#### [E] 評価結果（2026-09-05）

| 検査 | 結果 |
|------|------|
| `eval:g6b` | 20/20 |
| naturalness fixture judge | expect 通過 |
| vs pre-S2 baseline | **improved 1 / tied 4 / regressed 0** |

寄与の要点: 「詳しく」追従が同一文再掲から `mech-1-detail` の一段深い説明へ。その他ケースは劣化なし。

**完了条件（達成）**

- [x] スキーマと少数 claim へのパイロット適用
- [x] 接地系 g6b 緑 + 自然さ pairwise がベースライン以上（劣化なし＋追従で改善）

**非目標:** モデルによる自由言い換え生成。

---

### S3 — RST 風の静的辺と nuclearity

**目的:** claim 間に少数の情報辺を著者定義し、融合の full/partial と核／衛星を対応づける。

**状態:** 進行中（2026-09-05）  
**[R] 成果:** [`research-reports/topic-graph-s3-rst-edges.md`](research-reports/topic-graph-s3-rst-edges.md)

#### [D] 凍結：辺ラベル

| ラベル | nuclearity | 意味 |
|--------|------------|------|
| `elaborates` | 単核（from=核, to=衛星） | 詳細化。S2 `detailClaim` のグラフ形 |
| `contrasts` | 多核 | 対比・できる／できない等の並置 |
| `parallel` | 多核 | 同格の並列トピック（複合 fuse） |

**非目標（S3）:** `follow-up` / QAP 等の対話辺（→ S4）。注意スタック置換。自由生成。

#### [D] 凍結：コーパス表記

```yaml
edges:
  - rel: elaborates   # | contrasts | parallel
    to: other-claim-id
```

- claim 直下。`parallel` / `contrasts` は索引時に無向化。`elaborates` は有向。
- S2 `detailClaim` は糖衣として残す（proximal elaboration）。対応する `elaborates` 辺を推奨。

#### [D] 凍結：retrieval / fuse への効かせ方

| 経路 | 効かせ方 |
|------|----------|
| fuse 二部マッチ | 辺で結ばれた claim ペアに CE スコア軟ボーナス（ハードフィルタしない） |
| fuse 並べ替え | `elaborates` 核を先頭（full）、衛星を後段（partial） |
| retrieval | continuity claim の辺隣接に小さな加算 |
| 監査 | `debugNotes` / `discourseLayerHints.intentional` に `s3:…` |

#### [D] 凍結：自然さ judge「話題のつなぎ」

- 新ディメンションは増やさない（スキーマ互換）。
- `coherence` の明示下位項目として「複合・対比での話題のつなぎ」をプロンプトに追加済み。

#### [I] 実装（パイロット）

- `topic-edges.ts` + `AuthorClaim.edges` / flatten / `corpus:build`
- fuse ボーナス・nuclearity 並べ替え・retrieval 隣接ボーナス・elaboration 衛星フォールバック
- パイロット辺: `mech-1`↔`mech-1-detail`/`mech-existing`/`mech-2`, `help-1`↔`help-2`, `help-2`↔`limit-1`

#### [E] / 完了条件

- [ ] 辺付きパイロットコーパスと、融合・対比系ケースの eval（`eval:topic-edges`）
- [ ] 自然さ judge で「話題のつなぎ」項目を追加済み
- [ ] `eval:naturalness-vs-baseline`（pre-S3・22件）で劣化なし

---

### S4 — 対話関係と浅い DAG（STAC/SDRT 系）

**目的:** follow-up / QAP 的な対話辺を足し、木に閉じない浅い DAG を許す。

**[R] で確認すること**

- STAC で頻度の高い対話関係
- Right Frontier と現行 clarify / 焦点ルール
- 近年 dialogue graph 研究から **関係集合だけ**借りる（GNN 必須にしない）

**[D] で凍結すること**

- S3 集合への追加ラベル（例: `follow-up`）
- DAG 制約（深さ・次数の上限）
- 多ターン自然さ用の judge シナリオ

**完了条件**

- 追い質問・話題復帰ケースが、辺または注意ルールで説明・再現できる
- 接地緑 + 多ターン自然さの回帰セットが動く

---

### S5 — 話題構造と修辞構造の分離・プログラム硬化

**目的:** 分割・トピック連続と、修辞／対話辺をモジュールとして分離し、評価を恒久化する。

**[R] で確認すること**

- 話題分割と discourse parsing の相互・分離（UMLF 等）
- 対話行為と話題境界の相関（分割ゲートに使うか）
- 分割候補の CE 全局選択など、既存 fuse 分割方針との整合

**[D] で凍結すること**

- モジュール境界（segmenter / topic-continuity / relation-graph / judge）
- 回帰スイートの必須ケース（過分割禁止、複合 fuse、多ターン、拒否）
- LLM judge ジョブの実行頻度（PR 毎か nightly か）

**完了条件**

- 境界が文書とディレクトリで見える
- A（接地）/ C（自然さ judge）が手順化され、S1–S4 の成果が回帰で守られる

---

## 5. エージェント／作業者への指示

1. 作業開始時に本 SoT と [`grounding-contract.md`](grounding-contract.md)（接地契約）を読む。  
2. 現在段階の状態が「未着手／R／D／I／E」のどれかを確認し、**前ゲートを飛ばさない**。  
3. [R] では Web／論文で当該段階の **新しい研究も短い時間で当たる**。古典だけに固定しない。結果は `docs/research-reports/` に残す。  
4. [D] の凍結内容を SoT 該節に書き込んでから実装する。  
5. 自然さの LLM judge を足すときは、プロンプトに接地採点を混ぜない。  
6. 段階完了時に本ファイルの状態列を更新し、必要なら `grounded-generation*.md` を更新する。

---

## 6. 変更履歴

| 日付 | 内容 |
|------|------|
| 2026-09-05 | 初版。五段階・研究先行ゲート・自然さ LLM judge／接地分離・配置方針 |
| 2026-09-05 | 自然さ LLM-as-judge ハーネス整備（OpenRouter 無料モデル既定・pairwise debias） |
| 2026-09-05 | **S1 完了:** Grosz & Sidner 三層対応表・静的/実行時凍結・`discourseLayerHints` |
| 2026-09-05 | **S2 完了:** QUD/sameIntent/detailClaim パイロット、pre-S2 baseline 比 improved 1 / tied 4 / regressed 0 |
| 2026-09-05 | 自然さベースラインを **22件（pre-S3）** に拡充。S3 以降の既定比較セットに切替 |
| 2026-09-05 | **S3 着手:** RST 最小辺・nuclearity 凍結、静的辺パイロット実装 |
