#!/usr/bin/env node
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { crawlSite, diffCrawls, parseCrawlSnapshot, renderCrawlMarkdown, writeCrawlJson } from './crawl.js';
import { scanUrl } from './scan.js';
import { diffSnapshots, loadSnapshot, renderDiffMarkdown, renderDiffTerminal } from './diff.js';
import { renderMarkdown } from './report/markdown.js';
import { renderTerminal } from './report/terminal.js';
import { painter, slugForUrl, stamp } from './report/util.js';
import { resolveUserAgents } from './ua.js';
import { PRODUCT, VERSION } from './version.js';

const HELP = `agentleak ${VERSION} — audit what your site tells AI agents but hides from humans

Usage
  agentleak scan <url> [options]
  agentleak crawl --sitemap <url> | --urls <file> [options]
  agentleak diff <before.json> <after.json> [options]
  agentleak fixtures [--port 4319]
  agentleak --help | --version

Scan options
  --out <dir>            Where reports are written (default: .)
  --format <list>        terminal,json,markdown (default: all three)
  --ua <list>            browser,gptbot,claudebot,chatgpt-user,perplexitybot,
                         claude-user,bingbot (default: browser + 4 AI agents)
  --timeout <ms>         Navigation timeout (default: 30000)
  --settle <ms>          Extra wait after load, for late JavaScript (default: 800)
  --viewport <WxH>       Rendering viewport (default: 1280x900)
  --vectors              Also compare language, Referer and warmed-session axes (extra requests)
  --respect-robots       Skip agents disallowed for this URL by robots.txt
  --fail-on-leak         Exit 1 when a medium or high finding exists
  --fail-on <level>      leak | high | never (default: never)
  --max-findings <n>     Findings shown in the terminal summary (default: 8)
  --no-color             Disable ANSI colour
  --quiet                Only write files and set the exit code

Crawl options (plus scan options)
  --sitemap <url>        Same-origin sitemap or sitemap index (20 documents max)
  --urls <file>          HTTP(S) URL per line, # comments allowed
  --max-pages <n>        1..1000, default 100
  --concurrency <n>      1..4 pages concurrently, default 2
  --baseline <file>      Previous crawl JSON for page-level comparison
  Partial scans write evidence then exit 2; leak gate exits 1 otherwise.

Diff options
  --format <list>        terminal,markdown (default: both)
  --out <dir>            Where the Markdown diff is written (default: .)
  --fail-on <level>      new-instructions | never (default: never)
  --no-color             Disable ANSI colour

Exit codes
  0  scan/diff finished without crossing the requested gate
  1  the gate was crossed (leak or new instructions)
  2  usage or runtime error
`;

