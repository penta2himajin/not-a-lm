# NOT A LM

埋め込みモデルとチャンク KV で会話パターンを連鎖予測するデモです。**言語モデルではありません。** 次トークン生成はせず、近いキーのセリフ断片を返すだけなのに、会話が成立して見える／感じる、という実験です。日本語・英語・中国語(簡体)の3言語コーパスに対応し、入力言語を判定して同じ言語のチャンクを返します。

埋め込みには多言語モデル [paraphrase-multilingual-MiniLM-L12-v2](https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2) を使います（起動直後はハッシュ埋め込みで仮索引し、多言語モデル準備後に差し替え）。モデル選定の比較は [`docs/embedding-model-selection.md`](docs/embedding-model-selection.md) を参照。

## 仕組み

1. 会話パターンを `(key, value)` チャンクとして保持（キー＝文脈、値＝次の発話）
2. 直近の会話を多言語モデルで埋め込み
3. キー埋め込みとの cosine 近傍で候補を取得（Stage 1）
4. cross-encoder リランカーで `(query, key)` を再採点して最終選択（Stage 2）。最良スコアが低ければ「わからない」を返す（信頼度ゲート）
5. 履歴に足して再検索 → **連鎖予測**

2段検索（bi-encoder → cross-encoder）と信頼度ゲートの詳細は [`docs/reranker-and-confidence-gate.md`](docs/reranker-and-confidence-gate.md) を参照。

近い既存の系統: retrieval-only chatbot、response selection、kNN-LM、RETRO、Memory Networks。ここはその極端な「生成なし」版です。

## 起動

```bash
npm install
npm run dev -- --port 43123
```

ブラウザで [http://127.0.0.1:43123](http://127.0.0.1:43123) を開きます。

初回は多言語モデルの ONNX などを取得するため時間がかかります。キャッシュは `/tmp/notalm-embed-cache`（`EMBED_CACHE_DIR` で変更可）。

## 操作

- 普通に話しかける → bot チャンクを近傍探索
- **連鎖** → ユーザー発話も予測して数ターン自動でつなぐ
- 右パネルで類似度ランキングと選ばれたチャンクを確認

## スタック

- Next.js (App Router) + TypeScript + Tailwind + shadcn/ui
- `@huggingface/transformers` 経由の paraphrase-multilingual-MiniLM-L12-v2（多言語埋め込み）
- 同 bge-reranker-base（多言語 cross-encoder リランカー, fp32）
