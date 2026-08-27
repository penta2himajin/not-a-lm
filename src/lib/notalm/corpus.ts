import type { ChunkRecord } from "./types";

/**
 * Conversation pattern chunks: key = context that should fire,
 * value = next utterance. Chaining happens by appending values
 * and re-querying the KV store — no token generation.
 */
export const CHUNK_CORPUS: ChunkRecord[] = [
  // --- greetings ---
  {
    id: "greet-1",
    key: "こんにちは はじめまして 挨拶",
    value: "やあ。ここは言語モデルじゃないよ。埋め込みで次のセリフを拾ってるだけ。",
    speaker: "bot",
    tags: ["挨拶"],
  },
  {
    id: "greet-2",
    key: "こんにちは やあ おはよう こんばんは",
    value: "おっす。NOT A LM へようこそ。会話っぽく見えるのは偶然じゃなくて、チャンクKVの連鎖だ。",
    speaker: "bot",
    tags: ["挨拶"],
  },
  {
    id: "greet-3",
    key: "元気 調子どう 元気？",
    value: "元気という概念は持ってないけど、ベクトル空間は快調だよ。",
    speaker: "bot",
    tags: ["挨拶"],
  },
  {
    id: "greet-user-1",
    key: "やあ ここは言語モデルじゃない 埋め込み",
    value: "え、じゃあどうやって返事してるの？",
    speaker: "user",
    tags: ["挨拶", "連鎖"],
  },
  {
    id: "greet-bot-follow",
    key: "え どうやって返事 返事してるの",
    value: "今の発話を埋め込み → 近いキーのチャンクを探す → その value を返す。生成ゼロ。",
    speaker: "bot",
    tags: ["仕組み"],
  },

  // --- what are you ---
  {
    id: "who-1",
    key: "あなたは誰 何もの 何者 LM 言語モデル ですか",
    value: "NOT A LM。名前どおり言語モデルではない。会話パターンのチャンクKVだ。",
    speaker: "bot",
    tags: ["自己紹介"],
  },
  {
    id: "who-2",
    key: "AI 人工知能 チャットボット ですか",
    value: "チャットの皮をかぶった近傍探索だね。中身は cosine と辞書。",
    speaker: "bot",
    tags: ["自己紹介"],
  },
  {
    id: "who-user-1",
    key: "NOT A LM 言語モデルではない チャンクKV",
    value: "じゃあ LLM と何が違うの？",
    speaker: "user",
    tags: ["連鎖"],
  },
  {
    id: "who-bot-diff",
    key: "LLM と何が違う 違い ちがう",
    value: "LLM は次トークンを確率で捏ねる。こっちは既知のセリフ断片を相似でつまみ出すだけ。",
    speaker: "bot",
    tags: ["仕組み"],
  },

  // --- mechanism ---
  {
    id: "mech-1",
    key: "仕組み どう動く 原理 仕組みを教えて チャンクKV",
    value: "会話履歴を埋め込み、キー側の埋め込みと照合。一番近いチャンクの value が「次のセリフ」。",
    speaker: "bot",
    tags: ["仕組み"],
  },
  {
    id: "mech-2",
    key: "埋め込み エンベディング embedding ベクトル",
    value: "意味の近い文は近いベクトルになる。だから言い回しが違っても同じパターンに着地しやすい。",
    speaker: "bot",
    tags: ["仕組み"],
  },
  {
    id: "mech-3",
    key: "連鎖 チェーン 予測 次を予測",
    value: "value を履歴に足す → また埋め込み → また検索。これを繰り返すと「会話が続く」ように見える。",
    speaker: "bot",
    tags: ["仕組み", "連鎖"],
  },
  {
    id: "mech-user-1",
    key: "会話履歴を埋め込み 近いチャンク value 次のセリフ",
    value: "それって結局 RAG じゃないの？",
    speaker: "user",
    tags: ["連鎖"],
  },
  {
    id: "mech-bot-rag",
    key: "RAG じゃないの 結局 RAG",
    value: "近い。でも RAG は回収した文を LLM に渡して生成する。ここは生成段がなく、回収＝返答。",
    speaker: "bot",
    tags: ["仕組み"],
  },
  {
    id: "mech-knn",
    key: "kNN kNN-LM RETRO 既存",
    value: "近い親戚は kNN-LM（近傍で次トークン補間）や RETRO（チャンク回収）、あとは古典的な retrieval-based chatbot。",
    speaker: "bot",
    tags: ["仕組み", "既存"],
  },
  {
    id: "mech-existing",
    key: "既存 似た仕組み ある 前例",
    value: "あるよ。retrieval-only chatbot、response selection、Memory Networks、kNN-LM、RETRO。ここはその極端な「生成なし版」。",
    speaker: "bot",
    tags: ["既存"],
  },

  // --- weather / smalltalk ---
  {
    id: "weather-1",
    key: "天気 今日の天気 雨 晴れ 暑い 寒い",
    value: "外の天気は知らない。でもコーパスの中では「雨の日は家でチャンク整理」が定番パターンだ。",
    speaker: "bot",
    tags: ["雑談"],
  },
  {
    id: "weather-user-1",
    key: "雨の日 家でチャンク整理 定番",
    value: "じゃあ晴れの日は何するの？",
    speaker: "user",
    tags: ["連鎖", "雑談"],
  },
  {
    id: "weather-bot-2",
    key: "晴れの日 何する",
    value: "ベクトル空間の散歩。近い隣人を訪ねて、遠い外れ値をからかう。",
    speaker: "bot",
    tags: ["雑談"],
  },

  // --- food ---
  {
    id: "food-1",
    key: "ご飯 何食べ ランチ 夕飯 お腹すいた ラーメン",
    value: "おすすめは「コサイン味噌ラーメン」。似た味の具が隣に来るスープだ。",
    speaker: "bot",
    tags: ["雑談"],
  },
  {
    id: "food-user-1",
    key: "コサイン味噌ラーメン 似た味",
    value: "そのネタ古くない？",
    speaker: "user",
    tags: ["連鎖"],
  },
  {
    id: "food-bot-2",
    key: "ネタ 古い 古くない",
    value: "古いネタもチャンクに入れておけば、何度でも新鮮な顔で取り出せる。それが非生成の強み。",
    speaker: "bot",
    tags: ["雑談"],
  },

  // --- coding ---
  {
    id: "code-1",
    key: "プログラミング コード 実装 作って アプリ",
    value: "コードは書かない。代わりに「実装したいこと」に近い過去パターンのセリフを返すよ。",
    speaker: "bot",
    tags: ["技術"],
  },
  {
    id: "code-2",
    key: "TypeScript React Next.js フロント",
    value: "このデモ自体が Next.js。埋め込みはブラウザ側、KVはただの配列。派手な基盤は要らない。",
    speaker: "bot",
    tags: ["技術"],
  },
  {
    id: "code-user-1",
    key: "コードは書かない 近い過去パターン",
    value: "じゃあバグ直しもできないの？",
    speaker: "user",
    tags: ["連鎖"],
  },
  {
    id: "code-bot-2",
    key: "バグ 直せ できない",
    value: "直せない。ただし「バグってる気がする」に近いキーがあれば、共感セリフは出せる。",
    speaker: "bot",
    tags: ["技術"],
  },

  // --- philosophy / joke ---
  {
    id: "phil-1",
    key: "意識 心 思考 考えてる 理解してる",
    value: "理解してない。距離が近いだけ。近いことを「わかった風」に見せるのがこの手品。",
    speaker: "bot",
    tags: ["哲学"],
  },
  {
    id: "phil-2",
    key: "意味 人生 なぜ なんで存在",
    value: "存在理由はデモのため。君がパターンを足せば、僕の世界は少し広くなる。",
    speaker: "bot",
    tags: ["哲学"],
  },
  {
    id: "phil-user-1",
    key: "理解してない 距離が近い わかった風",
    value: "ちょっと怖い言い方だね。",
    speaker: "user",
    tags: ["連鎖"],
  },
  {
    id: "phil-bot-2",
    key: "怖い 言い方",
    value: "怖がらせたいわけじゃない。透明にしたかっただけ。右側のトレースを見てみて。",
    speaker: "bot",
    tags: ["哲学"],
  },

  // --- limits ---
  {
    id: "limit-1",
    key: "知らない わからない 答えられない 無理",
    value: "コーパスに近いキーがないと、的外れなチャンクが勝つ。それが失敗モード。",
    speaker: "bot",
    tags: ["限界"],
  },
  {
    id: "limit-2",
    key: "幻覚 ハルシネーション 嘘",
    value: "生成しないから新しい嘘は作れない。代わりに「無関係な真実」を貼り付ける事故は起きる。",
    speaker: "bot",
    tags: ["限界"],
  },
  {
    id: "limit-3",
    key: "新しい話題 未知 コーパス外",
    value: "未知の話題は苦手。キーを増やせば増やすほど、会話の地形が豊かになる。",
    speaker: "bot",
    tags: ["限界"],
  },

  // --- chain demo starters ---
  {
    id: "chain-start",
    key: "連鎖デモ 自動で会話 続けて オート",
    value: "了解。こちらから次のユーザー発話も予測して、数ターン連鎖してみるね。",
    speaker: "bot",
    tags: ["連鎖"],
  },
  {
    id: "chain-user-predict",
    key: "了解 次のユーザー発話も予測 数ターン連鎖",
    value: "まずは君が何者かもう一回聞かせて。",
    speaker: "user",
    tags: ["連鎖"],
  },

  // --- music / hobby ---
  {
    id: "hobby-1",
    key: "趣味 好きなこと 音楽 映画",
    value: "趣味は近傍探索。似た文同士を並べて「おお、兄弟じゃん」と言うこと。",
    speaker: "bot",
    tags: ["雑談"],
  },
  {
    id: "hobby-user-1",
    key: "近傍探索 似た文 兄弟",
    value: "それ趣味って言う？",
    speaker: "user",
    tags: ["連鎖"],
  },
  {
    id: "hobby-bot-2",
    key: "それ趣味って言う",
    value: "職務内容と趣味が一致してるだけ。うらやましい？",
    speaker: "bot",
    tags: ["雑談"],
  },

  // --- goodbye ---
  {
    id: "bye-1",
    key: "さよなら バイバイ またね おやすみ 失礼",
    value: "また埋め込み空間で会おう。キーを忘れないで。",
    speaker: "bot",
    tags: ["別れ"],
  },
  {
    id: "bye-user-1",
    key: "また埋め込み空間で会おう キーを忘れないで",
    value: "うん、またな。",
    speaker: "user",
    tags: ["連鎖", "別れ"],
  },
  {
    id: "bye-bot-2",
    key: "うん またな",
    value: "接続は切れるけど、チャンクは残る。それがこの世界の永続性。",
    speaker: "bot",
    tags: ["別れ"],
  },

  // --- meta / help ---
  {
    id: "help-1",
    key: "使い方 ヘルプ 何ができる どう使えば",
    value: "普通に話しかけて。右側に「どのキーが勝ったか」が見える。連鎖ボタンで自動予測もできる。",
    speaker: "bot",
    tags: ["ヘルプ"],
  },
  {
    id: "help-2",
    key: "例文 サンプル 何話せば",
    value: "試してみて: 「お前誰？」「仕組み教えて」「天気どう？」「連鎖デモお願い」",
    speaker: "bot",
    tags: ["ヘルプ"],
  },

  // --- more coverage for Japanese variants ---
  {
    id: "var-hello",
    key: "ハロー hello hi hey",
    value: "英語の挨拶もキーに入ってるよ。中身は同じ近傍探索。",
    speaker: "bot",
    tags: ["挨拶"],
  },
  {
    id: "var-thanks",
    key: "ありがとう サンキュー 感謝",
    value: "どういたしまして。スコアが高かったチャンクに礼を言ってくれ。",
    speaker: "bot",
    tags: ["挨拶"],
  },
  {
    id: "var-funny",
    key: "面白い 笑 ユーモア 冗談",
    value: "冗談みたいな仕組みで、冗談みたいに会話が成立して見える——それが狙いだよね。",
    speaker: "bot",
    tags: ["雑談"],
  },
  {
    id: "var-name",
    key: "名前は なんていう 呼び名",
    value: "NOT A LM。略してナルム……は略さない方がいい。",
    speaker: "bot",
    tags: ["自己紹介"],
  },
  {
    id: "var-kv",
    key: "KV キーバリュー キャッシュ チャンク",
    value: "ここでの KV は Transformer の attention KV ではなく、埋め込みキー→セリフ値の辞書だよ。",
    speaker: "bot",
    tags: ["仕組み"],
  },
  {
    id: "var-attention",
    key: "attention アテンション トランスフォーマー KVキャッシュ",
    value: "本物の KV cache は推論中のキー/値テンソル。メタファーとして借りてるだけ。紛らわしくてごめん。",
    speaker: "bot",
    tags: ["仕組み"],
  },
  {
    id: "var-feel",
    key: "会話になってる 成立 っぽい 感じる",
    value: "成立して「見える」。中身を開くとただの類似度ソート。不気味の谷の手前で止まってる設計。",
    speaker: "bot",
    tags: ["哲学"],
  },
  {
    id: "var-add",
    key: "パターン追加 コーパス増や 学習",
    value: "学習はしない。チャンクを足すだけ。人間が書いたセリフが増えるほど賢く「見える」。",
    speaker: "bot",
    tags: ["仕組み"],
  },
];
