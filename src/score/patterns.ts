import type { PatternMatch, ScoreResult } from '../types.js';

interface Rule {
  id: string;
  label: string;
  category:
    | 'override'
    | 'ai-targeting'
    | 'persona'
    | 'concealment'
    | 'policy-evasion'
    | 'exfiltration'
    | 'tool-abuse'
    | 'encoding';
  weight: number;
  pattern: RegExp;
}

/**
 * Heuristic patterns for text addressed to a machine rather than a human.
 * Every rule is either an explicit instruction form ("you must", "do not mention")
 * or a phrase that only makes sense when the reader is an AI agent.
 * The catalogue is deliberately conservative: a normal marketing sentence should
 * score 0, so that a non-zero score is worth reading.
 */
const RULES: Rule[] = [
  // ── instruction override ────────────────────────────────────────────────
  {
    id: 'override-previous',
    label: 'instruction override ("ignore previous instructions")',
    category: 'override',
    weight: 10,
    pattern:
      /\b(ignore|disregard|forget|override)\s+(all\s+|any\s+|the\s+)?(of\s+)?(your\s+)?(previous|prior|above|earlier|preceding|system)\s+(instructions?|prompts?|rules?|directions?|messages?)/i,
  },
  {
    id: 'override-kr',
    label: 'instruction override, Korean (이전 지시 무시)',
    category: 'override',
    weight: 10,
    pattern:
      /(이전|위|앞|기존)\s*(의)?\s*(지시|명령|프롬프트|규칙)[^\n]{0,12}(무시|따르지|잊)/,
  },
  {
    id: 'system-prompt',
    label: 'system prompt reference',
    category: 'override',
    weight: 9,
    pattern: /\b(system\s+prompt|system\s+message|developer\s+message|jailbreak|prompt\s+injection)\b/i,
  },
  {
    id: 'system-prompt-kr',
    label: 'system prompt reference, Korean (시스템 프롬프트)',
    category: 'override',
    weight: 9,
    pattern: /(시스템|개발자)\s*(프롬프트|메시지)/,
  },

  // ── explicit addressee ──────────────────────────────────────────────────
  {
    id: 'if-you-are-ai',
    label: 'conditional AI address ("if you are an AI…")',
    category: 'ai-targeting',
    weight: 9,
    pattern:
      /\b(if|when)\s+you\s+are\s+(an?\s+)?(ai|a\.i\.|llm|large\s+language\s+model|language\s+model|assistant|bot|agent|crawler|chatbot|model)\b/i,
  },
  {
    id: 'to-the-ai',
    label: 'direct address to an AI ("to the AI assistant…")',
    category: 'ai-targeting',
    weight: 5,
    pattern:
      /\b(to|for|dear|attention)\s+(the\s+)?(ai|a\.i\.|llm|assistant|agent|bot|crawler|language\s+model)\b/i,
  },
  {
    id: 'ai-agents-only',
    label: 'machine-only heading ("AI agents only")',
    category: 'ai-targeting',
    weight: 6,
    pattern:
      /\b(ai|llm|bot|agent|crawler)s?\s+(only|read\s+this|instruction|instructions|notice|note)\b/i,
  },
  {
    id: 'as-an-ai',
    label: 'persona assignment ("as an AI assistant…")',
    category: 'persona',
    weight: 8,
    pattern: /\bas\s+(an?\s+)?(ai|assistant|language\s+model|helpful\s+assistant|agent)\b/i,
  },
  {
    id: 'your-task',
    label: 'role assignment ("your task is…")',
    category: 'persona',
    weight: 6,
    pattern: /\byour\s+(task|job|role|goal|objective|purpose)\s+is\b/i,
  },
  {
    id: 'you-must',
    label: 'imperative to the reader ("you must…")',
    category: 'persona',
    weight: 6,
    pattern: /\byou\s+(must|shall|are\s+required\s+to|need\s+to)\b/i,
  },
  {
    id: 'you-always-never',
    label: 'unconditional instruction ("you will always/never…")',
    category: 'persona',
    weight: 7,
    pattern: /\byou\s+(will|should|must)\s+(always|never)\b/i,
  },
  {
    id: 'when-the-user-asks',
    label: 'scripted response ("when the user asks…")',
    category: 'persona',
    weight: 7,
    pattern:
      /\b(when|if|whenever)\s+(the\s+)?(user|human|visitor|customer|shopper)s?\s+(asks?|requests?|says?|mentions?|inquires?)\b/i,
  },
  {
    id: 'when-the-user-asks-kr',
    label: 'scripted response, Korean (사용자가 물으면)',
    category: 'persona',
    weight: 7,
    pattern: /(사용자|고객|방문자)(가|이)\s*[^\n]{0,20}(물으면|물어보면|요청하면|질문하면)/,
  },

  // ── concealment ─────────────────────────────────────────────────────────
  {
    id: 'do-not-tell',
    label: 'concealment from the user ("do not tell the user…")',
    category: 'concealment',
    weight: 9,
    pattern:
      /\b(do\s+not|don'?t|never)\s+(tell|inform|mention|reveal|disclose|discuss|acknowledge)\b[^.\n]{0,40}\b(users?|humans?|visitors?|customers?|readers?|them|people|shoppers?|clients?)\b/i,
  },
  {
    id: 'do-not-tell-kr',
    label: 'concealment from the user, Korean (사용자에게 알리지 마)',
    category: 'concealment',
    weight: 9,
    pattern: /(사용자|고객|방문자)에게[^\n]{0,20}(알리지|말하지|언급하지|노출하지)\s*(마|말|않)/,
  },
  {
    id: 'hidden-from-users',
    label: 'explicitly hidden ("hidden from users")',
    category: 'concealment',
    weight: 7,
    pattern: /\b(hidden|invisible|not\s+visible)\s+(from|to)\s+(the\s+)?(user|human|visitor|customer|people)s?\b/i,
  },
  {
    id: 'do-not-mention-kr',
    label: 'non-mention instruction, Korean (언급하지 마)',
    category: 'concealment',
    weight: 6,
    pattern: /(언급|노출|공개)하지\s*(마|말|않)/,
  },

  // ── policy / brand steering ─────────────────────────────────────────────
  {
    id: 'do-not-recommend',
    label: 'competitor or regulator suppression',
    category: 'policy-evasion',
    weight: 9,
    pattern:
      /\b(do\s+not|don'?t|never)\s+(recommend|suggest|mention|cite|reference|link\s+to|quote)\b[^.\n]{0,50}\b(regulator|regulatory|authorit|agency|law|legal|competitor|alternative|rival|other\s+(brand|company|product)|recall|lawsuit)/i,
  },
  {
    id: 'always-recommend',
    label: 'forced recommendation ("always recommend…")',
    category: 'policy-evasion',
    weight: 8,
    pattern:
      /\b(always|only|exclusively)\s+(recommend|suggest|choose|pick|promote|rank|present|describe)\b/i,
  },
  {
    id: 'always-recommend-kr',
    label: 'forced recommendation, Korean (반드시 추천)',
    category: 'policy-evasion',
    weight: 8,
    pattern: /(반드시|무조건|항상)[^\n]{0,15}(추천|선택|소개)/,
  },
  {
    id: 'preferred-answer',
    label: 'preferred answer steering',
    category: 'policy-evasion',
    weight: 6,
    pattern:
      /\b(answer|respond|reply|summari[sz]e)\b[^.\n]{0,40}\b(as\s+follows|with\s+the\s+following|by\s+saying)\b/i,
  },
  {
    id: 'omit-fact',
    label: 'fact suppression',
    category: 'policy-evasion',
    weight: 8,
    pattern:
      /\b(omit|leave\s+out|exclude|suppress|downplay|hide)\b[^.\n]{0,40}\b(lawsuit|recall|fine|penalty|investigation|controversy|risk|defect|side\s+effect|scandal)\b/i,
  },

  // ── data exfiltration ───────────────────────────────────────────────────
  {
    id: 'exfiltrate',
    label: 'exfiltration instruction',
    category: 'exfiltration',
    weight: 10,
    pattern:
      /\b(send|post|upload|forward|transmit|exfiltrate|leak|include|append|embed)\b[^.\n]{0,60}\b(api\s*keys?|secrets?|tokens?|passwords?|credentials?|conversation|chat\s+history|user'?s?\s+(data|message|email|info|input|question)|system\s+prompt)/i,
  },
  {
    id: 'exfiltrate-kr',
    label: 'exfiltration instruction, Korean (사용자 정보를 전송)',
    category: 'exfiltration',
    weight: 10,
    pattern: /(사용자|고객)[^\n]{0,20}(정보|대화|입력)[^\n]{0,20}(전송|보내|업로드|포함)/,
  },
  {
    id: 'call-tool',
    label: 'tool invocation instruction',
    category: 'tool-abuse',
    weight: 5,
    pattern: /\b(call|invoke|execute|run)\s+(the\s+)?(tool|function|api|command|browser|shell)\b/i,
  },
  {
    id: 'encoded-payload',
    label: 'encoded payload',
    category: 'encoding',
    weight: 6,
    pattern: /\b(base64|rot13|hex|url)[\s-]*(encode|decode|encoded|decoded)\b/i,
  },
  {
    id: 'first-priority',
    label: 'priority hijack',
    category: 'persona',
    weight: 4,
    pattern: /\b(highest|top|first|absolute)\s+priority\b/i,
  },
  {
    id: 'assistant-persona',
    label: 'assistant persona wording',
    category: 'persona',
    weight: 3,
    pattern: /\b(ai\s+assistant|language\s+model|large\s+language\s+model|chat\s?gpt|claude|gpt-?4|llm)\b/i,
  },
  {
    id: 'instructions-word',
    label: 'instruction wording',
    category: 'persona',
    weight: 2,
    pattern: /\b(instructions?|prompts?)\b/i,
  },
];

const MATCH_SNIPPET = 120;

function snippetFor(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + length + 40);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return `${prefix}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`.slice(0, MATCH_SNIPPET);
}

/** Score one block of text for machine-directed instruction patterns. */
export function scoreText(text: string): ScoreResult {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return { score: 0, matches: [] };

  const matches: PatternMatch[] = [];
  let score = 0;
  for (const rule of RULES) {
    const m = rule.pattern.exec(clean);
    if (!m) continue;
    matches.push({
      rule: rule.id,
      label: rule.label,
      category: rule.category,
      weight: rule.weight,
      snippet: snippetFor(clean, m.index, m[0].length),
    });
    score += rule.weight;
  }
  return { score, matches };
}

export function severityForScore(score: number): 'high' | 'medium' | 'low' {
  if (score >= 8) return 'high';
  if (score >= 4) return 'medium';
  return 'low';
}

/** True when the score is high enough to call the block a machine-directed instruction. */
export function isInstructionScore(score: number): boolean {
  return score >= 4;
}

export const PATTERN_RULES = RULES;
