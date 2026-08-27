# NOT A LM

埋め込みモデルとチャンク KV で会話パターンを連鎖予測するデモです。**言語モデルではありません。** 次トークン生成はせず、近いキーのセリフ断片を返すだけなのに、会話が成立して見える／感じる、という実験です。

埋め込みには [hotchpotch/bekko-embedding-v1-a8m](https://huggingface.co/hotchpotch/bekko-embedding-v1-a8m) を使います（起動直後はハッシュ埋め込みで仮索引し、bekko 準備後に差し替え）。

## 仕組み

1. 会話パターンを `(key, value)` チャンクとして保持（キー＝文脈、値＝次の発話）
2. 直近の会話を bekko で埋め込み
3. キー埋め込みとの cosine 近傍で value を取得
4. 履歴に足して再検索 → **連鎖予測**

近い既存の系統: retrieval-only chatbot、response selection、kNN-LM、RETRO、Memory Networks。ここはその極端な「生成なし」版です。

## 起動

```bash
npm install
npm run dev -- --port 43123
```

ブラウザで [http://127.0.0.1:43123](http://127.0.0.1:43123) を開きます。

初回は bekko の ONNX などを取得するため時間がかかります。キャッシュは `/tmp/bekko-cache`（`BEKKO_CACHE_DIR` で変更可）。

## 操作

- 普通に話しかける → bot チャンクを近傍探索
- **連鎖** → ユーザー発話も予測して数ターン自動でつなぐ
- 右パネルで類似度ランキングと選ばれたチャンクを確認

## スタック

- Next.js (App Router) + TypeScript + Tailwind + shadcn/ui
- `@huggingface/transformers` 経由の bekko-a8m
