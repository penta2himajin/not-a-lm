# 接地生成 G7: コーパス編集オペレータ（作者側）

G6 までで **読む／組み立てる／多ターンで指差す** は揃った。G7 は **書き込み側**: 学習ではなく閉じた編集でコーパスを広げる。

制約: ランタイムの返答は従来どおり **コピー + 閉じた糊**。著者パイプラインでの下書き補助は可（確定は人間／ファイル）。

## ロードマップ上の位置

| 番号 | 内容 |
|---|---|
| G6 | 多ターン接地 ✅ |
| **G7** | コーパス編集（本ドキュメント） |
| G8 | ANN・自律収集・依存監査 |
| G9 | 検証・自己監査ループ |

## G7a（実装）— 手間を限界まで減らす

### 方針

- **人が書く最小セット**: `claim` / `speaker` / 少なくとも1言語の `nat` + `value`
- **自動補完**: `key`（ゲート用袋）、`spans`（文分割）、缺けた言語は **index しない**
- **データ分離**: `corpus/claims/*.yml`（1 claim = 1 ファイル）
- `npm run corpus:build` → `src/lib/notalm/corpus.generated.ts` → `CHUNK_CORPUS`

### コマンド

```bash
npm run corpus:build          # YAML → corpus.data.json
npm run corpus:add -- \
  --claim weather-fog --speaker bot \
  --ja-nat "霧の日はどうするの？" \
  --ja-value "コーパスの奥で迷子になる。近いキーを手探りする日だね。"
# optional: --en-nat/--en-value --zh-nat/--zh-value --tags a,b --stance deny \
#           --ja-assertion "..." --force
npm run eval:corpus-author
npm run eval:corpus-spans
```

### 段階

| 段階 | 内容 | 状態 |
|---|---|---|
| **G7a** | YAML 化・任意言語・key/spans 自動・`corpus:add` | ✅ |
| **G7b** | UI フォーム（`/corpus`）+ YAML プレビュー + 保存/build | ✅ |
| **G7b** | draft 他言語（MT 下書き）+ 差分プレビュー | ✅ |
| **G7c** | attach-span / set-assertion オペレータの明示 API | 予定 |

### G7b UI

- 画面: [`/corpus`](/corpus)（チャット面ヘッダの **Corpus** からも）
- API: `GET/POST /api/corpus`（`preview` / `save` / `draft`）
- 保存時に `corpus/claims/<id>.yml` を書き、`npm run corpus:build` を実行
- **他言語を下書き**: 欠けた言語を著者時 MT（MyMemory）で埋め、YAML diff を表示。ランタイム返答には使わない。確定は人手編集＋保存

### コマンド

```bash
npm run eval:corpus-draft
```

## フォローアップ

- claim 追加後の embed 再インデックスを dev からワンショット
- G7c: attach-span / set-assertion の明示オペレータ API
- git 友好なレビュー用 diff（YAML 単位で既に分割済み）
