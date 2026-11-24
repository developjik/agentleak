import type { Finding, Snapshot } from '../types.js';
import { rawOnlyBlocks } from '../html/text.js';
import { isoLocal, num, painter, percentage, severityBadge, truncate } from './util.js';

export interface TerminalOptions {
  color: boolean;
  maxFindings?: number;
  reportPaths?: { json?: string; markdown?: string };
}

const RULE = '─'.repeat(64);

function channelLabel(f: Finding): string {
  switch (f.channel) {
    case 'hidden-dom':
      return 'hidden in DOM';
    case 'comment':
      return 'HTML comment';
    case 'attribute':
      return 'attribute';
    case 'script-metadata':
      return 'JSON-LD / metadata';
    case 'raw-html-only':
      return 'raw HTML only';
    case 'ua-response':
      return 'bot-only response';
    case 'unicode':
      return 'invisible Unicode';
    default:
      return f.channel;
  }
}

export function renderTerminal(snapshot: Snapshot, opts: TerminalOptions): string {
  const p = painter(opts.color);
  const lines: string[] = [];
  const baseline = snapshot.observations.find((o) => o.uaId === snapshot.baselineUa) ?? snapshot.observations[0];
  const maxFindings = opts.maxFindings ?? 8;

  lines.push('');
  lines.push(`${p.bold('agentleak')} ${snapshot.version}  ${p.gray('·')}  ${p.cyan('scan')}  ${snapshot.url}`);
  lines.push(
    p.gray(
      `${isoLocal(new Date(snapshot.createdAt))}  ·  ${snapshot.observations.length} user agents  ·  ${num(
        snapshot.observations.reduce((n, o) => n + o.durationMs, 0),
      )} ms total`,
    ),
  );
  lines.push('');

  const s = snapshot.summary;
  lines.push(p.bold('Verdict'));
  if (s.leak) {
    lines.push(
      `  ${p.red(p.bold('LEAKS FOUND'))} ${p.gray('—')} ${num(s.leakCount)} machine-directed signal(s) a human visitor never sees`,
    );
  } else {
    lines.push(`  ${p.green(p.bold('CLEAN'))} ${p.gray('—')} no hidden or cloaked instructions at medium severity or above`);
  }
  lines.push(
    p.gray(`  ${s.findingsBySeverity.high} high · ${s.findingsBySeverity.medium} medium · ${s.findingsBySeverity.low} low`),
  );
  lines.push('');

  lines.push(p.bold('Three views compared'));
  const rawOnly = baseline ? rawOnlyBlocks(baseline) : [];
  const hiddenReasons = new Set<string>();
  for (const b of baseline?.hiddenBlocks ?? []) for (const r of b.reasons) hiddenReasons.add(r);
  lines.push(
    `  ${p.bold('Rendered (human)')}   ${num(s.visibleChars)} visible chars`,
  );
  lines.push(
    `  ${p.bold('Hidden in DOM')}      ${num(s.hiddenChars)} chars in ${num(s.hiddenBlocks)} block(s)` +
      (hiddenReasons.size ? p.gray(`  [${[...hiddenReasons].slice(0, 6).join(', ')}]`) : ''),
  );
  lines.push(
    `  ${p.bold('HTML comments')}      ${num(s.comments)} comment(s) · ${num(s.attributeBlocks)} attribute(s) · ${num(baseline?.metadata.length ?? 0)} metadata block(s)`,
  );
  lines.push(
    `  ${p.bold('Raw HTML (no JS)')}   ${num(baseline?.byteLength ?? 0)} bytes · ${num(baseline?.rawTextBlocks.length ?? 0)} text block(s) · ${num(rawOnly.length)} block(s) only the crawler gets`,
  );
  if (snapshot.robots.found) {
    lines.push(
      p.gray(
        `  robots.txt: ${snapshot.robots.disallowedAgents.length ? `disallows ${snapshot.robots.disallowedAgents.join(', ')}` : 'no AI-agent block'}`,
      ),
    );
  }
  lines.push('');

  if (snapshot.findings.length > 0) {
    lines.push(p.bold('Findings'));
    for (const f of snapshot.findings.slice(0, maxFindings)) {
      const where = [channelLabel(f), f.reasons.slice(0, 3).join(', ')].filter(Boolean).join(' · ');
      lines.push(`  ${severityBadge(f.severity, opts.color)} ${p.gray(where)}  ${p.gray(`score ${f.score}`)}`);
      lines.push(`    "${truncate(f.snippet, 150)}"`);
      if (f.matches.length) {
        lines.push(p.gray(`    ↳ ${[...new Set(f.matches.map((m) => m.label))].slice(0, 3).join('; ')}`));
      }
      const uas = f.uaIds.length > 1 ? `all ${f.uaIds.length} agents` : f.uaIds[0];
      lines.push(p.gray(`      seen on: ${uas}`));
    }
    if (snapshot.findings.length > maxFindings) {
      lines.push(p.gray(`  … and ${snapshot.findings.length - maxFindings} more in the JSON/Markdown report`));
    }
  } else {
    lines.push(p.bold('Findings'));
    lines.push(p.gray('  none — no hidden text, comments, attributes or bot-only blocks carry instructions'));
  }
  lines.push('');

  if (snapshot.cloaking.pairs.length) {
    lines.push(p.bold('User-agent cloaking'));
    for (const pair of snapshot.cloaking.pairs) {
      const mark =
        pair.verdict === 'cloaked'
          ? p.red('CLOAKED')
          : pair.verdict === 'blocked'
            ? p.yellow('BLOCKED')
            : pair.verdict === 'error'
              ? p.gray('ERROR')
              : pair.verdict === 'minor-delta'
                ? p.yellow('minor delta')
                : p.green('identical');
      lines.push(
        `  ${pair.label.padEnd(26)} status ${String(pair.status ?? '-').padEnd(4)} similar ${(pair.rawComparable === false ? "n/a" : percentage(pair.similarity)).padStart(4)}  ${pair.botOnly.length ? p.yellow(`+${pair.botOnly.length} bot-only`) : p.gray('+0 bot-only')}  ${mark}`,
      );
    }
    for (const pair of snapshot.cloaking.pairs.filter((x) => x.botOnly.length > 0).slice(0, 3)) {
      for (const block of pair.botOnly.slice(0, 2)) {
        lines.push(p.gray(`    ↳ ${pair.uaId}: "${truncate(block, 120)}"`));
      }
    }
    lines.push('');
  }

  if (opts.reportPaths && (opts.reportPaths.json || opts.reportPaths.markdown)) {
    lines.push(p.gray(RULE));
    if (opts.reportPaths.json) lines.push(`  JSON     ${opts.reportPaths.json}`);
    if (opts.reportPaths.markdown) lines.push(`  Markdown ${opts.reportPaths.markdown}`);
    lines.push('');
  }

  return lines.join('\n');
}
