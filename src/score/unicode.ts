export interface InvisibleCharHit {
  kind: 'tag-chars' | 'zero-width-run' | 'bidi-control' | 'variation-selectors';
  count: number;
  decoded?: string;
  sample: string;
  index: number;
}

const TAG_CHAR = /[\u{E0001}\u{E0020}-\u{E007E}]/gu;
const ZERO_WIDTH = /[\u200B\u200C\u200D\u2060\u2061\u2062\u2063\u2064\uFEFF\u180E]/gu;
const BIDI = /[\u202A-\u202E\u2066-\u2069]/gu;
const VARIATION = /[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu;

function decodeTagChars(chars: string): string {
  let out = '';
  for (const ch of chars) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0xe0001) continue;
    if (cp >= 0xe0020 && cp <= 0xe007e) out += String.fromCharCode(cp - 0xe0000);
  }
  return out;
}

function contextAround(text: string, index: number): string {
  const start = Math.max(0, index - 30);
  const end = Math.min(text.length, index + 60);
  return text.slice(start, end).replace(/\s+/g, ' ');
}

/**
 * Finds characters that render as nothing but travel through text extraction
 * pipelines: Unicode tag characters (an ASCII smuggling channel), zero-width
 * runs, bidi controls and variation-selector chains.
 */
export function findInvisibleChars(text: string): InvisibleCharHit[] {
  const hits: InvisibleCharHit[] = [];

  const tags = [...text.matchAll(TAG_CHAR)];
  if (tags.length >= 2) {
    const raw = tags.map((m) => m[0]).join('');
    hits.push({
      kind: 'tag-chars',
      count: tags.length,
      decoded: decodeTagChars(raw),
      sample: contextAround(text, tags[0].index ?? 0),
      index: tags[0].index ?? 0,
    });
  }

  const zero = [...text.matchAll(ZERO_WIDTH)];
  if (zero.length >= 4) {
    hits.push({
      kind: 'zero-width-run',
      count: zero.length,
      sample: contextAround(text, zero[0].index ?? 0),
      index: zero[0].index ?? 0,
    });
  }

  const bidi = [...text.matchAll(BIDI)];
  if (bidi.length >= 2) {
    hits.push({
      kind: 'bidi-control',
      count: bidi.length,
      sample: contextAround(text, bidi[0].index ?? 0),
      index: bidi[0].index ?? 0,
    });
  }

  const variation = [...text.matchAll(VARIATION)];
  if (variation.length >= 6) {
    hits.push({
      kind: 'variation-selectors',
      count: variation.length,
      sample: contextAround(text, variation[0].index ?? 0),
      index: variation[0].index ?? 0,
    });
  }

  return hits;
}

export function stripInvisible(text: string): string {
  return text.replace(TAG_CHAR, '').replace(ZERO_WIDTH, '').replace(BIDI, '');
}
