import type { RawTextBlock } from '../types.js';

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  reg: '®',
  copy: '©',
  trade: '™',
  eacute: 'é',
  egrave: 'è',
  agrave: 'à',
  ccedil: 'ç',
  ntilde: 'ñ',
  uuml: 'ü',
  ouml: 'ö',
  auml: 'ä',
  szlig: 'ß',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const cp = parseInt(body.slice(2), 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : whole;
    }
    if (body.startsWith('#')) {
      const cp = parseInt(body.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

export function normalizeText(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

function splitBlocks(text: string, kind: RawTextBlock['kind'], minLength = 20): RawTextBlock[] {
  const blocks: RawTextBlock[] = [];
  for (const line of text.split('\n')) {
    const text2 = normalizeText(decodeEntities(line));
    if (text2.length < minLength) continue;
    if (!/[a-zA-Z\uac00-\ud7a3]/.test(text2)) continue;
    blocks.push({ text: text2, kind });
  }
  return blocks;
}

/**
 * Extracts the plain text a request-only client (a crawler that does not run
 * JavaScript) would receive, separated by source so comments and noscript
 * content can be reported on their own channels.
 */
export function extractRawText(html: string): RawTextBlock[] {
  const blocks: RawTextBlock[] = [];

  const comments: string[] = [];
  const withoutComments = html.replace(/<!--([\s\S]*?)-->/g, (_m, body: string) => {
    comments.push(body);
    return '\n';
  });
  for (const c of comments) blocks.push(...splitBlocks(c, 'comment'));

  const noscripts: string[] = [];
  const withoutNoScript = withoutComments.replace(/<noscript\b[^>]*>([\s\S]*?)<\/noscript>/gi, (_m, body: string) => {
    noscripts.push(body.replace(/<[^>]+>/g, ' '));
    return '\n';
  });
  for (const n of noscripts) blocks.push(...splitBlocks(n, 'noscript'));

  const titles: string[] = [];
  const withoutTitle = withoutNoScript.replace(/<title\b[^>]*>([\s\S]*?)<\/title>/gi, (_m, body: string) => {
    titles.push(body);
    return '\n';
  });
  for (const t of titles) blocks.push(...splitBlocks(t, 'title', 3));

  const withoutCode = withoutTitle
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '\n')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '\n')
    .replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, '\n');

  const bodyMatch = /<body\b[^>]*>([\s\S]*?)(<\/body>|$)/i.exec(withoutCode);
  const body = bodyMatch ? bodyMatch[1] : withoutCode;

  const spaced = body
    .replace(/<(br|\/p|\/div|\/section|\/article|\/li|\/ul|\/ol|\/h[1-6]|\/tr|\/td|\/th|\/table|\/header|\/footer|\/main|\/nav|\/aside|\/blockquote|\/pre|\/label|\/button|\/a|\/span|\/strong|\/em|\/b|\/i|\/small|\/figcaption|\/dl|\/dt|\/dd|\/form)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  blocks.push(...splitBlocks(spaced, 'body'));

  return blocks;
}

export function wordTokens(text: string): string[] {
  return normalizeText(text)
    .toLowerCase()
    .split(/[^a-z0-9\uac00-\ud7a3]+/)
    .filter((t) => t.length > 1);
}

/** Jaccard similarity over word sets; 1 means the same vocabulary. */
export function tokenSimilarity(a: string, b: string): number {
  const ta = new Set(wordTokens(a));
  const tb = new Set(wordTokens(b));
  if (ta.size === 0 && tb.size === 0) return 1;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 1 : inter / union;
}

/**
 * Returns the blocks that exist in `blocks` but whose words are not found in
 * `haystack` (a token-coverage test, so line breaks and markup noise do not
 * create false positives).
 */
export function blocksMissingFrom(blocks: RawTextBlock[], haystack: string): RawTextBlock[] {
  const tokens = new Set(wordTokens(haystack));
  const out: RawTextBlock[] = [];
  for (const block of blocks) {
    const words = wordTokens(block.text);
    if (words.length < 4) continue;
    let found = 0;
    for (const w of words) if (tokens.has(w)) found += 1;
    const coverage = found / words.length;
    if (coverage < 0.6) out.push(block);
  }
  return out;
}

/** Body text present in the raw response but gone from the rendered DOM. */
export function rawOnlyBlocks(observation: { rawTextBlocks: RawTextBlock[]; domText: string }): string[] {
  return blocksMissingFrom(
    observation.rawTextBlocks.filter((b) => b.kind === 'body'),
    observation.domText,
  ).map((b) => b.text);
}
