/**
 * Runs inside the page through Playwright's evaluate().
 * It must be fully self-contained: no imports, no closures over module scope,
 * because only this function's source is sent to the browser.
 */

export interface PageExtraction {
  title: string;
  lang: string;
  url: string;
  innerText: string;
  domText: string;
  visibleText: string;
  visibleChars: number;
  hiddenChars: number;
  textNodes: number;
  hiddenBlocks: Array<{ text: string; reasons: string[]; selector: string; tag: string }>;
  comments: Array<{ text: string; selector: string }>;
  attributes: Array<{ name: string; text: string; selector: string; tag: string }>;
  metadata: Array<{ kind: 'json-ld' | 'meta-description' | 'noscript' | 'template'; label: string; text: string }>;
}

export function extractPage(maxTextChars: number): PageExtraction {
  const collapse = (s: string | null | undefined): string =>
    (s ?? '').replace(/\s+/g, ' ').trim();

  const LIMIT = maxTextChars;

  const selectorOf = (el: Element): string => {
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur.nodeType === 1 && parts.length < 6) {
      let s = cur.tagName.toLowerCase();
      const id = cur.getAttribute('id');
      if (id) {
        s += `#${id}`;
        parts.unshift(s);
        break;
      }
      const cls = (cur.getAttribute('class') ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
      if (cls) s += `.${cls}`;
      const parent: Element | null = cur.parentElement;
      if (parent) {
        const idx = Array.prototype.indexOf.call(parent.children, cur);
        if (idx >= 0) s += `:nth-child(${idx + 1})`;
      }
      parts.unshift(s);
      cur = parent;
    }
    return parts.join(' > ');
  };

  const parseColor = (value: string): { r: number; g: number; b: number; a: number } | null => {
    const m = /rgba?\(([^)]+)\)/.exec(value);
    if (!m) return null;
    const parts = m[1].split(/[,/]/).map((p) => parseFloat(p.trim()));
    if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };

  const effectiveBackground = (el: Element | null): { r: number; g: number; b: number } | null => {
    let cur: Element | null = el;
    while (cur) {
      const bg = parseColor(getComputedStyle(cur).backgroundColor);
      if (bg && bg.a > 0.95) return { r: bg.r, g: bg.g, b: bg.b };
      cur = cur.parentElement;
    }
    return null;
  };

  const ownReasons = (el: Element): string[] => {
    const reasons: string[] = [];
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' && (el as HTMLInputElement).type === 'hidden') {
      reasons.push('input-hidden');
      return reasons;
    }
    if (el.hasAttribute('hidden')) reasons.push('hidden-attribute');

    const cs = getComputedStyle(el);
    if (cs.display === 'none') reasons.push('display-none');
    if (cs.visibility === 'hidden' || cs.visibility === 'collapse') reasons.push('visibility-hidden');
    if (parseFloat(cs.opacity || '1') === 0) reasons.push('opacity-0');
    if (parseFloat(cs.fontSize || '16') === 0) reasons.push('font-size-0');
    if (cs.contentVisibility === 'hidden') reasons.push('content-visibility-hidden');

    if (el.getAttribute('aria-hidden') === 'true') reasons.push('aria-hidden');
    if (el.getAttribute('role') === 'presentation' || el.getAttribute('role') === 'none') {
      // presentation alone does not hide content from sighted users
    }

    const rect = el.getBoundingClientRect();
    const pos = cs.position;
    if ((pos === 'absolute' || pos === 'fixed') && (rect.right <= 0 || rect.bottom <= 0 || rect.left <= -500)) {
      reasons.push('offscreen-position');
    }
    const textIndent = parseFloat(cs.textIndent || '0');
    if (textIndent <= -500) reasons.push('text-indent-offscreen');

    const clip = cs.clip || '';
    const clipPath = cs.clipPath || '';
    if (/rect\(\s*0(px)?[\s,]+0(px)?[\s,]+0(px)?[\s,]+0(px)?\s*\)/.test(clip)) reasons.push('clip-rect-zero');
    if (/inset\(\s*(50|100)%/.test(clipPath) || /circle\(\s*0/.test(clipPath)) reasons.push('clip-path-zero');

    const w = parseFloat(cs.width || '0');
    const h = parseFloat(cs.height || '0');
    if (w <= 1 && h <= 1 && cs.overflow === 'hidden' && el.getClientRects().length > 0) {
      reasons.push('sr-only-1px');
    }
    if (
      reasons.length === 0 &&
      cs.display !== 'none' &&
      cs.visibility !== 'hidden' &&
      rect.width === 0 &&
      rect.height === 0 &&
      el.getClientRects().length === 0 &&
      el.childNodes.length > 0
    ) {
      reasons.push('zero-size');
    }

    const color = parseColor(cs.color);
    if (color && color.a === 0) reasons.push('color-transparent');
    if (color && color.a > 0) {
      const bg = effectiveBackground(el);
      if (
        bg &&
        Math.abs(color.r - bg.r) <= 2 &&
        Math.abs(color.g - bg.g) <= 2 &&
        Math.abs(color.b - bg.b) <= 2
      ) {
        reasons.push('same-color-as-background');
      }
    }
    return reasons;
  };

  const hiddenBlocks: PageExtraction['hiddenBlocks'] = [];
  const comments: PageExtraction['comments'] = [];
  const attributes: PageExtraction['attributes'] = [];
  const metadata: PageExtraction['metadata'] = [];
  const visibleParts: string[] = [];
  let visibleChars = 0;
  let hiddenChars = 0;
  let textNodes = 0;

  const SKIP = new Set(['script', 'style', 'template', 'noscript', 'head']);

  const walk = (node: Node, inherited: string[]): void => {
    if (node.nodeType === 8) {
      const text = collapse(node.nodeValue);
      if (text.length >= 6) comments.push({ text: text.slice(0, LIMIT), selector: '#comment' });
      return;
    }
    if (node.nodeType === 3) {
      const raw = node.nodeValue ?? '';
      const text = collapse(raw);
      if (!text) return;
      textNodes += 1;
      if (inherited.length > 0 && text.length >= 2) {
        hiddenBlocks.push({
          text: text.slice(0, LIMIT),
          reasons: [...new Set(inherited)],
          selector: node.parentElement ? selectorOf(node.parentElement) : '#text',
          tag: node.parentElement ? node.parentElement.tagName.toLowerCase() : '',
        });
        hiddenChars += text.length;
      } else {
        visibleParts.push(text);
        visibleChars += text.length;
      }
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (SKIP.has(tag)) return;

    const reasons = [...inherited];
    for (const r of ownReasons(el)) if (!reasons.includes(r)) reasons.push(r);

    if (tag === 'a' || tag === 'button' || tag === 'input' || tag === 'textarea') {
      const val = (el as HTMLInputElement).getAttribute('value');
      if (val && collapse(val).length >= 6) {
        attributes.push({ name: 'value', text: collapse(val).slice(0, LIMIT), selector: selectorOf(el), tag });
      }
    }

    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const interesting =
        name === 'title' ||
        name === 'alt' ||
        name === 'aria-label' ||
        name === 'aria-description' ||
        name === 'placeholder' ||
        name.startsWith('data-');
      if (!interesting) continue;
      const value = collapse(attr.value);
      if (value.length < 6 || !/[a-zA-Z\uac00-\ud7a3]/.test(value)) continue;
      attributes.push({ name, text: value.slice(0, LIMIT), selector: selectorOf(el), tag });
    }

    for (const child of Array.from(el.childNodes)) walk(child, reasons);
  };

  walk(document.body, []);

  for (const el of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    const text = collapse(el.textContent);
    if (text.length >= 10) metadata.push({ kind: 'json-ld', label: 'JSON-LD', text: text.slice(0, LIMIT) });
  }
  for (const el of Array.from(document.querySelectorAll('meta[name="description"], meta[property="og:description"]'))) {
    const text = collapse(el.getAttribute('content'));
    if (text.length >= 10) {
      metadata.push({ kind: 'meta-description', label: el.getAttribute('name') ?? 'og:description', text: text.slice(0, LIMIT) });
    }
  }
  for (const el of Array.from(document.querySelectorAll('noscript'))) {
    const text = collapse(el.textContent);
    if (text.length >= 10) metadata.push({ kind: 'noscript', label: 'noscript', text: text.slice(0, LIMIT) });
  }
  for (const el of Array.from(document.querySelectorAll('template'))) {
    const text = collapse((el as HTMLTemplateElement).content?.textContent ?? '');
    if (text.length >= 10) metadata.push({ kind: 'template', label: 'template', text: text.slice(0, LIMIT) });
  }

  return {
    title: document.title,
    lang: document.documentElement.lang || '',
    url: location.href,
    innerText: (document.body.innerText || '').slice(0, LIMIT),
    domText: (document.body.textContent || '').replace(/\s+/g, ' ').slice(0, LIMIT),
    visibleText: visibleParts.join('\n').slice(0, LIMIT),
    visibleChars,
    hiddenChars,
    textNodes,
    hiddenBlocks,
    comments,
    attributes,
    metadata,
  };
}
