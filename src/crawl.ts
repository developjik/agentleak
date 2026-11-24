import { open } from 'node:fs/promises';
import { scanUrl } from './scan.js';
import { diffSnapshots } from './diff.js';
import type { DiffResult, ScanOptions, Snapshot } from './types.js';
import { VERSION } from './version.js';

export interface CrawlPage { url: string; snapshot?: Snapshot; error?: string; warnings: string[] }
export interface CrawlSnapshot {
  schema: 'agentleak.crawl/v1'; version: string; createdAt: string;
  pages: CrawlPage[]; warnings: string[];
  profile?: { timeoutMs: number; settleMs: number; maxTextChars: number; viewport: { width: number; height: number }; respectRobots: boolean; vectors: boolean };
  domains: Array<{ origin: string; pages: number; successful: number; failed: number; findings: number; leaks: number }>;
}
export interface CrawlDiff {
  pages: Array<{ url: string; diff: DiffResult }>;
  /** Never infer removed instructions from a page that failed or was not scanned. */
  uncomparable: Array<{ url: string; reason: string }>;
  addedPages: string[];
  newInstructions: number; removedInstructions: number;
}
export interface CrawlOptions extends Omit<ScanOptions, 'url'> {
  urls?: string[]; urlsFile?: string; sitemap?: string;
  maxPages?: number; concurrency?: number;
}
function httpUrl(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Crawl URLs must be HTTP(S) without credentials');
  url.hash = ''; return url;
}
function integer(value: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}
function decodeXml(value: string): string {
  return value.replace(/&([^;]+);/g, (_, entity: string) => {
    const known: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (known[entity] !== undefined) return known[entity];
    const n = /^#x[0-9a-f]+$/i.test(entity) ? parseInt(entity.slice(2), 16) : /^#\d+$/.test(entity) ? Number(entity.slice(1)) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) throw new Error('Invalid sitemap entity');
    return String.fromCodePoint(n);
  });
}
/** Bounded sitemap subset: urlset/url/loc or sitemapindex/sitemap/loc; no DTD/entities. */
export function parseSitemap(xml: string): { index: boolean; locations: string[] } {
  if (Buffer.byteLength(xml) > 5_000_000 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Sitemap too large or contains a forbidden DTD/entity declaration');
  const tokens = xml.match(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]*>|[^<]+/g) ?? [];
  const stack: string[] = []; let root = ''; let text = ''; let closed = false;
  const locations: string[] = [];
  for (const token of tokens) {
    if (token.startsWith('<!--') || token.startsWith('<?')) continue;
    if (token.startsWith('<![CDATA[')) { if (stack.at(-1) === 'loc') text += token.slice(9, -3); continue; }
    if (token.startsWith('</')) {
      const name = /^<\/([\w:.-]+)\s*>$/.exec(token)?.[1]?.split(':').at(-1);
      if (!name || stack.pop() !== name) throw new Error('Malformed sitemap XML');
      if (name === 'loc') { if (!text.trim()) throw new Error('Empty sitemap loc'); locations.push(text.trim()); text = ''; }
      if (!stack.length) closed = true;
    } else if (token.startsWith('<')) {
      const match = /^<([\w:.-]+)(?:\s+[^<>]*)?\s*\/?\s*>$/.exec(token);
      if (!match) throw new Error('Malformed sitemap XML');
      const name = match[1]!.split(':').at(-1)!;
      if (!stack.length) { if (root || closed || !['urlset', 'sitemapindex'].includes(name)) throw new Error('Expected one sitemap root'); root = name; }
      if (name === 'loc' && !(stack.length === 2 && stack[0] === root && stack[1] === (root === 'urlset' ? 'url' : 'sitemap'))) throw new Error('Unexpected sitemap loc');
      if (stack.at(-1) === 'loc') throw new Error('Nested markup in sitemap loc');
      if (token.endsWith('/>') && name === 'loc') throw new Error('Empty sitemap loc');
      if (!token.endsWith('/>')) stack.push(name);
      else if (!stack.length) closed = true;
    } else {
      if (stack.at(-1) === 'loc') text += decodeXml(token);
      else if (!stack.length && token.trim()) throw new Error('Text outside sitemap root');
    }
  }
  if (stack.length || !root || !closed) throw new Error('Incomplete sitemap XML');
  return { index: root === 'sitemapindex', locations };
}
async function boundedText(response: Response, max: number): Promise<string> {
  const reader = response.body?.getReader(); if (!reader) return '';
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.length; if (size > max) throw new Error('Input exceeds byte limit'); chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return Buffer.concat(chunks).toString('utf8');
}
async function sitemapText(url: URL, origin: string): Promise<string> {
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (url.origin !== origin) throw new Error('Cross-origin sitemap redirect refused');
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
    if ([301,302,303,307,308].includes(response.status)) {
      const next = response.headers.get('location'); await response.body?.cancel();
      if (!next) throw new Error('Sitemap redirect lacks Location'); url = httpUrl(new URL(next, url).href); continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Sitemap HTTP ${response.status}`); }
    return boundedText(response, 5_000_000);
  }
  throw new Error('Too many sitemap redirects');
}
export async function collectCrawlUrls(options: CrawlOptions): Promise<{ urls: string[]; warnings: string[] }> {
  const max = integer(options.maxPages ?? 100, 1, 1000, 'maxPages');
  const urls = new Set<string>(); const warnings: string[] = [];
  let capped = false;
  const add = (value: string, origin?: string) => {
    const url = httpUrl(value);
    if (origin && url.origin !== origin) { warnings.push(`Skipped cross-origin sitemap page: ${url.href}`); return; }
    if (urls.size >= max && !urls.has(url.href)) { capped = true; return; } urls.add(url.href);
  };
  for (const url of options.urls ?? []) add(url);
  if (options.urlsFile) {
    const handle = await open(options.urlsFile, 'r');
    let file: string;
    try {
      const buffer = Buffer.alloc(5_000_001);
      let total = 0;
      while (total < buffer.length) { const { bytesRead } = await handle.read(buffer, total, buffer.length - total); if (!bytesRead) break; total += bytesRead; }
      if (total > 5_000_000) throw new Error('URL list exceeds byte limit');
      file = buffer.subarray(0, total).toString('utf8');
    } finally { await handle.close(); }
    for (const line of file.split(/\r?\n/)) { const url = line.trim(); if (url && !url.startsWith('#')) add(url); }
  }
  if (options.sitemap) {
    const root = httpUrl(options.sitemap); const queue = [root.href]; const visited = new Set<string>();
    while (queue.length && urls.size < max) {
      const next = queue.shift()!; if (visited.has(next)) continue;
      if (visited.size >= 20) { warnings.push('Stopped at 20 sitemap documents'); break; }
      visited.add(next);
      let parsed: ReturnType<typeof parseSitemap>;
      try { parsed = parseSitemap(await sitemapText(httpUrl(next), root.origin)); }
      catch (error) { if (next === root.href) throw error; warnings.push(`Sitemap unavailable: ${next}: ${error instanceof Error ? error.message : String(error)}`); continue; }
      for (const loc of parsed.locations) {
        const url = httpUrl(loc);
        if (url.origin !== root.origin) { warnings.push(`Skipped cross-origin sitemap location: ${url.href}`); continue; }
        if (parsed.index) { if (queue.length < 1000) queue.push(url.href); else capped = true; }
        else add(url.href, root.origin);
      }
    }
    if (queue.length) capped = true;
  }
  if (capped) warnings.push(`Input truncated at configured limits (maxPages=${max})`);
  if (!urls.size) throw new Error('No crawl URLs found');
  return { urls: [...urls], warnings };
}
export async function crawlSite(options: CrawlOptions): Promise<CrawlSnapshot> {
  const concurrency = integer(options.concurrency ?? 2, 1, 4, 'concurrency');
  const { urls, warnings } = await collectCrawlUrls(options);
  const pages: CrawlPage[] = new Array(urls.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, async () => {
    while (next < urls.length) {
      const index = next++; const url = urls[index]!;
      try {
        const result = await scanUrl({ ...options, url });
        const snapshot = result.snapshot;
        const failed = snapshot.observations.some(o => o.error || o.blocked || o.rawTextError) || snapshot.vectors?.some(v => v.variant.error || v.variant.blocked || v.variant.rawTextError);
        pages[index] = { url, snapshot, ...(failed ? { error: 'Incomplete or denied UA coverage; evidence retained, not comparable' } : {}), warnings: result.warnings };
      } catch (error) { pages[index] = { url, error: error instanceof Error ? error.message : String(error), warnings: [] }; }
    }
  }));
  const domains: CrawlSnapshot['domains'] = [];
  for (const page of pages) {
    const origin = new URL(page.url).origin; let group = domains.find(d => d.origin === origin);
    if (!group) { group = { origin, pages: 0, successful: 0, failed: 0, findings: 0, leaks: 0 }; domains.push(group); }
    group.pages++; if (page.error) group.failed++; else group.successful++;
    group.findings += page.snapshot?.findings.length ?? 0; group.leaks += page.snapshot?.summary.leakCount ?? 0;
  }
  return { schema: 'agentleak.crawl/v1', version: VERSION, createdAt: new Date().toISOString(), pages, warnings, domains, profile: { timeoutMs: options.timeoutMs ?? 30000, settleMs: options.settleMs ?? 800, maxTextChars: options.maxTextChars ?? 200000, viewport: options.viewport ?? { width: 1280, height: 900 }, respectRobots: Boolean(options.respectRobots), vectors: Boolean(options.vectors) } };
}
export function parseCrawlSnapshot(value: unknown): CrawlSnapshot {
  const file = value as CrawlSnapshot;
  if (!file || file.schema !== 'agentleak.crawl/v1' || !Array.isArray(file.pages)) throw new Error('Expected agentleak.crawl/v1 snapshot');
  const seen = new Set<string>();
  for (const page of file.pages) {
    const key = httpUrl(page.url).href;
    if (seen.has(key)) throw new Error('Duplicate crawl page URL'); seen.add(key);
    if (!page.error && (!page.snapshot || page.snapshot.schema !== 'agentleak.snapshot/v1' || !Array.isArray(page.snapshot.findings))) throw new Error('Crawl page lacks snapshot or error');
    if (page.snapshot && httpUrl(page.snapshot.url).href !== key) throw new Error('Crawl page snapshot URL mismatch');
  }
  return file;
}
export function diffCrawls(before: CrawlSnapshot, after: CrawlSnapshot): CrawlDiff {
  parseCrawlSnapshot(before); parseCrawlSnapshot(after);
  const result: CrawlDiff = { pages: [], uncomparable: [], addedPages: [], newInstructions: 0, removedInstructions: 0 };
  const old = new Map(before.pages.map(p => [httpUrl(p.url).href, p]));
  const current = new Map(after.pages.map(p => [httpUrl(p.url).href, p]));
  for (const url of new Set([...old.keys(), ...current.keys()])) {
    const b = old.get(url), a = current.get(url);
    if (!a || !b || a.error || b.error || !a.snapshot || !b.snapshot) {
      if (!b && a?.snapshot && !a.error) { result.addedPages.push(url); result.newInstructions += a.snapshot.findings.filter(f => f.score >= 4).length; }
      result.uncomparable.push({ url, reason: !b ? 'new page, no baseline' : !a ? 'not scanned, not proof of removal' : 'failed/incomplete page, not proof of removal' }); continue;
    }
    if (JSON.stringify(before.profile) !== JSON.stringify(after.profile) || JSON.stringify(a.snapshot.userAgents) !== JSON.stringify(b.snapshot.userAgents) || Boolean(a.snapshot.vectors) !== Boolean(b.snapshot.vectors)) { result.uncomparable.push({ url, reason: 'Scan profiles differ' }); continue; }
    let diff: DiffResult;
    try { diff = diffSnapshots(b.snapshot, a.snapshot); }
    catch (error) { result.uncomparable.push({ url, reason: `Invalid or legacy evidence: ${error instanceof Error ? error.message : String(error)}` }); continue; }
    result.pages.push({ url, diff });
    result.newInstructions += diff.newInstructions.length;
    result.removedInstructions += diff.removed.filter(f => f.score >= 4).length;
  }
  return result;
}
function safe(text: string): string { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '&#124;').replace(/[\r\n]/g, ' '); }
export function renderCrawlMarkdown(file: CrawlSnapshot, diff?: CrawlDiff): string {
  const lines = ['# agentleak crawl', '', `Pages: ${file.pages.length}; incomplete/failed: ${file.pages.filter(p => p.error).length}`, '', '| Origin | Pages | Complete | Failed/incomplete | Findings | Leaks |', '| --- | ---: | ---: | ---: | ---: | ---: |'];
  for (const d of file.domains) lines.push(`| ${safe(d.origin)} | ${d.pages} | ${d.successful} | ${d.failed} | ${d.findings} | ${d.leaks} |`);
  for (const p of file.pages) {
    lines.push('', `## ${safe(p.url)}`, '', p.error ? `INCOMPLETE: ${safe(p.error)}` : 'Complete');
    for (const f of p.snapshot?.findings ?? []) lines.push(`- ${f.severity} / ${f.channel} / score ${f.score}: ${safe(f.snippet)}`);
    for (const w of p.warnings) lines.push(`- Warning: ${safe(w)}`);
  }
  if (diff) {
    lines.push('', '## Baseline comparison', '', `New instruction blocks: ${diff.newInstructions}; removed instruction blocks: ${diff.removedInstructions}`);
    for (const p of diff.pages) lines.push(`- ${safe(p.url)}: ${p.diff.newInstructions.length} new, ${p.diff.removed.filter(f => f.score >= 4).length} removed`);
    for (const p of diff.uncomparable) lines.push(`- UNCOMPARED ${safe(p.url)}: ${safe(p.reason)}`);
  }
  for (const w of file.warnings) lines.push(`- Warning: ${safe(w)}`);
  return lines.join('\n') + '\n';
}
