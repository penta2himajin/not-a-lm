import type { Lang } from "./types";

/**
 * Script-based language detection for the v1 trilingual corpus (ja / en / zh).
 *
 * These three languages are separable by script:
 * - Japanese uses kana (hiragana / katakana), which neither English nor Chinese has.
 * - Chinese (Simplified) uses Han characters but no kana.
 * - English uses Latin letters.
 *
 * Heuristic (in order):
 * 1. Any kana            -> ja
 * 2. Han present, no kana -> zh
 * 3. otherwise            -> en
 *
 * `fallback` is returned when the text carries no decisive script signal
 * (e.g. only digits / punctuation / emoji).
 */

const KANA = /[\u3040-\u309f\u30a0-\u30ff\uff66-\uff9f]/; // hiragana, katakana, halfwidth kana
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/; // CJK ideographs
const LATIN = /[A-Za-z]/;

export function detectLang(text: string, fallback: Lang = "en"): Lang {
  if (!text) return fallback;
  if (KANA.test(text)) return "ja";
  if (HAN.test(text)) return "zh";
  if (LATIN.test(text)) return "en";
  return fallback;
}

/** Detect the conversation language from the most recent user-authored text. */
export function detectLangFromHistory(
  texts: { role: string; text: string }[],
  latestUser?: string,
  fallback: Lang = "en",
): Lang {
  if (latestUser?.trim()) return detectLang(latestUser, fallback);
  for (let i = texts.length - 1; i >= 0; i--) {
    if (texts[i].role === "user" && texts[i].text.trim()) {
      return detectLang(texts[i].text, fallback);
    }
  }
  // No user text: fall back to the newest message of any role.
  for (let i = texts.length - 1; i >= 0; i--) {
    if (texts[i].text.trim()) return detectLang(texts[i].text, fallback);
  }
  return fallback;
}
