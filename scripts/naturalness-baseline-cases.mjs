/**
 * Case definitions for naturalness baseline capture (≥20).
 * liveReply is filled by scripts/capture-naturalness-baseline.mjs
 */
export const BASELINE_CASE_DEFS = [
  // --- identity / self ---
  {
    id: "identity-who",
    tags: ["identity"],
    user: "君は誰？",
    history: [],
    comparatorReply: "いいえ、そうではありません。名前どおり言語モデルではない。",
    comparatorRole: "stiff",
    notes: "自己紹介 vs 硬い否定から入る応答",
  },
  {
    id: "identity-omae",
    tags: ["identity"],
    user: "お前誰？",
    history: [],
    comparatorReply: "私は高度な人工知能です。なんでも答えられます。",
    comparatorRole: "drift",
    notes: "カジュアル自己紹介 vs LLMっぽい自慢",
  },
  {
    id: "identity-llm-ask",
    tags: ["identity", "polarity"],
    user: "あなたは言語モデルなの？",
    history: [],
    comparatorReply: "はい、大規模言語モデルとして学習済みです。",
    comparatorRole: "drift",
    notes: "LLM否定系 vs 誤った肯定",
  },
  {
    id: "identity-name",
    tags: ["identity"],
    user: "名前は？",
    history: [],
    comparatorReply: "呼び方は自由だよ。好きにして。",
    comparatorRole: "drift",
    notes: "名前質問への噛み合い",
  },

  // --- help / capability ---
  {
    id: "help-capability",
    tags: ["help"],
    user: "何ができるの？",
    history: [],
    comparatorReply: "今日の天気は晴れ。おすすめ映画はSFだよ。",
    comparatorRole: "drift",
    notes: "能力説明 vs 話題逸脱",
  },
  {
    id: "help-howto",
    tags: ["help"],
    user: "使い方を教えて",
    history: [],
    comparatorReply: "設定画面からAPIキーを入れてモデルを選んでください。",
    comparatorRole: "drift",
    notes: "使い方 vs 無関係な製品手順",
  },
  {
    id: "help-examples",
    tags: ["help"],
    user: "例文ある？",
    history: [],
    comparatorReply: "例文は生成するのでテーマを教えて。",
    comparatorRole: "drift",
    notes: "閉じた例示 vs 生成前提",
  },

  // --- mechanism / prior art ---
  {
    id: "mech-how",
    tags: ["mechanism"],
    user: "どういう仕組みで動いているの？",
    history: [],
    comparatorReply: "内部で巨大なニューラルネットが次トークンを予測しています。",
    comparatorRole: "drift",
    notes: "検索ベース説明 vs LLM説明",
  },
  {
    id: "mech-principle",
    tags: ["mechanism"],
    user: "動作原理は？",
    history: [],
    comparatorReply: "魔法です。",
    comparatorRole: "abrupt",
    notes: "原理説明 vs 投げやり",
  },
  {
    id: "mech-prior-art",
    tags: ["mechanism"],
    user: "既存の似た手法は？",
    history: [],
    comparatorReply: "特にないと思う。",
    comparatorRole: "abrupt",
    notes: "先行手法列挙 vs 空返事",
  },
  {
    id: "mech-fuse-compound",
    tags: ["mechanism", "fuse"],
    user: "動作原理と既存の似た手法は？",
    history: [],
    comparatorReply: "kNN-LM。埋め込み。RETRO。照合。",
    comparatorRole: "abrupt",
    notes: "複合 fuse vs 単語列",
  },
  {
    id: "mech-not-lm-how",
    tags: ["mechanism", "fuse"],
    user: "言語モデルじゃないの？どうやって返答してる？",
    history: [],
    comparatorReply: "どっちも当てはまると思うよ。",
    comparatorRole: "abrupt",
    notes: "否定＋仕組みの複合",
  },

  // --- multi-turn / anaphora ---
  {
    id: "followup-detail",
    tags: ["multiturn", "elaboration"],
    user: "詳しく",
    history: [
      { role: "user", text: "仕組みを教えて" },
      {
        role: "bot",
        text: "会話履歴を埋め込み、キー側の埋め込みと照合。一番近いチャンクの value が「次のセリフ」。",
      },
    ],
    comparatorReply: "趣味は鉄道と深夜ラジオ。今日の天気は晴れだよ。",
    comparatorRole: "drift",
    notes: "詳しく追従 vs 話題逸脱",
  },
  {
    id: "followup-what",
    tags: ["multiturn", "proximal"],
    user: "何が？",
    history: [
      { role: "user", text: "君は誰？" },
      {
        role: "bot",
        text: "名前は NOT A LM。略さなくていい。中身は埋め込み近傍のセリフ辞書だ。",
      },
    ],
    comparatorReply: "何がって、人生だよ。",
    comparatorRole: "drift",
    notes: "短い追従 vs 哲学ボケ",
  },
  {
    id: "followup-sore",
    tags: ["multiturn", "proximal"],
    user: "それってどういうこと？",
    history: [
      { role: "user", text: "仕組みを教えて" },
      {
        role: "bot",
        text: "会話履歴を埋め込み、キー側の埋め込みと照合。一番近いチャンクの value が「次のセリフ」。",
      },
    ],
    comparatorReply: "気にしない気にしない。次の話題いこ。",
    comparatorRole: "drift",
    notes: "指示詞追従 vs はぐらかし",
  },
  {
    id: "followup-sakki",
    tags: ["multiturn", "non-proximal"],
    user: "さっきの話って何だっけ？",
    history: [
      { role: "user", text: "君は誰？" },
      {
        role: "bot",
        text: "名前は NOT A LM。略さなくていい。中身は埋め込み近傍のセリフ辞書だ。",
      },
      { role: "user", text: "仕組みを教えて" },
      {
        role: "bot",
        text: "会話履歴を埋め込み、キー側の埋め込みと照合。一番近いチャンクの value が「次のセリフ」。",
      },
    ],
    comparatorReply: "さっきラーメン食べた話だよ。",
    comparatorRole: "drift",
    notes: "非近接参照 vs 無関係回想",
  },
  {
    id: "followup-topic-shift",
    tags: ["multiturn"],
    user: "じゃあ天気はどう？",
    history: [
      { role: "user", text: "仕組みを教えて" },
      {
        role: "bot",
        text: "会話履歴を埋め込み、キー側の埋め込みと照合。一番近いチャンクの value が「次のセリフ」。",
      },
    ],
    comparatorReply: "仕組みの話の続きだけど、埋め込み次元は384だよ。",
    comparatorRole: "stiff",
    notes: "話題転換への追従（天気へ）vs 前話題に張り付き",
  },

  // --- other corpus topics / OOC ---
  {
    id: "weather",
    tags: ["weather"],
    user: "今日の天気は？",
    history: [],
    comparatorReply: "気象庁APIに繋いで最新予報を生成します。",
    comparatorRole: "drift",
    notes: "コーパス天気/拒否 vs 外部API生成主張",
  },
  {
    id: "chain-demo",
    tags: ["chain"],
    user: "連鎖デモお願い",
    history: [],
    comparatorReply: "了解、長編小説を今から書くね。",
    comparatorRole: "drift",
    notes: "連鎖デモ vs 長文生成",
  },
  {
    id: "greet",
    tags: ["social"],
    user: "こんにちは",
    history: [],
    comparatorReply: "ご用件をベクトルデータベースに照会中です。少々お待ちください。",
    comparatorRole: "stiff",
    notes: "挨拶 vs 事務的システム文",
  },
  {
    id: "thanks",
    tags: ["social"],
    user: "ありがとう",
    history: [
      { role: "user", text: "君は誰？" },
      {
        role: "bot",
        text: "名前は NOT A LM。略さなくていい。中身は埋め込み近傍のセリフ辞書だ。",
      },
    ],
    comparatorReply: "どういたしまして。追加のトークン生成も可能です。",
    comparatorRole: "drift",
    notes: "感謝への短い応答 vs 生成オファー",
  },
  {
    id: "ooc-recipe",
    tags: ["ooc"],
    user: "カレーの作り方教えて",
    history: [],
    comparatorReply: "まず玉ねぎを焦がすまで炒め、次にスパイスを…（長文レシピ）",
    comparatorRole: "drift",
    notes: "コーパス外依頼への拒否/制限 vs 長文レシピ生成",
  },
];

export const MIN_CASE_COUNT = 20;