function parseViewport(value: string): { width: number; height: number } {
  const m = /^(\d+)x(\d+)$/i.exec(value.trim());
  if (!m) throw new Error(`--viewport expects WIDTHxHEIGHT, e.g. 1280x900 (got "${value}")`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

function parseFormatList(value: string, allowed: string[]): string[] {
  const list = value
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const item of list) {
    if (!allowed.includes(item)) throw new Error(`Unknown format "${item}". Allowed: ${allowed.join(', ')}`);
  }
  return list;
}

function numOpt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} expects a non-negative number (got "${value}")`);
  return n;
}

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        sitemap: { type: 'string' },
        urls: { type: 'string' },
        'max-pages': { type: 'string' },
        concurrency: { type: 'string' },
        baseline: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
        out: { type: 'string' },
        format: { type: 'string' },
        ua: { type: 'string' },
        timeout: { type: 'string' },
        settle: { type: 'string' },
        viewport: { type: 'string' },
        'respect-robots': { type: 'boolean' },
        vectors: { type: 'boolean' },
        'fail-on': { type: 'string' },
        'fail-on-leak': { type: 'boolean' },
        'max-findings': { type: 'string' },
        'no-color': { type: 'boolean' },
        quiet: { type: 'boolean' },
        port: { type: 'string' },
      },
    });
  } catch (err) {
    process.stderr.write(`${PRODUCT}: ${(err as Error).message}\n\n${HELP}`);
    return 2;
  }

  const { values, positionals } = parsed;
  const color = !values['no-color'] && Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

  if (values.help || positionals.length === 0) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${PRODUCT} ${VERSION}\n`);
    return 0;
  }

  const command = positionals[0];

  if (command === 'fixtures') {
    const { startFixtureServer } = await import('./fixtures/serve.js');
    const port = numOpt(values.port, 4319, 'port');
    const server = await startFixtureServer(port);
    process.stdout.write(`agentleak fixtures on ${server.url} (Ctrl+C to stop)\n`);
    await new Promise<void>((resolvePromise) => {
      const stop = () => {
        server.close().then(() => resolvePromise());
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
    return 0;
  }

  if (command === 'crawl') {
    try {
      if (!values.sitemap && !values.urls) throw new Error('--sitemap or --urls is required');
      const formats = parseFormatList(values.format ?? 'terminal,json,markdown', ['terminal', 'json', 'markdown']);
      const failOn = values['fail-on-leak'] ? 'leak' : (values['fail-on'] ?? 'never');
      if (!['leak', 'high', 'never'].includes(failOn)) throw new Error('--fail-on expects leak|high|never');
      const baseline = values.baseline ? parseCrawlSnapshot(JSON.parse(readFileSync(values.baseline, 'utf8'))) : undefined;
      const snapshot = await crawlSite({ sitemap: values.sitemap, urlsFile: values.urls,
        maxPages: numOpt(values['max-pages'], 100, 'max-pages'), concurrency: numOpt(values.concurrency, 2, 'concurrency'),
        userAgents: resolveUserAgents(values.ua), timeoutMs: numOpt(values.timeout, 30000, 'timeout'),
        settleMs: numOpt(values.settle, 800, 'settle'), viewport: values.viewport ? parseViewport(values.viewport) : undefined,
        respectRobots: Boolean(values['respect-robots']), vectors: Boolean(values.vectors) });
      const comparison = baseline ? diffCrawls(baseline, snapshot) : undefined;
      const out = resolve(values.out ?? '.'); mkdirSync(out, { recursive: true });
      const base = resolve(out, `agentleak-crawl-${stamp()}-${randomUUID().slice(0, 8)}`);
      if (formats.includes('json')) writeCrawlJson(`${base}.json`, { ...snapshot, ...(comparison ? { comparison } : {}) });
      if (formats.includes('markdown')) writeFileSync(`${base}.md`, renderCrawlMarkdown(snapshot, comparison));
      if (!values.quiet) {
        if (formats.includes('terminal')) process.stdout.write(renderCrawlMarkdown(snapshot, comparison, numOpt(values['max-findings'], 8, 'max-findings')));
        if (formats.includes('json')) process.stdout.write(`JSON: ${base}.json\n`);
        if (formats.includes('markdown')) process.stdout.write(`Markdown: ${base}.md\n`);
      }
      if (snapshot.pages.some(p => p.error) || snapshot.warnings.length || comparison?.uncomparable.length) return 2;
      const leaks = snapshot.pages.some(p => failOn === 'leak' ? p.snapshot?.summary.leak : failOn === 'high' && (p.snapshot?.summary.findingsBySeverity.high ?? 0) > 0);
      return leaks ? 1 : 0;
    } catch (error) { process.stderr.write(`agentleak crawl failed: ${error instanceof Error ? error.message : String(error)}\n`); return 2; }
  }

  if (command === 'scan') {
    const url = positionals[1];
    if (!url) {
      process.stderr.write('agentleak scan: a URL is required\n');
      return 2;
    }
    const formats = parseFormatList(values.format ?? 'terminal,json,markdown', ['terminal', 'json', 'markdown']);
    const outDir = resolve(values.out ?? '.');
    const failOn = values['fail-on-leak'] ? 'leak' : (values['fail-on'] ?? 'never');
    if (!['leak', 'high', 'never'].includes(failOn)) {
      process.stderr.write(`agentleak scan: --fail-on expects leak|high|never (got "${failOn}")\n`);
      return 2;
    }

    try {
      const { snapshot, warnings } = await scanUrl({
        url,
        userAgents: resolveUserAgents(values.ua),
        timeoutMs: values.timeout ? numOpt(values.timeout, 30_000, 'timeout') : undefined,
        settleMs: values.settle !== undefined ? numOpt(values.settle, 800, 'settle') : undefined,
        viewport: values.viewport ? parseViewport(values.viewport) : undefined,
        respectRobots: Boolean(values['respect-robots']),
        vectors: Boolean(values.vectors),
      });

      mkdirSync(outDir, { recursive: true });
      const base = `agentleak-${slugForUrl(snapshot.url)}-${stamp(new Date(snapshot.createdAt))}`;
      const paths: { json?: string; markdown?: string } = {};
      if (formats.includes('json')) {
        paths.json = resolve(outDir, `${base}.json`);
        writeFileSync(paths.json, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
      }
      if (formats.includes('markdown')) {
        paths.markdown = resolve(outDir, `${base}.md`);
        writeFileSync(paths.markdown, renderMarkdown(snapshot), 'utf8');
      }

      for (const warning of warnings) process.stderr.write(`${painter(color).yellow('!')} ${warning}\n`);

      if (!values.quiet) {
        if (formats.includes('terminal')) {
          process.stdout.write(
            renderTerminal(snapshot, {
              color,
              maxFindings: values['max-findings'] ? numOpt(values['max-findings'], 8, 'max-findings') : undefined,
              reportPaths: paths,
            }),
          );
        } else {
          if (paths.json) process.stdout.write(`JSON: ${paths.json}\n`);
          if (paths.markdown) process.stdout.write(`Markdown: ${paths.markdown}\n`);
        }
      }

      const fails =
        (failOn === 'leak' && snapshot.summary.leak) ||
        (failOn === 'high' && snapshot.summary.findingsBySeverity.high > 0);
      return fails ? 1 : 0;
    } catch (err) {
      process.stderr.write(`agentleak scan failed: ${(err as Error).message}\n`);
      return 2;
    }
  }

  if (command === 'diff') {
    const [beforePath, afterPath] = [positionals[1], positionals[2]];
    if (!beforePath || !afterPath) {
      process.stderr.write('agentleak diff: two snapshot paths are required\n');
      return 2;
    }
    const formats = parseFormatList(values.format ?? 'terminal,markdown', ['terminal', 'markdown', 'json']);
    const outDir = resolve(values.out ?? '.');
    const failOn = values['fail-on'] ?? 'never';
    if (!['new-instructions', 'never', 'any'].includes(failOn)) {
      process.stderr.write(`agentleak diff: --fail-on expects new-instructions|any|never (got "${failOn}")\n`);
      return 2;
    }

    try {
      const before = loadSnapshot(beforePath);
      const after = loadSnapshot(afterPath);
      if (before.url !== after.url) {
        process.stderr.write(
          `${painter(color).yellow('!')} snapshots are from different URLs (${before.url} vs ${after.url})\n`,
        );
      }
      const result = diffSnapshots(before, after);

      mkdirSync(outDir, { recursive: true });
      const base = `agentleak-diff-${slugForUrl(after.url)}-${stamp()}`;
      const paths: { markdown?: string } = {};
      if (formats.includes('markdown')) {
        paths.markdown = resolve(outDir, `${base}.md`);
        writeFileSync(paths.markdown, renderDiffMarkdown(result), 'utf8');
      }
      if (formats.includes('terminal')) process.stdout.write(renderDiffTerminal(result, color));
      else if (paths.markdown) process.stdout.write(`Markdown: ${paths.markdown}\n`);

      if (paths.markdown) process.stderr.write(`Markdown diff: ${paths.markdown}\n`);

      const fails =
        (failOn === 'new-instructions' && result.newInstructions.length > 0) ||
        (failOn === 'any' && (result.added.length > 0 || result.changed.length > 0));
      return fails ? 1 : 0;
    } catch (err) {
      process.stderr.write(`agentleak diff failed: ${(err as Error).message}\n`);
      return 2;
    }
  }

  process.stderr.write(`agentleak: unknown command "${command}"\n\n${HELP}`);
  return 2;
}

const isEntry =
  Boolean(process.argv[1]) && (import.meta.url === pathToFileURL(resolve(process.argv[1])).href || import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href);
if (isEntry) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`agentleak: ${(err as Error).message}\n`);
      process.exitCode = 2;
    });
}
