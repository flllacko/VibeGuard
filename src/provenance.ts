import type { ConversationMessage } from "./intake.js";

export interface TextRange { start: number; end: number }

// An attributed long quotation is task data until the user explicitly adopts it.
// This recognizer is intentionally conservative; unrecognised attribution still
// needs semantic review by the requirement model.
const EXTERNAL_SOURCE = /(?:deepseek|chatgpt|claude|codex|另一个\s*ai|其他\s*ai|第三方|朋友|同事|别人|文章|文档|资料)/i;
const INTRODUCED_EXTERNAL = /(?:这是|以下是|下面是|来自|引用|转述|摘录)[^“”]{0,120}?(?:deepseek|chatgpt|claude|codex|另一个\s*ai|其他\s*ai|第三方|朋友|同事|别人|文章|文档|资料)[^“”]{0,80}?(?:建议|回答|原文|观点|方案|对话)/i;
const NEARBY_ATTRIBUTION = /(?:deepseek|chatgpt|claude|codex|另一个\s*ai|其他\s*ai|第三方|朋友|同事|别人|文章|文档|资料)[^。！？\n]{0,30}?(?:建议|回答|观点|原文|方案|推荐|说)[^“”]{0,18}$/i;
const ADOPTION = /(?:同意|接受|采纳|认可|采用|决定|定了|就这样|就这么办|按.{0,12}做|照.{0,12}做|请实现|要实现|加入第一版|加入需求|作为要求|必须)/g;

export function attributedExternalRanges(message: ConversationMessage): TextRange[] {
  if (message.role !== "user") return [];
  const text = message.text;
  const questionRanges = hostQuestionRanges(text);
  if (questionRanges) return questionRanges;
  const annotationRanges = responseAnnotationQuoteRanges(text);
  if (annotationRanges) return annotationRanges;
  for (let open = text.indexOf("“"); open >= 0; open = text.indexOf("“", open + 1)) {
    const prefix = text.slice(Math.max(0, open - 180), open);
    if (!EXTERNAL_SOURCE.test(prefix)) continue;
    if (!INTRODUCED_EXTERNAL.test(prefix) && !NEARBY_ATTRIBUTION.test(prefix)) continue;
    const close = text.lastIndexOf("”");
    if (close > open) return [{ start: open, end: close + 1 }];
  }
  return [];
}

/** Host question text is quoted Assistant context; only the answer is the user's decision. */
function hostQuestionRanges(text: string): TextRange[] | undefined {
  const tag = "<send_user_message_question_reply>";
  const start = text.indexOf(tag);
  if (start < 0) return undefined;
  const end = text.indexOf("</send_user_message_question_reply>", start + tag.length);
  if (end < 0) return [{ start, end: text.length }];
  return jsonStringValueRanges(text, "question", start + tag.length, end);
}

function jsonStringValueRanges(text: string, key: "text" | "question", blockStart: number, blockEnd: number): TextRange[] {
  const ranges: TextRange[] = [];
  const matcher = new RegExp(`"${key}"\\s*:\\s*"`, "g");
  for (const match of text.slice(blockStart, blockEnd).matchAll(matcher)) {
    const valueStart = blockStart + match.index + match[0].length;
    let valueEnd = valueStart, escaped = false;
    for (; valueEnd < blockEnd; valueEnd++) {
      const char = text[valueEnd];
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') break;
    }
    if (valueEnd < blockEnd) ranges.push({ start: valueStart, end: valueEnd });
  }
  return ranges;
}

function responseAnnotationQuoteRanges(text: string): TextRange[] | undefined {
  const tag = "<response-annotations>";
  const start = text.indexOf(tag);
  if (start < 0) return undefined;
  const end = text.indexOf("</response-annotations>", start + tag.length);
  if (end < 0) return [{ start, end: text.length }];
  const ranges = jsonStringValueRanges(text, "text", start + tag.length, end);
  return ranges.length ? ranges : [{ start: start + tag.length, end }];
}

export function overlapsRange(candidate: TextRange, ranges: TextRange[]): boolean {
  return ranges.some(range => candidate.start < range.end && range.start < candidate.end);
}

export function expressesAdoption(text: string): boolean {
  for (const match of text.matchAll(ADOPTION)) {
    const preceding = text.slice(Math.max(0, match.index - 3), match.index);
    if (!/(?:不|没|未|别|暂不|不必|不能|不要)$/.test(preceding)) return true;
  }
  return false;
}
