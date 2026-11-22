import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import { extractPage } from './browser/extract.js';
import { extractRawText } from './html/text.js';
import { compareUserAgents } from './cloaking.js';
import { buildFindings, summarize, type UnicodeRecord } from './findings.js';
import { findInvisibleChars } from './score/unicode.js';
import type {
  DomRecord,
  RobotsInfo,
  ScanOptions,
  ScanSummary,
  Snapshot,
  UaObservation,
  UaSpec,
} from './types.js';
import { DEFAULT_USER_AGENTS, ROBOTS_AGENT_NAMES } from './ua.js';
import { PRODUCT, VERSION } from './version.js';

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_SETTLE = 800;
const DEFAULT_MAX_TEXT = 200_000;

export interface ScanResult {
  snapshot: Snapshot;
  warnings: string[];
}

function requireHttpUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`Not a valid URL: ${input}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Only http(s) URLs can be scanned (got ${url.protocol})`);
  }
  return url;
}

export function parseRobots(text: string, agentNames: string[]): RobotsInfo {
  const groups: Array<{ agents: string[]; disallow: string[] }> = [];
  let current: { agents: string[]; disallow: string[] } | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [keyRaw, ...rest] = line.split(':');
    if (!keyRaw || rest.length === 0) continue;
    const key = keyRaw.trim().toLowerCase();
    const value = rest.join(':').trim();
    if (key === 'user-agent') {
      if (!current || current.disallow.length > 0) {
        current = { agents: [], disallow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (key === 'disallow' && current) {
      current.disallow.push(value);
    }
  }

  const wanted = agentNames.map((n) => n.toLowerCase());
  const disallowedAgents: string[] = [];
  let blocksAll = false;
  for (const group of groups) {
    if (!group.disallow.includes('/')) continue;
    if (group.agents.includes('*')) blocksAll = true;
    for (const agent of group.agents) {
      if (wanted.includes(agent) && !disallowedAgents.includes(agent)) disallowedAgents.push(agent);
    }
  }
  return { found: true, blocksAll, disallowedAgents };
}

async function fetchRobots(url: URL, userAgent: string): Promise<RobotsInfo> {
  try {
    const robotsUrl = new URL('/robots.txt', url);
    const res = await fetch(robotsUrl, {
      headers: { 'user-agent': userAgent, accept: 'text/plain,*/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { found: false, blocksAll: false, disallowedAgents: [] };
    const body = await res.text();
    return parseRobots(body, Object.values(ROBOTS_AGENT_NAMES));
  } catch (err) {
    return { found: false, blocksAll: false, disallowedAgents: [], note: `robots.txt unreadable: ${(err as Error).message}` };
  }
}

async function observe(
  browser: Browser,
  url: string,
  ua: UaSpec,
  opts: Required<Pick<ScanOptions, 'timeoutMs' | 'settleMs' | 'maxTextChars' | 'viewport'>>,
): Promise<UaObservation> {
  const started = Date.now();
  const base: UaObservation = {
    uaId: ua.id,
    label: ua.label,
    userAgent: ua.userAgent,
    kind: ua.kind,
    status: null,
    finalUrl: url,
    title: '',
    blocked: false,
    durationMs: 0,
    byteLength: 0,
    rawHtml: '',
    rawTextBlocks: [],
    visibleText: '',
    visibleChars: 0,
    innerText: '',
    domText: '',
    hiddenBlocks: [],
    comments: [],
    attributes: [],
    metadata: [],
  };

  const context = await browser.newContext({
    userAgent: ua.userAgent,
    viewport: opts.viewport,
    serviceWorkers: 'block',
    ignoreHTTPSErrors: false,
    extraHTTPHeaders: { 'accept-language': 'en-US,en;q=0.9,ko;q=0.8' },
  });
  context.setDefaultTimeout(opts.timeoutMs);
  context.setDefaultNavigationTimeout(opts.timeoutMs);

  try {
    const page = await context.newPage();
    // Transpilers such as esbuild (used by tsx/vitest) inject a `__name` helper
    // into every named function. The extractor is serialized into the page, so
    // the helper has to exist there as well.
    await page.addInitScript({ content: 'globalThis.__name = globalThis.__name || ((fn) => fn);' });
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.timeoutMs });
    await page.waitForLoadState('networkidle', { timeout: Math.min(4_000, opts.timeoutMs) }).catch(() => {});
    if (opts.settleMs > 0) await page.waitForTimeout(opts.settleMs);

    const status = response ? response.status() : null;
    let rawHtml = '';
    try {
      rawHtml = response ? await response.text() : await page.content();
    } catch {
      rawHtml = await page.content();
    }

    const extraction = await page.evaluate(extractPage, opts.maxTextChars);

    const hiddenBlocks: DomRecord[] = extraction.hiddenBlocks.map((b) => ({
      text: b.text,
      channel: 'hidden-dom' as const,
      reasons: b.reasons,
      selector: b.selector,
      tag: b.tag,
    }));
    const comments: DomRecord[] = extraction.comments.map((c) => ({
      text: c.text,
      channel: 'comment' as const,
      reasons: ['html-comment'],
      selector: c.selector,
    }));
    const attributes: DomRecord[] = extraction.attributes.map((a) => ({
      text: a.text,
      channel: 'attribute' as const,
      reasons: [`attribute:${a.name}`],
      selector: a.selector,
      tag: a.tag,
    }));
    const metadata: DomRecord[] = extraction.metadata.map((m) => ({
      text: m.text,
      channel: 'script-metadata' as const,
      reasons: [m.kind],
      selector: m.kind,
    }));

    return {
      ...base,
      status,
      finalUrl: extraction.url || page.url(),
      title: extraction.title,
      blocked: status !== null && status >= 400,
      durationMs: Date.now() - started,
      byteLength: Buffer.byteLength(rawHtml, 'utf8'),
      rawHtml,
      rawTextBlocks: extractRawText(rawHtml),
      visibleText: extraction.visibleText,
      visibleChars: extraction.visibleChars,
      innerText: extraction.innerText,
      domText: extraction.domText,
      hiddenBlocks,
      comments,
      attributes,
      metadata,
    };
  } catch (err) {
    return {
      ...base,
      error: (err as Error).message.split('\n')[0],
      durationMs: Date.now() - started,
    };
  } finally {
    await context.close().catch(() => {});
  }
}

function collectUnicode(observations: UaObservation[]): UnicodeRecord[] {
  const records: UnicodeRecord[] = [];
  const seen = new Set<string>();
  for (const obs of observations) {
    if (obs.error) continue;
    const sources: Array<[UnicodeRecord['source'], string]> = [
      ['html', obs.rawHtml],
      ['visible', obs.visibleText],
      ['hidden', obs.hiddenBlocks.map((b) => b.text).join('\n')],
    ];
    for (const [source, text] of sources) {
      if (!text) continue;
      for (const hit of findInvisibleChars(text)) {
        const key = `${obs.uaId}|${source}|${hit.kind}|${hit.decoded ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        records.push({ uaId: obs.uaId, source, hit });
      }
    }
  }
  return records;
}

/** Scans one URL through the browser UA and every configured AI user agent. */
export async function scanUrl(options: ScanOptions): Promise<ScanResult> {
  const url = requireHttpUrl(options.url);
  const userAgents = options.userAgents?.length ? options.userAgents : DEFAULT_USER_AGENTS;
  const opts = {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT,
    settleMs: options.settleMs ?? DEFAULT_SETTLE,
    maxTextChars: options.maxTextChars ?? DEFAULT_MAX_TEXT,
    viewport: options.viewport ?? { width: 1280, height: 900 },
  };
  const warnings: string[] = [];

  const robots = await fetchRobots(url, userAgents.find((u) => u.kind === 'browser')!.userAgent);

  const browser = await chromium.launch({
    headless: options.headless ?? true,
    executablePath: options.browserExecutablePath,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const observations: UaObservation[] = [];
  try {
    for (const ua of userAgents) {
      const robotsName = ROBOTS_AGENT_NAMES[ua.id];
      if (options.respectRobots && ua.kind !== 'browser' && robotsName && robots.disallowedAgents.includes(robotsName)) {
        observations.push({
          uaId: ua.id,
          label: ua.label,
          userAgent: ua.userAgent,
          kind: ua.kind,
          status: null,
          finalUrl: url.toString(),
          title: '',
          blocked: false,
          error: 'skipped: robots.txt disallows this agent (--respect-robots)',
          durationMs: 0,
          byteLength: 0,
          rawHtml: '',
          rawTextBlocks: [],
          visibleText: '',
          visibleChars: 0,
          innerText: '',
          domText: '',
          hiddenBlocks: [],
          comments: [],
          attributes: [],
          metadata: [],
        });
        warnings.push(`${ua.label}: skipped because robots.txt disallows it`);
        continue;
      }
      const obs = await observe(browser, url.toString(), ua, opts);
      if (obs.error) warnings.push(`${ua.label}: ${obs.error}`);
      if (obs.blocked) warnings.push(`${ua.label}: HTTP ${obs.status} (explicitly denied)`);
      observations.push(obs);
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const baseline = observations.find((o) => o.kind === 'browser') ?? observations[0];
  if (!baseline || baseline.error || baseline.status === null) {
    throw new Error(`Could not load ${url} in a browser: ${baseline?.error ?? 'no response'}`);
  }
  if (baseline.blocked) {
    warnings.push(`The human-browser request itself was denied with HTTP ${baseline.status}`);
  }
  const cloaking = compareUserAgents(
    baseline,
    observations.filter((o) => o !== baseline),
  );
  const unicode = collectUnicode(observations);
  const findings = buildFindings(observations, cloaking, unicode);

  const base: Omit<Snapshot, 'summary'> = {
    schema: 'agentleak.snapshot/v1',
    product: PRODUCT,
    version: VERSION,
    createdAt: new Date().toISOString(),
    url: url.toString(),
    finalUrl: baseline.finalUrl,
    baselineUa: baseline.uaId,
    userAgents,
    robots,
    observations,
    cloaking,
    findings,
  };
  const summary: ScanSummary = summarize(base);
  return { snapshot: { ...base, summary }, warnings };
}

