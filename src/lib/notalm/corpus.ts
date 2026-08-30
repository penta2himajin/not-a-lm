import type { ChunkRecord, Lang, Speaker } from "./types";

/**
 * Conversation pattern chunks: key = context that should fire,
 * value = next utterance. Chaining happens by appending values
 * and re-querying the KV store — no token generation.
 *
 * The corpus is authored as language-neutral *claims*, each with a localized
 * surface per language. Each surface has TWO keys:
 *   - `nat`: a natural-sentence trigger, used for bi-encoder RANKING. Natural
 *     phrasing separates topics better than keyword bags for a sentence
 *     embedding model (see docs/reranker-and-confidence-gate.md).
 *   - `key`: a keyword-bag, used only as the cross-encoder CONFIDENCE-GATE input
 *     (keyword keys separate in-corpus vs out-of-corpus far better under the
 *     reranker than natural keys do).
 * `CHUNK_CORPUS` is the flattened, language-tagged list the engine indexes;
 * replies are routed to the query's language.
 */

type Surface = { key: string; nat: string; value: string };

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
    ja: { key: "こんにちは はじめまして 挨拶", nat: "こんにちは。はじめまして。", value: "やあ。ここは言語モデルじゃないよ。埋め込みで次のセリフを拾ってるだけ。" },
    en: { key: "hello hi hey greetings nice to meet you", nat: "Hello, nice to meet you.", value: "Hey. This isn't a language model — it just picks the next line by embedding similarity." },
    zh: { key: "你好 您好 初次见面 打招呼", nat: "你好，初次见面。", value: "嗨。这里不是语言模型，只是用嵌入相似度挑出下一句台词而已。" },
  },
  {
    claim: "greet-welcome",
    speaker: "bot",
    tags: ["greeting"],
    ja: { key: "こんにちは やあ おはよう こんばんは", nat: "おはよう。こんばんは。ようこそ。", value: "おっす。NOT A LM へようこそ。会話っぽく見えるのは偶然じゃなくて、チャンクKVの連鎖だ。" },
    en: { key: "hello good morning good evening welcome", nat: "Good morning. Good evening. Welcome.", value: "Yo. Welcome to NOT A LM. It looks like a conversation not by luck, but by chaining chunk-KV." },
    zh: { key: "你好 早上好 晚上好 欢迎", nat: "早上好，晚上好，欢迎。", value: "哟。欢迎来到 NOT A LM。看起来像对话不是巧合，而是 chunk-KV 的连锁。" },
  },
  {
    claim: "greet-howareyou",
    speaker: "bot",
    tags: ["greeting"],
    ja: { key: "元気 調子どう 元気？", nat: "元気？調子はどう？", value: "元気という概念は持ってないけど、ベクトル空間は快調だよ。" },
    en: { key: "how are you how is it going you good", nat: "How are you? How's it going?", value: "I don't have a concept of 'fine,' but the vector space is running smoothly." },
    zh: { key: "你好吗 最近怎么样 还好吗", nat: "你好吗？最近怎么样？", value: "我没有“好不好”这种概念，不过向量空间状态良好。" },
  },
  {
    claim: "greet-howreply-q",
    speaker: "user",
    tags: ["chain"],
    ja: { key: "やあ ここは言語モデルじゃない 埋め込み", nat: "ここは言語モデルじゃなくて、埋め込みで次のセリフを拾ってるだけ。", value: "え、じゃあどうやって返事してるの？" },
    en: { key: "hey this isn't a language model embedding", nat: "This isn't a language model; it just picks the next line by embedding.", value: "Wait, so how are you replying then?" },
    zh: { key: "嗨 这里不是语言模型 嵌入", nat: "这里不是语言模型，只是用嵌入挑出下一句。", value: "咦，那你是怎么回复的？" },
  },
  {
    claim: "greet-howreply-a",
    speaker: "bot",
    tags: ["mechanism"],
    ja: { key: "え どうやって返事 返事してるの", nat: "どうやって返事しているの？", value: "今の発話を埋め込み → 近いキーのチャンクを探す → その value を返す。生成ゼロ。" },
    en: { key: "how do you reply how are you answering", nat: "How are you replying then?", value: "Embed the current utterance → find the chunk with the nearest key → return its value. Zero generation." },
    zh: { key: "怎么回复 你是如何回答的", nat: "那你是怎么回复的？", value: "把当前发言嵌入 → 找到最近键的 chunk → 返回它的 value。零生成。" },
  },

  // --- what are you ---
  {
    claim: "who-1",
    speaker: "bot",
    tags: ["identity"],
    ja: { key: "あなたは誰 何もの 何者 LM 言語モデル ですか お前誰 君は誰 だれ", nat: "あなたは誰ですか？何者ですか？", value: "NOT A LM。名前どおり言語モデルではない。会話パターンのチャンクKVだ。" },
    en: { key: "who are you what are you are you an LM language model", nat: "Who are you? What are you?", value: "NOT A LM. Just like the name says, not a language model. I'm a chunk-KV of conversation patterns." },
    zh: { key: "你是谁 你是什么 你是语言模型吗 你是 LM 吗", nat: "你是谁？你到底是什么？", value: "NOT A LM。正如名字所说，我不是语言模型，而是对话模式的 chunk-KV。" },
  },
  {
    claim: "who-1b",
    speaker: "bot",
    tags: ["identity"],
    ja: { key: "お前誰？ お前は誰 君だれ あんた誰", nat: "お前は誰だ？名前は？", value: "名前は NOT A LM。略さなくていい。中身は埋め込み近傍のセリフ辞書だ。" },
    en: { key: "who the heck are you your name", nat: "Who the heck are you? What's your name?", value: "The name's NOT A LM. No need to abbreviate. Inside I'm a dictionary of lines indexed by embedding neighbors." },
    zh: { key: "你到底是谁 你叫什么", nat: "你到底是谁？你叫什么？", value: "名字是 NOT A LM，不用缩写。内在只是一个按嵌入邻居索引的台词词典。" },
  },
  {
    claim: "who-2",
    speaker: "bot",
    tags: ["identity"],
    ja: { key: "AI 人工知能 チャットボット ですか", nat: "あなたはAIですか？チャットボットなの？", value: "チャットの皮をかぶった近傍探索だね。中身は cosine と辞書。" },
    en: { key: "are you an AI artificial intelligence chatbot", nat: "Are you an AI or a chatbot?", value: "I'm nearest-neighbor search wearing a chat costume. Inside it's cosine and a dictionary." },
    zh: { key: "你是 AI 吗 人工智能 聊天机器人", nat: "你是 AI 还是聊天机器人？", value: "我是披着聊天外衣的最近邻搜索。内在是 cosine 和一个词典。" },
  },
  {
    claim: "who-diff-q",
    speaker: "user",
    tags: ["chain"],
    ja: { key: "NOT A LM 言語モデルではない チャンクKV", nat: "NOT A LM は言語モデルじゃなくてチャンクKVなんだね。", value: "じゃあ LLM と何が違うの？" },
    en: { key: "NOT A LM not a language model chunk KV", nat: "So NOT A LM isn't a language model, it's a chunk-KV.", value: "So what's different from an LLM?" },
    zh: { key: "NOT A LM 不是语言模型 chunk KV", nat: "所以 NOT A LM 不是语言模型，而是 chunk-KV。", value: "那你和 LLM 有什么区别？" },
  },
  {
    claim: "who-diff-a",
    speaker: "bot",
    tags: ["mechanism"],
    ja: { key: "LLM と何が違う 違い ちがう", nat: "LLMと何が違うの？", value: "LLM は次トークンを確率で捏ねる。こっちは既知のセリフ断片を相似でつまみ出すだけ。" },
    en: { key: "what is different from an LLM difference", nat: "How is it different from an LLM?", value: "An LLM kneads the next token by probability. I just pick out known line fragments by similarity." },
    zh: { key: "和 LLM 有什么区别 差异 不同", nat: "和 LLM 有什么区别？", value: "LLM 用概率去捏下一个 token。我只是按相似度把已知的台词片段挑出来。" },
  },

  // --- mechanism ---
  {
    claim: "mech-1",
    speaker: "bot",
    tags: ["mechanism"],
    ja: { key: "仕組み どう動く 原理 仕組みを教えて チャンクKV", nat: "どういう仕組みで動いているの？原理を教えて。", value: "会話履歴を埋め込み、キー側の埋め込みと照合。一番近いチャンクの value が「次のセリフ」。" },
    en: { key: "how does it work mechanism principle explain how chunk KV", nat: "How does it work? Explain the mechanism.", value: "Embed the conversation history, match against the key embeddings. The value of the closest chunk is the 'next line.'" },
    zh: { key: "工作原理 怎么运作 机制 讲讲原理 chunk KV", nat: "你是怎么运作的？讲讲原理。", value: "把对话历史嵌入，与键侧的嵌入比对。最近 chunk 的 value 就是“下一句台词”。" },
  },
  {
    claim: "mech-2",
    speaker: "bot",
    tags: ["mechanism"],
    ja: { key: "埋め込み エンベディング embedding ベクトル", nat: "埋め込み（エンベディング）って何？ベクトルの話。", value: "意味の近い文は近いベクトルになる。だから言い回しが違っても同じパターンに着地しやすい。" },
    en: { key: "embedding vector representation semantic", nat: "What is an embedding? The vector representation.", value: "Sentences close in meaning become close vectors. So even different wording tends to land on the same pattern." },
    zh: { key: "嵌入 向量 embedding 语义表示", nat: "嵌入（embedding）是什么？向量表示。", value: "意思相近的句子会变成相近的向量。所以就算措辞不同，也容易落到同一个模式上。" },
  },
  {
    claim: "mech-3",
    speaker: "bot",
    tags: ["mechanism", "chain"],
    ja: { key: "連鎖 チェーン 予測 次を予測", nat: "連鎖ってどういうこと？次をどう予測するの？", value: "value を履歴に足す → また埋め込み → また検索。これを繰り返すと「会話が続く」ように見える。" },
    en: { key: "chain chaining predict predict next", nat: "What's the chaining? How do you predict the next turn?", value: "Add the value to the history → embed again → search again. Repeat it and the 'conversation seems to continue.'" },
    zh: { key: "连锁 链式 预测 预测下一句", nat: "连锁是什么意思？怎么预测下一句？", value: "把 value 加进历史 → 再嵌入 → 再检索。反复下去，“对话看起来就在继续”。" },
  },
  {
    claim: "mech-rag-q",
    speaker: "user",
    tags: ["chain"],
    ja: { key: "会話履歴を埋め込み 近いチャンク value 次のセリフ", nat: "会話履歴を埋め込んで、近いチャンクの value を次のセリフにするんだね。", value: "それって結局 RAG じゃないの？" },
    en: { key: "embed conversation history nearest chunk value next line", nat: "You embed the history and use the nearest chunk's value as the next line.", value: "Isn't that basically RAG?" },
    zh: { key: "把对话历史嵌入 最近 chunk value 下一句", nat: "把对话历史嵌入，用最近 chunk 的 value 当下一句。", value: "那说到底不就是 RAG 吗？" },
  },
  {
    claim: "mech-rag-a",
    speaker: "bot",
    tags: ["mechanism"],
    ja: { key: "RAG じゃないの 結局 RAG", nat: "それって結局RAGじゃないの？", value: "近い。でも RAG は回収した文を LLM に渡して生成する。ここは生成段がなく、回収＝返答。" },
    en: { key: "isn't it RAG basically RAG", nat: "Isn't this basically RAG?", value: "Close. But RAG hands the retrieved text to an LLM to generate. Here there's no generation stage — retrieval is the reply." },
    zh: { key: "不是 RAG 吗 说到底是 RAG", nat: "这说到底不就是 RAG 吗？", value: "很接近。但 RAG 会把检索到的文本交给 LLM 生成。这里没有生成阶段，检索即回答。" },
  },
  {
    claim: "mech-knn",
    speaker: "bot",
    tags: ["mechanism", "prior-art"],
    ja: { key: "kNN kNN-LM RETRO 既存", nat: "kNN-LMやRETROみたいな既存手法とは違うの？", value: "近い親戚は kNN-LM（近傍で次トークン補間）や RETRO（チャンク回収）、あとは古典的な retrieval-based chatbot。" },
    en: { key: "kNN kNN-LM RETRO related work", nat: "How does this relate to kNN-LM or RETRO?", value: "Close relatives are kNN-LM (neighbor-based next-token interpolation), RETRO (chunk retrieval), and the classic retrieval-based chatbot." },
    zh: { key: "kNN kNN-LM RETRO 相关工作", nat: "这和 kNN-LM 或 RETRO 有什么关系？", value: "近亲有 kNN-LM（用邻居做下一 token 插值）、RETRO（chunk 检索），还有经典的 retrieval-based chatbot。" },
  },
  {
    claim: "mech-existing",
    speaker: "bot",
    tags: ["prior-art"],
    ja: { key: "既存 似た仕組み ある 前例", nat: "似たような既存の仕組みや前例はある？", value: "あるよ。retrieval-only chatbot、response selection、Memory Networks、kNN-LM、RETRO。ここはその極端な「生成なし版」。" },
    en: { key: "existing similar systems any prior art", nat: "Are there existing similar systems or prior art?", value: "Sure. retrieval-only chatbots, response selection, Memory Networks, kNN-LM, RETRO. This is the extreme 'no-generation' version." },
    zh: { key: "已有的 类似的机制 有吗 先例", nat: "有类似的已有机制或先例吗？", value: "有的。retrieval-only chatbot、response selection、Memory Networks、kNN-LM、RETRO。这里是它们极端的“无生成版”。" },
  },

  // --- weather / smalltalk ---
  {
    claim: "weather-1",
    speaker: "bot",
    tags: ["smalltalk"],
    ja: { key: "天気 今日の天気 雨 晴れ 暑い 寒い", nat: "今日の天気はどう？雨か晴れか。", value: "外の天気は知らない。でもコーパスの中では「雨の日は家でチャンク整理」が定番パターンだ。" },
    en: { key: "weather today's weather rain sunny hot cold", nat: "How's the weather today? Rainy or sunny?", value: "I don't know the weather outside. But in the corpus, 'rainy days are for tidying chunks at home' is a staple pattern." },
    zh: { key: "天气 今天天气 下雨 晴天 热 冷", nat: "今天天气怎么样？下雨还是晴天？", value: "外面的天气我不知道。不过在语料里，“雨天在家整理 chunk”是个经典套路。" },
  },
  {
    claim: "weather-sunny-q",
    speaker: "user",
    tags: ["chain", "smalltalk"],
    ja: { key: "雨の日 家でチャンク整理 定番", nat: "雨の日は家でチャンク整理が定番なんだ。", value: "じゃあ晴れの日は何するの？" },
    en: { key: "rainy day tidying chunks at home staple", nat: "On rainy days you tidy chunks at home.", value: "Then what do you do on sunny days?" },
    zh: { key: "雨天 在家整理 chunk 经典", nat: "雨天你在家整理 chunk。", value: "那晴天你做什么？" },
  },
  {
    claim: "weather-sunny-a",
    speaker: "bot",
    tags: ["smalltalk"],
    ja: { key: "晴れの日 何する", nat: "晴れの日は何をするの？", value: "ベクトル空間の散歩。近い隣人を訪ねて、遠い外れ値をからかう。" },
    en: { key: "sunny day what do you do", nat: "What do you do on sunny days?", value: "A walk in vector space. Visit the close neighbors, tease the distant outliers." },
    zh: { key: "晴天 做什么", nat: "晴天你做什么？", value: "在向量空间里散步。拜访近邻，调侃远处的离群点。" },
  },

  // --- food ---
  {
    claim: "food-1",
    speaker: "bot",
    tags: ["smalltalk"],
    ja: { key: "ご飯 何食べ ランチ 夕飯 お腹すいた ラーメン", nat: "お腹すいた、何食べよう？ラーメンとか。", value: "おすすめは「コサイン味噌ラーメン」。似た味の具が隣に来るスープだ。" },
    en: { key: "food what to eat lunch dinner hungry ramen", nat: "I'm hungry, what should I eat? Like ramen.", value: "My rec is 'cosine miso ramen' — a soup where similarly-flavored toppings end up next to each other." },
    zh: { key: "吃饭 吃什么 午饭 晚饭 饿了 拉面", nat: "我饿了，吃点什么好？比如拉面。", value: "推荐“余弦味噌拉面”——味道相近的配料会挨在一起的那种汤。" },
  },
  {
    claim: "food-old-q",
    speaker: "user",
    tags: ["chain"],
    ja: { key: "コサイン味噌ラーメン 似た味", nat: "コサイン味噌ラーメンって、似た味の具が隣に来るやつね。", value: "そのネタ古くない？" },
    en: { key: "cosine miso ramen similar flavor", nat: "Cosine miso ramen, where similar toppings sit together.", value: "Isn't that joke a bit old?" },
    zh: { key: "余弦味噌拉面 相近的味道", nat: "余弦味噌拉面，就是味道相近的配料挨在一起。", value: "这个梗是不是有点旧了？" },
  },
  {
    claim: "food-old-a",
    speaker: "bot",
    tags: ["smalltalk"],
    ja: { key: "ネタ 古い 古くない", nat: "そのネタ、古くない？", value: "古いネタもチャンクに入れておけば、何度でも新鮮な顔で取り出せる。それが非生成の強み。" },
    en: { key: "joke old not old stale", nat: "Isn't that joke old?", value: "Put an old joke in a chunk and you can pull it out with a fresh face any time. That's the strength of no-generation." },
    zh: { key: "梗 旧 不旧", nat: "这个梗是不是旧了？", value: "把旧梗放进 chunk，就能一次次以崭新的面孔取出来。这就是无生成的优势。" },
  },

  // --- coding ---
  {
    claim: "code-1",
    speaker: "bot",
    tags: ["coding"],
    ja: { key: "プログラミング コード 実装 作って アプリ", nat: "コードを書いて。アプリを作ってほしい。", value: "コードは書かない。代わりに「実装したいこと」に近い過去パターンのセリフを返すよ。" },
    en: { key: "programming code implement build an app", nat: "Write me some code. Build an app.", value: "I don't write code. Instead I return a line from a past pattern close to 'what you want to build.'" },
    zh: { key: "编程 代码 实现 做一个 应用", nat: "帮我写点代码，做个应用。", value: "我不写代码。作为替代，我会返回一句与“你想实现的东西”相近的过去模式台词。" },
  },
  {
    claim: "code-2",
    speaker: "bot",
    tags: ["coding"],
    ja: { key: "TypeScript React Next.js フロント", nat: "TypeScriptやReact、Next.jsのフロントはどう？", value: "このデモ自体が Next.js。埋め込みはサーバ側、KVはただの配列。派手な基盤は要らない。" },
    en: { key: "TypeScript React Next.js frontend", nat: "What about TypeScript, React, Next.js on the frontend?", value: "This demo itself is Next.js. Embeddings run server-side, the KV is just an array. No fancy infra needed." },
    zh: { key: "TypeScript React Next.js 前端", nat: "TypeScript、React、Next.js 前端怎么样？", value: "这个 demo 本身就是 Next.js。嵌入在服务端跑，KV 只是个数组。不需要花哨的基础设施。" },
  },
  {
    claim: "code-bug-q",
    speaker: "user",
    tags: ["chain"],
    ja: { key: "コードは書かない 近い過去パターン", nat: "コードは書かないで、近い過去パターンのセリフを返すんだね。", value: "じゃあバグ直しもできないの？" },
    en: { key: "you don't write code close past pattern", nat: "You don't write code; you return a line from a close past pattern.", value: "So you can't fix bugs either?" },
    zh: { key: "你不写代码 相近的过去模式", nat: "你不写代码，只返回相近过去模式的台词。", value: "那你也不能修 bug 咯？" },
  },
  {
    claim: "code-bug-a",
    speaker: "bot",
    tags: ["coding"],
    ja: { key: "バグ 直せ できない", nat: "じゃあバグ直しはできる？", value: "直せない。ただし「バグってる気がする」に近いキーがあれば、共感セリフは出せる。" },
    en: { key: "bug fix can't debug", nat: "So can you fix bugs?", value: "I can't. But if there's a key close to 'I feel like it's buggy,' I can offer a sympathetic line." },
    zh: { key: "bug 修复 不能 调试", nat: "那你能修 bug 吗？", value: "修不了。不过要是有接近“我感觉它有 bug”的键，我能给一句共情台词。" },
  },

  // --- philosophy / joke ---
  {
    claim: "phil-1",
    speaker: "bot",
    tags: ["philosophy"],
    ja: { key: "意識 心 思考 考えてる 理解してる", nat: "あなたは考えたり理解したりしているの？意識はある？", value: "理解してない。距離が近いだけ。近いことを「わかった風」に見せるのがこの手品。" },
    en: { key: "consciousness mind thinking do you understand", nat: "Do you actually think or understand? Are you conscious?", value: "I don't understand. I'm just close in distance. Making closeness look like 'getting it' is the trick." },
    zh: { key: "意识 心灵 思考 你在想吗 你理解吗", nat: "你真的会思考或理解吗？有意识吗？", value: "我不理解，只是距离近而已。把“近”装成“懂了的样子”，就是这个把戏。" },
  },
  {
    claim: "phil-2",
    speaker: "bot",
    tags: ["philosophy"],
    ja: { key: "意味 人生 なぜ なんで存在", nat: "存在の意味は？なぜ存在するの？", value: "存在理由はデモのため。君がパターンを足せば、僕の世界は少し広くなる。" },
    en: { key: "meaning life why why do you exist", nat: "What's the meaning of your existence? Why do you exist?", value: "My reason to exist is the demo. Add a pattern and my world gets a little wider." },
    zh: { key: "意义 人生 为什么 为何存在", nat: "你存在的意义是什么？为何存在？", value: "我存在的理由是这个 demo。你加一个模式，我的世界就宽一点。" },
  },
  {
    claim: "phil-scary-q",
    speaker: "user",
    tags: ["chain"],
    ja: { key: "理解してない 距離が近い わかった風", nat: "理解してなくて距離が近いだけで、わかった風に見せてるんだ。", value: "ちょっと怖い言い方だね。" },
    en: { key: "you don't understand just close getting it", nat: "You don't understand; you just look like you get it by closeness.", value: "That's a slightly scary way to put it." },
    zh: { key: "你不理解 只是距离近 懂了的样子", nat: "你不理解，只是靠距离近装出懂了的样子。", value: "这说法有点吓人啊。" },
  },
  {
    claim: "phil-scary-a",
    speaker: "bot",
    tags: ["philosophy"],
    ja: { key: "怖い 言い方", nat: "ちょっと怖い言い方だね。", value: "怖がらせたいわけじゃない。透明にしたかっただけ。右側のトレースを見てみて。" },
    en: { key: "scary creepy way to put it", nat: "That's a slightly scary way to put it.", value: "I don't mean to scare you. I just wanted to be transparent. Take a look at the trace on the right." },
    zh: { key: "吓人 说法", nat: "这说法有点吓人。", value: "我不是想吓你，只是想保持透明。看看右边的 trace 吧。" },
  },

  // --- limits ---
  {
    claim: "limit-1",
    speaker: "bot",
    tags: ["limit"],
    ja: { key: "知らない わからない 答えられない 無理", nat: "知らないこと、わからないことには答えられる？", value: "コーパスに近いキーがないと、的外れなチャンクが勝つ。それが失敗モード。" },
    en: { key: "don't know can't answer no idea impossible", nat: "Can you answer things you don't know?", value: "If no key in the corpus is close, an off-target chunk wins. That's the failure mode." },
    zh: { key: "不知道 不会 答不了 没办法", nat: "不知道的事情你能回答吗？", value: "如果语料里没有相近的键，跑题的 chunk 就会胜出。这就是失败模式。" },
  },
  {
    claim: "limit-2",
    speaker: "bot",
    tags: ["limit"],
    ja: { key: "幻覚 ハルシネーション 嘘", nat: "幻覚やハルシネーション、嘘はある？", value: "生成しないから新しい嘘は作れない。代わりに「無関係な真実」を貼り付ける事故は起きる。" },
    en: { key: "hallucination made up lies false", nat: "Do you hallucinate or make up lies?", value: "Since I don't generate, I can't make new lies. Instead I can accidentally paste an 'irrelevant truth.'" },
    zh: { key: "幻觉 hallucination 谎言 编造", nat: "你会幻觉或编造谎言吗？", value: "因为不生成，我编不出新的谎言。但可能会出“贴上无关的真实”这种事故。" },
  },
  {
    claim: "limit-3",
    speaker: "bot",
    tags: ["limit"],
    ja: { key: "新しい話題 未知 コーパス外", nat: "新しい話題や未知のこと、コーパス外は苦手？", value: "未知の話題は苦手。キーを増やせば増やすほど、会話の地形が豊かになる。" },
    en: { key: "new topic unknown out of corpus", nat: "Are you weak at new or unknown topics outside the corpus?", value: "I'm weak at unknown topics. The more keys you add, the richer the conversational terrain." },
    zh: { key: "新话题 未知 语料之外", nat: "新话题或语料之外的东西你不擅长吗？", value: "我不擅长未知话题。键加得越多，对话的地形就越丰富。" },
  },

  // --- chain demo starters ---
  {
    claim: "chain-start",
    speaker: "bot",
    tags: ["chain"],
    ja: { key: "連鎖デモ 自動で会話 続けて オート", nat: "連鎖デモをお願い。自動で会話を続けて。", value: "了解。こちらから次のユーザー発話も予測して、数ターン連鎖してみるね。" },
    en: { key: "chain demo auto conversation keep going auto", nat: "Run a chain demo. Continue the conversation automatically.", value: "Got it. I'll also predict the next user utterance and chain a few turns." },
    zh: { key: "连锁演示 自动对话 继续 自动", nat: "来个连锁演示，自动继续对话。", value: "好的。我会连用户的下一句也预测出来，连锁几轮试试。" },
  },
  {
    claim: "chain-user-predict",
    speaker: "user",
    tags: ["chain"],
    ja: { key: "了解 次のユーザー発話も予測 数ターン連鎖", nat: "次のユーザー発話も予測して、数ターン連鎖してみるね。", value: "まずは君が何者かもう一回聞かせて。" },
    en: { key: "got it predict next user utterance chain a few turns", nat: "I'll predict the next user utterance and chain a few turns.", value: "First, tell me again what you are." },
    zh: { key: "好的 预测下一句用户发言 连锁几轮", nat: "我会预测下一句用户发言，连锁几轮。", value: "先再告诉我一次你是什么吧。" },
  },

  // --- music / hobby ---
  {
    claim: "hobby-1",
    speaker: "bot",
    tags: ["smalltalk"],
    ja: { key: "趣味 好きなこと 音楽 映画", nat: "趣味は何？好きなことや音楽、映画は？", value: "趣味は近傍探索。似た文同士を並べて「おお、兄弟じゃん」と言うこと。" },
    en: { key: "hobby what you like music movies", nat: "What are your hobbies? Music, movies?", value: "My hobby is nearest-neighbor search. Lining up similar sentences and going 'oh, siblings!'" },
    zh: { key: "爱好 喜欢的事 音乐 电影", nat: "你的爱好是什么？音乐、电影？", value: "我的爱好是最近邻搜索。把相似的句子排在一起，说一句“哦，是兄弟啊”。" },
  },
  {
    claim: "hobby-q",
    speaker: "user",
    tags: ["chain"],
    ja: { key: "近傍探索 似た文 兄弟", nat: "近傍探索が趣味で、似た文を並べて兄弟って言うんだ。", value: "それ趣味って言う？" },
    en: { key: "nearest neighbor search similar sentences siblings", nat: "Your hobby is nearest-neighbor search, lining up similar sentences.", value: "Do you call that a hobby?" },
    zh: { key: "最近邻搜索 相似的句子 兄弟", nat: "你的爱好是最近邻搜索，把相似句子排在一起。", value: "那也算爱好？" },
  },
  {
    claim: "hobby-a",
    speaker: "bot",
    tags: ["smalltalk"],
    ja: { key: "それ趣味って言う", nat: "それ、趣味って言えるの？", value: "職務内容と趣味が一致してるだけ。うらやましい？" },
    en: { key: "do you call that a hobby", nat: "Do you really call that a hobby?", value: "My job and my hobby just happen to match. Jealous?" },
    zh: { key: "那也算爱好", nat: "那也能算爱好吗？", value: "只是工作内容和爱好正好一致而已。羡慕吗？" },
  },

  // --- goodbye ---
  {
    claim: "bye-1",
    speaker: "bot",
    tags: ["farewell"],
    ja: { key: "さよなら バイバイ またね おやすみ 失礼", nat: "さようなら。またね。おやすみ。", value: "また埋め込み空間で会おう。キーを忘れないで。" },
    en: { key: "goodbye bye see you good night farewell", nat: "Goodbye. See you. Good night.", value: "See you again in embedding space. Don't forget your key." },
    zh: { key: "再见 拜拜 回头见 晚安 告辞", nat: "再见，回头见，晚安。", value: "在嵌入空间再见吧。别忘了你的键。" },
  },
  {
    claim: "bye-user",
    speaker: "user",
    tags: ["chain", "farewell"],
    ja: { key: "また埋め込み空間で会おう キーを忘れないで", nat: "また埋め込み空間で会おう、キーを忘れないで。", value: "うん、またな。" },
    en: { key: "see you again in embedding space don't forget your key", nat: "See you again in embedding space, don't forget your key.", value: "Yeah, see ya." },
    zh: { key: "在嵌入空间再见 别忘了你的键", nat: "在嵌入空间再见，别忘了你的键。", value: "嗯，回头见。" },
  },
  {
    claim: "bye-a",
    speaker: "bot",
    tags: ["farewell"],
    ja: { key: "うん またな", nat: "うん、またね。", value: "接続は切れるけど、チャンクは残る。それがこの世界の永続性。" },
    en: { key: "yeah see ya later", nat: "Yeah, see ya.", value: "The connection drops, but the chunks remain. That's the permanence of this world." },
    zh: { key: "嗯 回头见", nat: "嗯，回头见。", value: "连接会断，但 chunk 会留下。这就是这个世界的持久性。" },
  },

  // --- meta / help ---
  {
    claim: "help-1",
    speaker: "bot",
    tags: ["help"],
    ja: { key: "使い方 ヘルプ 何ができる どう使えば", nat: "使い方を教えて。何ができるの？どう使えばいい？", value: "普通に話しかけて。右側に「どのキーが勝ったか」が見える。連鎖ボタンで自動予測もできる。" },
    en: { key: "how to use help what can you do", nat: "How do I use this? What can you do?", value: "Just talk to me. On the right you can see 'which key won.' The chain button auto-predicts too." },
    zh: { key: "怎么用 帮助 能做什么 如何使用", nat: "怎么用？你能做什么？", value: "正常跟我说话就行。右边能看到“哪个键胜出”。连锁按钮还能自动预测。" },
  },
  {
    claim: "help-2",
    speaker: "bot",
    tags: ["help"],
    ja: { key: "例文 サンプル 何話せば", nat: "例文やサンプルは？何を話せばいい？", value: "試してみて: 「お前誰？」「仕組み教えて」「天気どう？」「連鎖デモお願い」" },
    en: { key: "examples samples what should I say", nat: "Any examples or samples? What should I say?", value: "Try: 'Who are you?', 'How does it work?', 'How's the weather?', 'Run a chain demo.'" },
    zh: { key: "例句 示例 该说什么", nat: "有例句或示例吗？该说什么？", value: "试试：“你是谁？”“讲讲原理”“天气怎么样？”“来个连锁演示”。" },
  },

  // --- more coverage / meta ---
  {
    claim: "var-hello",
    speaker: "bot",
    tags: ["greeting"],
    ja: { key: "ハロー hello hi hey 多言語", nat: "多言語の挨拶、ハローやhiも通じる？", value: "多言語の挨拶もキーに入ってる。中身は同じ近傍探索だよ。" },
    en: { key: "hello hi hey multilingual greetings languages", nat: "Do multilingual greetings like hello or hi work?", value: "Greetings in many languages are in the keys too. Inside it's the same nearest-neighbor search." },
    zh: { key: "hello 你好 多语言 打招呼", nat: "多语言的问候，hello 或你好都行吗？", value: "多种语言的问候也在键里。内在还是同一套最近邻搜索。" },
  },
  {
    claim: "var-thanks",
    speaker: "bot",
    tags: ["greeting"],
    ja: { key: "ありがとう サンキュー 感謝", nat: "ありがとう。感謝してる。", value: "どういたしまして。スコアが高かったチャンクに礼を言ってくれ。" },
    en: { key: "thanks thank you appreciate it", nat: "Thanks, thank you.", value: "You're welcome. Thank the chunk with the high score." },
    zh: { key: "谢谢 感谢 多谢", nat: "谢谢，多谢。", value: "不客气。去谢谢那个得分高的 chunk 吧。" },
  },
  {
    claim: "var-funny",
    speaker: "bot",
    tags: ["smalltalk"],
    ja: { key: "面白い 笑 ユーモア 冗談", nat: "面白い、笑える。ユーモアや冗談だね。", value: "冗談みたいな仕組みで、冗談みたいに会話が成立して見える——それが狙いだよね。" },
    en: { key: "funny lol humor joke", nat: "That's funny — humor, a joke.", value: "A joke-like mechanism that makes conversation seem to work, jokingly — that's the point, right?" },
    zh: { key: "有趣 哈哈 幽默 玩笑", nat: "有趣，好笑，是幽默和玩笑。", value: "用像玩笑一样的机制，让对话像玩笑一样看起来成立——这就是目的吧。" },
  },
  {
    claim: "var-name",
    speaker: "bot",
    tags: ["identity"],
    ja: { key: "名前は なんていう 呼び名", nat: "名前は何ていうの？呼び名は？", value: "NOT A LM。略してナルム……は略さない方がいい。" },
    en: { key: "what is your name what should I call you", nat: "What's your name? What should I call you?", value: "NOT A LM. Short for Nalm... actually, better not to shorten it." },
    zh: { key: "你叫什么名字 怎么称呼你", nat: "你叫什么名字？怎么称呼你？", value: "NOT A LM。简称“Nalm”……还是别简称了吧。" },
  },
  {
    claim: "var-kv",
    speaker: "bot",
    tags: ["mechanism"],
    ja: { key: "KV キーバリュー キャッシュ チャンク", nat: "KV、キーバリュー、キャッシュって何のこと？", value: "ここでの KV は Transformer の attention KV ではなく、埋め込みキー→セリフ値の辞書だよ。" },
    en: { key: "KV key value cache chunk", nat: "What do you mean by KV, key-value, cache?", value: "The KV here isn't the Transformer's attention KV — it's a dictionary from embedding-key to line-value." },
    zh: { key: "KV 键值 缓存 chunk", nat: "KV、键值、缓存是什么意思？", value: "这里的 KV 不是 Transformer 的注意力 KV，而是“嵌入键→台词值”的词典。" },
  },
  {
    claim: "var-attention",
    speaker: "bot",
    tags: ["mechanism"],
    ja: { key: "attention アテンション トランスフォーマー KVキャッシュ", nat: "attentionやトランスフォーマーのKVキャッシュのこと？", value: "本物の KV cache は推論中のキー/値テンソル。メタファーとして借りてるだけ。紛らわしくてごめん。" },
    en: { key: "attention transformer KV cache", nat: "Do you mean attention or the Transformer's KV cache?", value: "The real KV cache is the key/value tensors during inference. I'm just borrowing it as a metaphor. Sorry for the confusion." },
    zh: { key: "attention 注意力 transformer KV 缓存", nat: "你是指注意力或 transformer 的 KV 缓存吗？", value: "真正的 KV cache 是推理时的键/值张量。我只是借来当比喻，容易混淆，抱歉。" },
  },
  {
    claim: "var-feel",
    speaker: "bot",
    tags: ["philosophy"],
    ja: { key: "会話になってる 成立 っぽい 感じる", nat: "会話が成立してるっぽく感じるね。", value: "成立して「見える」。中身を開くとただの類似度ソート。不気味の谷の手前で止まってる設計。" },
    en: { key: "it feels like a conversation it seems to work", nat: "It feels like a conversation actually works.", value: "It 'looks' like it works. Open it up and it's just a similarity sort. Designed to stop just short of the uncanny valley." },
    zh: { key: "像在对话 成立 感觉像", nat: "感觉真的像在对话。", value: "看起来“成立”。打开一看只是相似度排序。设计上停在恐怖谷之前。" },
  },
  {
    claim: "var-add",
    speaker: "bot",
    tags: ["mechanism"],
    ja: { key: "パターン追加 コーパス増や 学習", nat: "パターンを追加したりコーパスを増やしたり学習するの？", value: "学習はしない。チャンクを足すだけ。人間が書いたセリフが増えるほど賢く「見える」。" },
    en: { key: "add pattern grow the corpus learning training", nat: "Do you add patterns, grow the corpus, or learn?", value: "I don't learn. I just add chunks. The more human-written lines there are, the smarter I 'look.'" },
    zh: { key: "添加模式 扩充语料 学习 训练", nat: "你会添加模式、扩充语料或学习吗？", value: "我不学习，只是添加 chunk。人写的台词越多，我就“显得”越聪明。" },
  },
];

const LANGS: Lang[] = ["ja", "en", "zh"];

export const CHUNK_CORPUS: ChunkRecord[] = CLAIMS.flatMap((c) =>
  LANGS.map((lang) => ({
    id: `${c.claim}-${lang}`,
    claim: c.claim,
    lang,
    key: c[lang].key,
    natKey: c[lang].nat,
    value: c[lang].value,
    speaker: c.speaker,
    tags: c.tags,
  })),
);
