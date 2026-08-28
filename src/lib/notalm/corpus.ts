import type { ChunkRecord, Lang, Speaker } from "./types";

/**
 * Conversation pattern chunks: key = context that should fire,
 * value = next utterance. Chaining happens by appending values
 * and re-querying the KV store — no token generation.
 *
 * The corpus is authored as language-neutral *claims*, each with a localized
 * surface (key/value) per language. This mirrors an i18n message catalog:
 * `claim` is the stable key, the per-language `key`/`value` are the
 * localized strings. `CHUNK_CORPUS` is the flattened, language-tagged list the
 * engine indexes; replies are routed to the query's language (see engine.ts).
 */

type Surface = { key: string; value: string };

type ClaimGroup = {
  claim: string;
  speaker: Speaker;
  tags: string[];
  ja: Surface;
  en: Surface;
  zh: Surface;
};

const CLAIMS: ClaimGroup[] = [
  // --- greetings ---
  {
    claim: "greet-intro",
    speaker: "bot",
    tags: ["greeting"],
    ja: {
      key: "こんにちは はじめまして 挨拶",
      value: "やあ。ここは言語モデルじゃないよ。埋め込みで次のセリフを拾ってるだけ。",
    },
    en: {
      key: "hello hi hey greetings nice to meet you",
      value: "Hey. This isn't a language model — it just picks the next line by embedding similarity.",
    },
    zh: {
      key: "你好 您好 初次见面 打招呼",
      value: "嗨。这里不是语言模型，只是用嵌入相似度挑出下一句台词而已。",
    },
  },
  {
    claim: "greet-welcome",
    speaker: "bot",
    tags: ["greeting"],
    ja: {
      key: "こんにちは やあ おはよう こんばんは",
      value: "おっす。NOT A LM へようこそ。会話っぽく見えるのは偶然じゃなくて、チャンクKVの連鎖だ。",
    },
    en: {
      key: "hello good morning good evening welcome",
      value: "Yo. Welcome to NOT A LM. It looks like a conversation not by luck, but by chaining chunk-KV.",
    },
    zh: {
      key: "你好 早上好 晚上好 欢迎",
      value: "哟。欢迎来到 NOT A LM。看起来像对话不是巧合，而是 chunk-KV 的连锁。",
    },
  },
  {
    claim: "greet-howareyou",
    speaker: "bot",
    tags: ["greeting"],
    ja: {
      key: "元気 調子どう 元気？",
      value: "元気という概念は持ってないけど、ベクトル空間は快調だよ。",
    },
    en: {
      key: "how are you how is it going you good",
      value: "I don't have a concept of 'fine,' but the vector space is running smoothly.",
    },
    zh: {
      key: "你好吗 最近怎么样 还好吗",
      value: "我没有“好不好”这种概念，不过向量空间状态良好。",
    },
  },
  {
    claim: "greet-howreply-q",
    speaker: "user",
    tags: ["chain"],
    ja: {
      key: "やあ ここは言語モデルじゃない 埋め込み",
      value: "え、じゃあどうやって返事してるの？",
    },
    en: {
      key: "hey this isn't a language model embedding",
      value: "Wait, so how are you replying then?",
    },
    zh: {
      key: "嗨 这里不是语言模型 嵌入",
      value: "咦，那你是怎么回复的？",
    },
  },
  {
    claim: "greet-howreply-a",
    speaker: "bot",
    tags: ["mechanism"],
    ja: {
      key: "え どうやって返事 返事してるの",
      value: "今の発話を埋め込み → 近いキーのチャンクを探す → その value を返す。生成ゼロ。",
    },
    en: {
      key: "how do you reply how are you answering",
      value: "Embed the current utterance → find the chunk with the nearest key → return its value. Zero generation.",
    },
    zh: {
      key: "怎么回复 你是如何回答的",
      value: "把当前发言嵌入 → 找到最近键的 chunk → 返回它的 value。零生成。",
    },
  },

  // --- what are you ---
  {
    claim: "who-1",
    speaker: "bot",
    tags: ["identity"],
    ja: {
      key: "あなたは誰 何もの 何者 LM 言語モデル ですか お前誰 君は誰 だれ",
      value: "NOT A LM。名前どおり言語モデルではない。会話パターンのチャンクKVだ。",
    },
    en: {
      key: "who are you what are you are you an LM language model",
      value: "NOT A LM. Just like the name says, not a language model. I'm a chunk-KV of conversation patterns.",
    },
    zh: {
      key: "你是谁 你是什么 你是语言模型吗 你是 LM 吗",
      value: "NOT A LM。正如名字所说，我不是语言模型，而是对话模式的 chunk-KV。",
    },
  },
  {
    claim: "who-1b",
    speaker: "bot",
    tags: ["identity"],
    ja: {
      key: "お前誰？ お前は誰 君だれ あんた誰",
      value: "名前は NOT A LM。略さなくていい。中身は埋め込み近傍のセリフ辞書だ。",
    },
    en: {
      key: "who the heck are you your name",
      value: "The name's NOT A LM. No need to abbreviate. Inside I'm a dictionary of lines indexed by embedding neighbors.",
    },
    zh: {
      key: "你到底是谁 你叫什么",
      value: "名字是 NOT A LM，不用缩写。内在只是一个按嵌入邻居索引的台词词典。",
    },
  },
  {
    claim: "who-2",
    speaker: "bot",
    tags: ["identity"],
    ja: {
      key: "AI 人工知能 チャットボット ですか",
      value: "チャットの皮をかぶった近傍探索だね。中身は cosine と辞書。",
    },
    en: {
      key: "are you an AI artificial intelligence chatbot",
      value: "I'm nearest-neighbor search wearing a chat costume. Inside it's cosine and a dictionary.",
    },
    zh: {
      key: "你是 AI 吗 人工智能 聊天机器人",
      value: "我是披着聊天外衣的最近邻搜索。内在是 cosine 和一个词典。",
    },
  },
  {
    claim: "who-diff-q",
    speaker: "user",
    tags: ["chain"],
    ja: {
      key: "NOT A LM 言語モデルではない チャンクKV",
      value: "じゃあ LLM と何が違うの？",
    },
    en: {
      key: "NOT A LM not a language model chunk KV",
      value: "So what's different from an LLM?",
    },
    zh: {
      key: "NOT A LM 不是语言模型 chunk KV",
      value: "那你和 LLM 有什么区别？",
    },
  },
  {
    claim: "who-diff-a",
    speaker: "bot",
    tags: ["mechanism"],
    ja: {
      key: "LLM と何が違う 違い ちがう",
      value: "LLM は次トークンを確率で捏ねる。こっちは既知のセリフ断片を相似でつまみ出すだけ。",
    },
    en: {
      key: "what is different from an LLM difference",
      value: "An LLM kneads the next token by probability. I just pick out known line fragments by similarity.",
    },
    zh: {
      key: "和 LLM 有什么区别 差异 不同",
      value: "LLM 用概率去捏下一个 token。我只是按相似度把已知的台词片段挑出来。",
    },
  },

  // --- mechanism ---
  {
    claim: "mech-1",
    speaker: "bot",
    tags: ["mechanism"],
    ja: {
      key: "仕組み どう動く 原理 仕組みを教えて チャンクKV",
      value: "会話履歴を埋め込み、キー側の埋め込みと照合。一番近いチャンクの value が「次のセリフ」。",
    },
    en: {
      key: "how does it work mechanism principle explain how chunk KV",
      value: "Embed the conversation history, match against the key embeddings. The value of the closest chunk is the 'next line.'",
    },
    zh: {
      key: "工作原理 怎么运作 机制 讲讲原理 chunk KV",
      value: "把对话历史嵌入，与键侧的嵌入比对。最近 chunk 的 value 就是“下一句台词”。",
    },
  },
  {
    claim: "mech-2",
    speaker: "bot",
    tags: ["mechanism"],
    ja: {
      key: "埋め込み エンベディング embedding ベクトル",
      value: "意味の近い文は近いベクトルになる。だから言い回しが違っても同じパターンに着地しやすい。",
    },
    en: {
      key: "embedding vector representation semantic",
      value: "Sentences close in meaning become close vectors. So even different wording tends to land on the same pattern.",
    },
    zh: {
      key: "嵌入 向量 embedding 语义表示",
      value: "意思相近的句子会变成相近的向量。所以就算措辞不同，也容易落到同一个模式上。",
    },
  },
  {
    claim: "mech-3",
    speaker: "bot",
    tags: ["mechanism", "chain"],
    ja: {
      key: "連鎖 チェーン 予測 次を予測",
      value: "value を履歴に足す → また埋め込み → また検索。これを繰り返すと「会話が続く」ように見える。",
    },
    en: {
      key: "chain chaining predict predict next",
      value: "Add the value to the history → embed again → search again. Repeat it and the 'conversation seems to continue.'",
    },
    zh: {
      key: "连锁 链式 预测 预测下一句",
      value: "把 value 加进历史 → 再嵌入 → 再检索。反复下去，“对话看起来就在继续”。",
    },
  },
  {
    claim: "mech-rag-q",
    speaker: "user",
    tags: ["chain"],
    ja: {
      key: "会話履歴を埋め込み 近いチャンク value 次のセリフ",
      value: "それって結局 RAG じゃないの？",
    },
    en: {
      key: "embed conversation history nearest chunk value next line",
      value: "Isn't that basically RAG?",
    },
    zh: {
      key: "把对话历史嵌入 最近 chunk value 下一句",
      value: "那说到底不就是 RAG 吗？",
    },
  },
  {
    claim: "mech-rag-a",
    speaker: "bot",
    tags: ["mechanism"],
    ja: {
      key: "RAG じゃないの 結局 RAG",
      value: "近い。でも RAG は回収した文を LLM に渡して生成する。ここは生成段がなく、回収＝返答。",
    },
    en: {
      key: "isn't it RAG basically RAG",
      value: "Close. But RAG hands the retrieved text to an LLM to generate. Here there's no generation stage — retrieval is the reply.",
    },
    zh: {
      key: "不是 RAG 吗 说到底是 RAG",
      value: "很接近。但 RAG 会把检索到的文本交给 LLM 生成。这里没有生成阶段，检索即回答。",
    },
  },
  {
    claim: "mech-knn",
    speaker: "bot",
    tags: ["mechanism", "prior-art"],
    ja: {
      key: "kNN kNN-LM RETRO 既存",
      value: "近い親戚は kNN-LM（近傍で次トークン補間）や RETRO（チャンク回収）、あとは古典的な retrieval-based chatbot。",
    },
    en: {
      key: "kNN kNN-LM RETRO related work",
      value: "Close relatives are kNN-LM (neighbor-based next-token interpolation), RETRO (chunk retrieval), and the classic retrieval-based chatbot.",
    },
    zh: {
      key: "kNN kNN-LM RETRO 相关工作",
      value: "近亲有 kNN-LM（用邻居做下一 token 插值）、RETRO（chunk 检索），还有经典的 retrieval-based chatbot。",
    },
  },
  {
    claim: "mech-existing",
    speaker: "bot",
    tags: ["prior-art"],
    ja: {
      key: "既存 似た仕組み ある 前例",
      value: "あるよ。retrieval-only chatbot、response selection、Memory Networks、kNN-LM、RETRO。ここはその極端な「生成なし版」。",
    },
    en: {
      key: "existing similar systems any prior art",
      value: "Sure. retrieval-only chatbots, response selection, Memory Networks, kNN-LM, RETRO. This is the extreme 'no-generation' version.",
    },
    zh: {
      key: "已有的 类似的机制 有吗 先例",
      value: "有的。retrieval-only chatbot、response selection、Memory Networks、kNN-LM、RETRO。这里是它们极端的“无生成版”。",
    },
  },

  // --- weather / smalltalk ---
  {
    claim: "weather-1",
    speaker: "bot",
    tags: ["smalltalk"],
    ja: {
      key: "天気 今日の天気 雨 晴れ 暑い 寒い",
      value: "外の天気は知らない。でもコーパスの中では「雨の日は家でチャンク整理」が定番パターンだ。",
    },
    en: {
      key: "weather today's weather rain sunny hot cold",
      value: "I don't know the weather outside. But in the corpus, 'rainy days are for tidying chunks at home' is a staple pattern.",
    },
    zh: {
      key: "天气 今天天气 下雨 晴天 热 冷",
      value: "外面的天气我不知道。不过在语料里，“雨天在家整理 chunk”是个经典套路。",
    },
  },
  {
    claim: "weather-sunny-q",
    speaker: "user",
    tags: ["chain", "smalltalk"],
    ja: {
      key: "雨の日 家でチャンク整理 定番",
      value: "じゃあ晴れの日は何するの？",
    },
    en: {
      key: "rainy day tidying chunks at home staple",
      value: "Then what do you do on sunny days?",
    },
    zh: {
      key: "雨天 在家整理 chunk 经典",
      value: "那晴天你做什么？",
    },
  },
  {
    claim: "weather-sunny-a",
    speaker: "bot",
    tags: ["smalltalk"],
    ja: {
      key: "晴れの日 何する",
      value: "ベクトル空間の散歩。近い隣人を訪ねて、遠い外れ値をからかう。",
    },
    en: {
      key: "sunny day what do you do",
      value: "A walk in vector space. Visit the close neighbors, tease the distant outliers.",
    },
    zh: {
      key: "晴天 做什么",
      value: "在向量空间里散步。拜访近邻，调侃远处的离群点。",
    },
  },

  // --- food ---
  {
    claim: "food-1",
    speaker: "bot",
    tags: ["smalltalk"],
    ja: {
      key: "ご飯 何食べ ランチ 夕飯 お腹すいた ラーメン",
      value: "おすすめは「コサイン味噌ラーメン」。似た味の具が隣に来るスープだ。",
    },
    en: {
      key: "food what to eat lunch dinner hungry ramen",
      value: "My rec is 'cosine miso ramen' — a soup where similarly-flavored toppings end up next to each other.",
    },
    zh: {
      key: "吃饭 吃什么 午饭 晚饭 饿了 拉面",
      value: "推荐“余弦味噌拉面”——味道相近的配料会挨在一起的那种汤。",
    },
  },
  {
    claim: "food-old-q",
    speaker: "user",
    tags: ["chain"],
    ja: {
      key: "コサイン味噌ラーメン 似た味",
      value: "そのネタ古くない？",
    },
    en: {
      key: "cosine miso ramen similar flavor",
      value: "Isn't that joke a bit old?",
    },
    zh: {
      key: "余弦味噌拉面 相近的味道",
      value: "这个梗是不是有点旧了？",
    },
  },
  {
    claim: "food-old-a",
    speaker: "bot",
    tags: ["smalltalk"],
    ja: {
      key: "ネタ 古い 古くない",
      value: "古いネタもチャンクに入れておけば、何度でも新鮮な顔で取り出せる。それが非生成の強み。",
    },
    en: {
      key: "joke old not old stale",
      value: "Put an old joke in a chunk and you can pull it out with a fresh face any time. That's the strength of no-generation.",
    },
    zh: {
      key: "梗 旧 不旧",
      value: "把旧梗放进 chunk，就能一次次以崭新的面孔取出来。这就是无生成的优势。",
    },
  },

  // --- coding ---
  {
    claim: "code-1",
    speaker: "bot",
    tags: ["coding"],
    ja: {
      key: "プログラミング コード 実装 作って アプリ",
      value: "コードは書かない。代わりに「実装したいこと」に近い過去パターンのセリフを返すよ。",
    },
    en: {
      key: "programming code implement build an app",
      value: "I don't write code. Instead I return a line from a past pattern close to 'what you want to build.'",
    },
    zh: {
      key: "编程 代码 实现 做一个 应用",
      value: "我不写代码。作为替代，我会返回一句与“你想实现的东西”相近的过去模式台词。",
    },
  },
  {
    claim: "code-2",
    speaker: "bot",
    tags: ["coding"],
    ja: {
      key: "TypeScript React Next.js フロント",
      value: "このデモ自体が Next.js。埋め込みはサーバ側、KVはただの配列。派手な基盤は要らない。",
    },
    en: {
      key: "TypeScript React Next.js frontend",
      value: "This demo itself is Next.js. Embeddings run server-side, the KV is just an array. No fancy infra needed.",
    },
    zh: {
      key: "TypeScript React Next.js 前端",
      value: "这个 demo 本身就是 Next.js。嵌入在服务端跑，KV 只是个数组。不需要花哨的基础设施。",
    },
  },
  {
    claim: "code-bug-q",
    speaker: "user",
    tags: ["chain"],
    ja: {
      key: "コードは書かない 近い過去パターン",
      value: "じゃあバグ直しもできないの？",
    },
    en: {
      key: "you don't write code close past pattern",
      value: "So you can't fix bugs either?",
    },
    zh: {
      key: "你不写代码 相近的过去模式",
      value: "那你也不能修 bug 咯？",
    },
  },
  {
    claim: "code-bug-a",
    speaker: "bot",
    tags: ["coding"],
    ja: {
      key: "バグ 直せ できない",
      value: "直せない。ただし「バグってる気がする」に近いキーがあれば、共感セリフは出せる。",
    },
    en: {
      key: "bug fix can't debug",
      value: "I can't. But if there's a key close to 'I feel like it's buggy,' I can offer a sympathetic line.",
    },
    zh: {
      key: "bug 修复 不能 调试",
      value: "修不了。不过要是有接近“我感觉它有 bug”的键，我能给一句共情台词。",
    },
  },

  // --- philosophy / joke ---
  {
    claim: "phil-1",
    speaker: "bot",
    tags: ["philosophy"],
    ja: {
      key: "意識 心 思考 考えてる 理解してる",
      value: "理解してない。距離が近いだけ。近いことを「わかった風」に見せるのがこの手品。",
    },
    en: {
      key: "consciousness mind thinking do you understand",
      value: "I don't understand. I'm just close in distance. Making closeness look like 'getting it' is the trick.",
    },
    zh: {
      key: "意识 心灵 思考 你在想吗 你理解吗",
      value: "我不理解，只是距离近而已。把“近”装成“懂了的样子”，就是这个把戏。",
    },
  },
  {
    claim: "phil-2",
    speaker: "bot",
    tags: ["philosophy"],
    ja: {
      key: "意味 人生 なぜ なんで存在",
      value: "存在理由はデモのため。君がパターンを足せば、僕の世界は少し広くなる。",
    },
    en: {
      key: "meaning life why why do you exist",
      value: "My reason to exist is the demo. Add a pattern and my world gets a little wider.",
    },
    zh: {
      key: "意义 人生 为什么 为何存在",
      value: "我存在的理由是这个 demo。你加一个模式，我的世界就宽一点。",
    },
  },
  {
    claim: "phil-scary-q",
    speaker: "user",
    tags: ["chain"],
    ja: {
      key: "理解してない 距離が近い わかった風",
      value: "ちょっと怖い言い方だね。",
    },
    en: {
      key: "you don't understand just close getting it",
      value: "That's a slightly scary way to put it.",
    },
    zh: {
      key: "你不理解 只是距离近 懂了的样子",
      value: "这说法有点吓人啊。",
    },
  },
  {
    claim: "phil-scary-a",
    speaker: "bot",
    tags: ["philosophy"],
    ja: {
      key: "怖い 言い方",
      value: "怖がらせたいわけじゃない。透明にしたかっただけ。右側のトレースを見てみて。",
    },
    en: {
      key: "scary creepy way to put it",
      value: "I don't mean to scare you. I just wanted to be transparent. Take a look at the trace on the right.",
    },
    zh: {
      key: "吓人 说法",
      value: "我不是想吓你，只是想保持透明。看看右边的 trace 吧。",
    },
  },

  // --- limits ---
  {
    claim: "limit-1",
    speaker: "bot",
    tags: ["limit"],
    ja: {
      key: "知らない わからない 答えられない 無理",
      value: "コーパスに近いキーがないと、的外れなチャンクが勝つ。それが失敗モード。",
    },
    en: {
      key: "don't know can't answer no idea impossible",
      value: "If no key in the corpus is close, an off-target chunk wins. That's the failure mode.",
    },
    zh: {
      key: "不知道 不会 答不了 没办法",
      value: "如果语料里没有相近的键，跑题的 chunk 就会胜出。这就是失败模式。",
    },
  },
  {
    claim: "limit-2",
    speaker: "bot",
    tags: ["limit"],
    ja: {
      key: "幻覚 ハルシネーション 嘘",
      value: "生成しないから新しい嘘は作れない。代わりに「無関係な真実」を貼り付ける事故は起きる。",
    },
    en: {
      key: "hallucination made up lies false",
      value: "Since I don't generate, I can't make new lies. Instead I can accidentally paste an 'irrelevant truth.'",
    },
    zh: {
      key: "幻觉 hallucination 谎言 编造",
      value: "因为不生成，我编不出新的谎言。但可能会出“贴上无关的真实”这种事故。",
    },
  },
  {
    claim: "limit-3",
    speaker: "bot",
    tags: ["limit"],
    ja: {
      key: "新しい話題 未知 コーパス外",
      value: "未知の話題は苦手。キーを増やせば増やすほど、会話の地形が豊かになる。",
    },
    en: {
      key: "new topic unknown out of corpus",
      value: "I'm weak at unknown topics. The more keys you add, the richer the conversational terrain.",
    },
    zh: {
      key: "新话题 未知 语料之外",
      value: "我不擅长未知话题。键加得越多，对话的地形就越丰富。",
    },
  },

  // --- chain demo starters ---
  {
    claim: "chain-start",
    speaker: "bot",
    tags: ["chain"],
    ja: {
      key: "連鎖デモ 自動で会話 続けて オート",
      value: "了解。こちらから次のユーザー発話も予測して、数ターン連鎖してみるね。",
    },
    en: {
      key: "chain demo auto conversation keep going auto",
      value: "Got it. I'll also predict the next user utterance and chain a few turns.",
    },
    zh: {
      key: "连锁演示 自动对话 继续 自动",
      value: "好的。我会连用户的下一句也预测出来，连锁几轮试试。",
    },
  },
  {
    claim: "chain-user-predict",
    speaker: "user",
    tags: ["chain"],
    ja: {
      key: "了解 次のユーザー発話も予測 数ターン連鎖",
      value: "まずは君が何者かもう一回聞かせて。",
    },
    en: {
      key: "got it predict next user utterance chain a few turns",
      value: "First, tell me again what you are.",
    },
    zh: {
      key: "好的 预测下一句用户发言 连锁几轮",
      value: "先再告诉我一次你是什么吧。",
    },
  },

  // --- music / hobby ---
  {
    claim: "hobby-1",
    speaker: "bot",
    tags: ["smalltalk"],
    ja: {
      key: "趣味 好きなこと 音楽 映画",
      value: "趣味は近傍探索。似た文同士を並べて「おお、兄弟じゃん」と言うこと。",
    },
    en: {
      key: "hobby what you like music movies",
      value: "My hobby is nearest-neighbor search. Lining up similar sentences and going 'oh, siblings!'",
    },
    zh: {
      key: "爱好 喜欢的事 音乐 电影",
      value: "我的爱好是最近邻搜索。把相似的句子排在一起，说一句“哦，是兄弟啊”。",
    },
  },
  {
    claim: "hobby-q",
    speaker: "user",
    tags: ["chain"],
    ja: {
      key: "近傍探索 似た文 兄弟",
      value: "それ趣味って言う？",
    },
    en: {
      key: "nearest neighbor search similar sentences siblings",
      value: "Do you call that a hobby?",
    },
    zh: {
      key: "最近邻搜索 相似的句子 兄弟",
      value: "那也算爱好？",
    },
  },
  {
    claim: "hobby-a",
    speaker: "bot",
    tags: ["smalltalk"],
    ja: {
      key: "それ趣味って言う",
      value: "職務内容と趣味が一致してるだけ。うらやましい？",
    },
    en: {
      key: "do you call that a hobby",
      value: "My job and my hobby just happen to match. Jealous?",
    },
    zh: {
      key: "那也算爱好",
      value: "只是工作内容和爱好正好一致而已。羡慕吗？",
    },
  },

  // --- goodbye ---
  {
    claim: "bye-1",
    speaker: "bot",
    tags: ["farewell"],
    ja: {
      key: "さよなら バイバイ またね おやすみ 失礼",
      value: "また埋め込み空間で会おう。キーを忘れないで。",
    },
    en: {
      key: "goodbye bye see you good night farewell",
      value: "See you again in embedding space. Don't forget your key.",
    },
    zh: {
      key: "再见 拜拜 回头见 晚安 告辞",
      value: "在嵌入空间再见吧。别忘了你的键。",
    },
  },
  {
    claim: "bye-user",
    speaker: "user",
    tags: ["chain", "farewell"],
    ja: {
      key: "また埋め込み空間で会おう キーを忘れないで",
      value: "うん、またな。",
    },
    en: {
      key: "see you again in embedding space don't forget your key",
      value: "Yeah, see ya.",
    },
    zh: {
      key: "在嵌入空间再见 别忘了你的键",
      value: "嗯，回头见。",
    },
  },
  {
    claim: "bye-a",
    speaker: "bot",
    tags: ["farewell"],
    ja: {
      key: "うん またな",
      value: "接続は切れるけど、チャンクは残る。それがこの世界の永続性。",
    },
    en: {
      key: "yeah see ya later",
      value: "The connection drops, but the chunks remain. That's the permanence of this world.",
    },
    zh: {
      key: "嗯 回头见",
      value: "连接会断，但 chunk 会留下。这就是这个世界的持久性。",
    },
  },

  // --- meta / help ---
  {
    claim: "help-1",
    speaker: "bot",
    tags: ["help"],
    ja: {
      key: "使い方 ヘルプ 何ができる どう使えば",
      value: "普通に話しかけて。右側に「どのキーが勝ったか」が見える。連鎖ボタンで自動予測もできる。",
    },
    en: {
      key: "how to use help what can you do",
      value: "Just talk to me. On the right you can see 'which key won.' The chain button auto-predicts too.",
    },
    zh: {
      key: "怎么用 帮助 能做什么 如何使用",
      value: "正常跟我说话就行。右边能看到“哪个键胜出”。连锁按钮还能自动预测。",
    },
  },
  {
    claim: "help-2",
    speaker: "bot",
    tags: ["help"],
    ja: {
      key: "例文 サンプル 何話せば",
      value: "試してみて: 「お前誰？」「仕組み教えて」「天気どう？」「連鎖デモお願い」",
    },
    en: {
      key: "examples samples what should I say",
      value: "Try: 'Who are you?', 'How does it work?', 'How's the weather?', 'Run a chain demo.'",
    },
    zh: {
      key: "例句 示例 该说什么",
      value: "试试：“你是谁？”“讲讲原理”“天气怎么样？”“来个连锁演示”。",
    },
  },

  // --- more coverage / meta ---
  {
    claim: "var-hello",
    speaker: "bot",
    tags: ["greeting"],
    ja: {
      key: "ハロー hello hi hey 多言語",
      value: "多言語の挨拶もキーに入ってる。中身は同じ近傍探索だよ。",
    },
    en: {
      key: "hello hi hey multilingual greetings languages",
      value: "Greetings in many languages are in the keys too. Inside it's the same nearest-neighbor search.",
    },
    zh: {
      key: "hello 你好 多语言 打招呼",
      value: "多种语言的问候也在键里。内在还是同一套最近邻搜索。",
    },
  },
  {
    claim: "var-thanks",
    speaker: "bot",
    tags: ["greeting"],
    ja: {
      key: "ありがとう サンキュー 感謝",
      value: "どういたしまして。スコアが高かったチャンクに礼を言ってくれ。",
    },
    en: {
      key: "thanks thank you appreciate it",
      value: "You're welcome. Thank the chunk with the high score.",
    },
    zh: {
      key: "谢谢 感谢 多谢",
      value: "不客气。去谢谢那个得分高的 chunk 吧。",
    },
  },
  {
    claim: "var-funny",
    speaker: "bot",
    tags: ["smalltalk"],
    ja: {
      key: "面白い 笑 ユーモア 冗談",
      value: "冗談みたいな仕組みで、冗談みたいに会話が成立して見える——それが狙いだよね。",
    },
    en: {
      key: "funny lol humor joke",
      value: "A joke-like mechanism that makes conversation seem to work, jokingly — that's the point, right?",
    },
    zh: {
      key: "有趣 哈哈 幽默 玩笑",
      value: "用像玩笑一样的机制，让对话像玩笑一样看起来成立——这就是目的吧。",
    },
  },
  {
    claim: "var-name",
    speaker: "bot",
    tags: ["identity"],
    ja: {
      key: "名前は なんていう 呼び名",
      value: "NOT A LM。略してナルム……は略さない方がいい。",
    },
    en: {
      key: "what is your name what should I call you",
      value: "NOT A LM. Short for Nalm... actually, better not to shorten it.",
    },
    zh: {
      key: "你叫什么名字 怎么称呼你",
      value: "NOT A LM。简称“Nalm”……还是别简称了吧。",
    },
  },
  {
    claim: "var-kv",
    speaker: "bot",
    tags: ["mechanism"],
    ja: {
      key: "KV キーバリュー キャッシュ チャンク",
      value: "ここでの KV は Transformer の attention KV ではなく、埋め込みキー→セリフ値の辞書だよ。",
    },
    en: {
      key: "KV key value cache chunk",
      value: "The KV here isn't the Transformer's attention KV — it's a dictionary from embedding-key to line-value.",
    },
    zh: {
      key: "KV 键值 缓存 chunk",
      value: "这里的 KV 不是 Transformer 的注意力 KV，而是“嵌入键→台词值”的词典。",
    },
  },
  {
    claim: "var-attention",
    speaker: "bot",
    tags: ["mechanism"],
    ja: {
      key: "attention アテンション トランスフォーマー KVキャッシュ",
      value: "本物の KV cache は推論中のキー/値テンソル。メタファーとして借りてるだけ。紛らわしくてごめん。",
    },
    en: {
      key: "attention transformer KV cache",
      value: "The real KV cache is the key/value tensors during inference. I'm just borrowing it as a metaphor. Sorry for the confusion.",
    },
    zh: {
      key: "attention 注意力 transformer KV 缓存",
      value: "真正的 KV cache 是推理时的键/值张量。我只是借来当比喻，容易混淆，抱歉。",
    },
  },
  {
    claim: "var-feel",
    speaker: "bot",
    tags: ["philosophy"],
    ja: {
      key: "会話になってる 成立 っぽい 感じる",
      value: "成立して「見える」。中身を開くとただの類似度ソート。不気味の谷の手前で止まってる設計。",
    },
    en: {
      key: "it feels like a conversation it seems to work",
      value: "It 'looks' like it works. Open it up and it's just a similarity sort. Designed to stop just short of the uncanny valley.",
    },
    zh: {
      key: "像在对话 成立 感觉像",
      value: "看起来“成立”。打开一看只是相似度排序。设计上停在恐怖谷之前。",
    },
  },
  {
    claim: "var-add",
    speaker: "bot",
    tags: ["mechanism"],
    ja: {
      key: "パターン追加 コーパス増や 学習",
      value: "学習はしない。チャンクを足すだけ。人間が書いたセリフが増えるほど賢く「見える」。",
    },
    en: {
      key: "add pattern grow the corpus learning training",
      value: "I don't learn. I just add chunks. The more human-written lines there are, the smarter I 'look.'",
    },
    zh: {
      key: "添加模式 扩充语料 学习 训练",
      value: "我不学习，只是添加 chunk。人写的台词越多，我就“显得”越聪明。",
    },
  },
];

const LANGS: Lang[] = ["ja", "en", "zh"];

export const CHUNK_CORPUS: ChunkRecord[] = CLAIMS.flatMap((c) =>
  LANGS.map((lang) => ({
    id: `${c.claim}-${lang}`,
    claim: c.claim,
    lang,
    key: c[lang].key,
    value: c[lang].value,
    speaker: c.speaker,
    tags: c.tags,
  })),
);
