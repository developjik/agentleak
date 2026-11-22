#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
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
  --respect-robots       Skip agents whose robots.txt group disallows /
  --fail-on-leak         Exit 1 when a medium or high finding exists
  --fail-on <level>      leak | high | never (default: never)
  --max-findings <n>     Findings shown in the terminal summary (default: 8)
  --no-color             Disable ANSI colour
  --quiet                Only write files and set the exit code

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
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
        out: { type: 'string' },
        format: { type: 'string' },
        ua: { type: 'string' },
        timeout: { type: 'string' },
        settle: { type: 'string' },
        viewport: { type: 'string' },
        'respect-robots': { type: 'boolean' },
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
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
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
