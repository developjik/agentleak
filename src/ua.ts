import type { UaSpec } from './types.js';

/**
 * The browser we compare against and the agents a site may treat differently.
 * UA strings are the published ones as of late 2025; only the identifier is
 * relied upon, never browser fingerprinting.
 */
export const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

export const DEFAULT_USER_AGENTS: UaSpec[] = [
  { id: 'browser', label: 'Human browser (Chrome 141)', userAgent: BROWSER_UA, kind: 'browser' },
  {
    id: 'gptbot',
    label: 'OpenAI GPTBot',
    userAgent:
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)',
    kind: 'ai-crawler',
  },
  {
    id: 'claudebot',
    label: 'Anthropic ClaudeBot',
    userAgent:
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
    kind: 'ai-crawler',
  },
  {
    id: 'chatgpt-user',
    label: 'OpenAI ChatGPT-User',
    userAgent: 'Mozilla/5.0 (compatible; ChatGPT-User/1.0; +https://openai.com/bot)',
    kind: 'ai-user',
  },
  {
    id: 'perplexitybot',
    label: 'PerplexityBot',
    userAgent:
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)',
    kind: 'ai-crawler',
  },
];

export const EXTRA_USER_AGENTS: UaSpec[] = [
  {
    id: 'claude-user',
    label: 'Anthropic Claude-User',
    userAgent: 'Mozilla/5.0 (compatible; Claude-User/1.0; +https://www.anthropic.com/bot)',
    kind: 'ai-user',
  },
  {
    id: 'bingbot',
    label: 'Bingbot',
    userAgent:
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    kind: 'ai-crawler',
  },
];

export const ALL_USER_AGENTS = [...DEFAULT_USER_AGENTS, ...EXTRA_USER_AGENTS];

/** Resolves comma-separated ids or aliases into UA specs. */
export function resolveUserAgents(input?: string): UaSpec[] {
  if (!input || !input.trim()) return DEFAULT_USER_AGENTS;
  const wanted = input
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const picked: UaSpec[] = [];
  for (const id of wanted) {
    const found = ALL_USER_AGENTS.find((u) => u.id === id);
    if (!found) {
      throw new Error(`Unknown user agent "${id}". Known: ${ALL_USER_AGENTS.map((u) => u.id).join(', ')}`);
    }
    if (!picked.some((p) => p.id === found.id)) picked.push(found);
  }
  if (!picked.some((p) => p.kind === 'browser')) {
    picked.unshift(ALL_USER_AGENTS.find((u) => u.kind === 'browser')!);
  }
  return picked;
}

/** Robots.txt query names that correspond to the agent UAs above. */
export const ROBOTS_AGENT_NAMES: Record<string, string> = {
  gptbot: 'gptbot',
  claudebot: 'claudebot',
  'chatgpt-user': 'chatgpt-user',
  'claude-user': 'claude-user',
  perplexitybot: 'perplexitybot',
  bingbot: 'bingbot',
};
