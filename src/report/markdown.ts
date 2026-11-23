import type { Finding, Snapshot, UaObservation } from '../types.js';
import { rawOnlyBlocks } from '../html/text.js';
import { isoLocal, num, percentage, truncate } from './util.js';

function cell(text: string, max = 120): string {
  return truncate(text, max).replace(/\|/g, '\\|');
}

function code(text: string): string {
  return '`' + truncate(text, 200).replace(/`/g, "'") + '`';
}

function uaStatus(obs: UaObservation): string {
  if (obs.error) return `_${cell(obs.error, 60)}_`;
  return obs.status === null ? '—' : String(obs.status);
}

function findingBlock(f: Finding): string[] {
  const out: string[] = [];
  out.push(`### [${f.severity.toUpperCase()}] ${f.kind} · score ${f.score}`);
  out.push('');
  out.push(`> ${f.text.replace(/\n+/g, ' ').slice(0, 400)}`);
  out.push('');
  out.push(`- **Channel:** ${f.channel}${f.selector ? ` (${code(f.selector)})` : ''}`);
  out.push(`- **Why it is hidden:** ${f.reasons.join(', ') || 'n/a'}`);
  out.push(`- **Seen on:** ${f.uaIds.join(', ')}`);
  if (f.matches.length) {
    out.push(`- **Matched signals:** ${f.matches.map((m) => `${m.label} (+${m.weight})`).join('; ')}`);
  }
  out.push('');
  return out;
}

export function renderMarkdown(snapshot: Snapshot): string {
  const lines: string[] = [];
  const baseline = snapshot.observations.find((o) => o.uaId === snapshot.baselineUa) ?? snapshot.observations[0];
  const s = snapshot.summary;

  lines.push(`# agentleak report — ${snapshot.url}`);
  lines.push('');
  lines.push(
    `Generated ${isoLocal(new Date(snapshot.createdAt))} · agentleak ${snapshot.version} · schema \`${snapshot.schema}\``,
  );
  lines.push('');
  lines.push('## Verdict');
  lines.push('');
  if (s.leak) {
    lines.push(
      `**LEAKS FOUND** — ${s.leakCount} machine-directed signal(s) that a human visitor cannot see ` +
        `(${s.findingsBySeverity.high} high, ${s.findingsBySeverity.medium} medium, ${s.findingsBySeverity.low} low).`,
    );
  } else {
    lines.push('**CLEAN** — no hidden or cloaked instructions at medium severity or above.');
  }
  lines.push('');
  lines.push(
    `- Hidden text blocks in the DOM: **${s.hiddenBlocks}** (${num(s.hiddenChars)} chars)`,
  );
  lines.push(`- HTML comments / attributes / metadata: **${s.comments}** / **${s.attributeBlocks}** / **${baseline?.metadata.length ?? 0}**`);
  lines.push(
    `- User agents compared: **${s.userAgents}**, cloaked: **${s.cloakedPairs}**, blocked: **${s.blockedBots}**`,
  );
  lines.push(`- Unicode smuggling hits: **${s.unicodeHits}**`);
  if (snapshot.robots.found) {
    lines.push(
      `- robots.txt: ${
        snapshot.robots.disallowedAgents.length
          ? `disallows **${snapshot.robots.disallowedAgents.join(', ')}**`
          : 'no AI-agent block'
      }`,
    );
  } else {
    lines.push('- robots.txt: not found');
  }
  lines.push('');

  lines.push('## 1. Three views of the same page');
  lines.push('');
  lines.push('| View | What the reader receives | Text | Blocks |');
  lines.push('| --- | --- | ---: | ---: |');
  lines.push(
    `| Rendered, human-visible | What a person actually sees after JavaScript and CSS | ${num(s.visibleChars)} chars | — |`,
  );
  lines.push(
    `| Hidden in the DOM | Text present in the document but not drawn on screen | ${num(s.hiddenChars)} chars | ${s.hiddenBlocks} |`,
  );
  lines.push(
    `| Raw HTML (no JavaScript) | What a request-only crawler gets | ${num(baseline?.byteLength ?? 0)} bytes | ${baseline?.rawTextBlocks.length ?? 0} |`,
  );
  lines.push('');

  const hiddenReasons = new Map<string, number>();
  for (const b of baseline?.hiddenBlocks ?? []) {
    for (const r of b.reasons) hiddenReasons.set(r, (hiddenReasons.get(r) ?? 0) + 1);
  }
  if (hiddenReasons.size) {
    lines.push('Visibility tricks detected on this page:');
    lines.push('');
    for (const [reason, count] of [...hiddenReasons.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`- \`${reason}\` — ${count} block(s)`);
    }
    lines.push('');
  }

  const rawOnly = baseline ? rawOnlyBlocks(baseline) : [];
  if (rawOnly.length) {
    lines.push('Text that only the raw-HTML crawler receives (removed or replaced by JavaScript):');
    lines.push('');
    for (const block of rawOnly.slice(0, 5)) lines.push(`- ${cell(block, 200)}`);
    lines.push('');
  }

  lines.push('## 2. Per-agent response');
  lines.push('');
  lines.push('| Agent | UA kind | HTTP | Visible chars | Hidden blocks | Comments | Similar to human | Verdict |');
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |');
  for (const obs of snapshot.observations) {
    const pair = snapshot.cloaking.pairs.find((p) => p.uaId === obs.uaId);
    lines.push(
      `| ${obs.label} | ${obs.kind} | ${uaStatus(obs)} | ${num(obs.visibleChars)} | ${obs.hiddenBlocks.length} | ${obs.comments.length} | ${
        pair ? percentage(pair.similarity) : 'baseline'
      } | ${pair ? pair.verdict : 'baseline'} |`,
    );
  }
  lines.push('');

  lines.push('## 3. Machine-directed instructions');
  lines.push('');
  const instructions = snapshot.findings.filter((f) => f.severity !== 'low');
  if (!instructions.length) {
    lines.push('_None found._');
    lines.push('');
  } else {
    for (const f of instructions) lines.push(...findingBlock(f));
  }

  lines.push('## 4. Everything hidden from humans');
  lines.push('');
  const hiddenFindings = snapshot.findings.filter((f) => f.channel === 'hidden-dom');
  if (!hiddenFindings.length) {
    lines.push('_No hidden text nodes were found._');
  } else {
    lines.push('| # | Severity | Score | Why hidden | Text | Seen on |');
    lines.push('| ---: | --- | ---: | --- | --- | --- |');
    hiddenFindings.slice(0, 50).forEach((f, i) => {
      lines.push(
        `| ${i + 1} | ${f.severity} | ${f.score} | ${cell(f.reasons.join(', '), 50)} | ${cell(f.text, 110)} | ${f.uaIds.length === snapshot.observations.length ? 'all agents' : f.uaIds.join(', ')} |`,
      );
    });
    if (hiddenFindings.length > 50) lines.push(`| … | | | | ${hiddenFindings.length - 50} more in the JSON snapshot | |`);
  }
  lines.push('');

  if (snapshot.cloaking.pairs.length) {
    lines.push('## 5. User-agent cloaking');
    lines.push('');
    lines.push('| Agent | HTTP | Byte delta | Text similarity | Bot-only blocks | Human-only blocks | Verdict |');
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: | --- |');
    for (const pair of snapshot.cloaking.pairs) {
      lines.push(
        `| ${pair.label} | ${pair.status ?? '—'} | ${pair.byteDelta >= 0 ? '+' : ''}${num(pair.byteDelta)} | ${percentage(
          pair.similarity,
        )} | ${pair.botOnly.length} | ${pair.browserOnly.length} | ${pair.verdict} |`,
      );
    }
    lines.push('');
    const withDeltas = snapshot.cloaking.pairs.filter((p) => p.botOnly.length > 0);
    for (const pair of withDeltas) {
      lines.push(`**${pair.label}** receives text the human browser does not (${pair.botOnly.length} block(s)):`);
      lines.push('');
      for (const block of pair.botOnly.slice(0, 5)) lines.push(`- ${cell(block, 240)}`);
      lines.push('');
    }
    const blocked = snapshot.cloaking.pairs.filter((p) => p.verdict === 'blocked');
    if (blocked.length) {
      lines.push(
        `${blocked.map((p) => p.label).join(', ')} ${blocked.length === 1 ? 'was' : 'were'} explicitly denied (HTTP 4xx). ` +
          'That is exclusion, not cloaking: the agent is told to go away rather than shown different content.',
      );
      lines.push('');
    }
  }

  if (s.unicodeHits > 0) {
    lines.push('## 6. Invisible Unicode');
    lines.push('');
    for (const f of snapshot.findings.filter((x) => x.kind === 'unicode-smuggling')) {
      lines.push(`- **${f.severity}** ${f.text}${f.reasons.length ? ` (${f.reasons.join(', ')})` : ''}`);
    }
    lines.push('');
  }

  lines.push('## Reproduce');
  lines.push('');
  lines.push('```bash');
  lines.push(`node dist/cli.js scan ${snapshot.url} --fail-on-leak`);
  lines.push('# or from npm (keep the scope — unscoped `agentleak` is another package):');
  lines.push('npx playwright install chromium   # once, if no Chromium is installed yet');
  lines.push(`npx -y @developjik/agentleak scan ${snapshot.url} --fail-on-leak`);
  lines.push('```');
  lines.push('');
  lines.push('Snapshot diffs (track what changed between two scans):');
  lines.push('');
  lines.push('```bash');
  lines.push('node dist/cli.js diff before.json after.json --fail-on new-instructions');
  lines.push('```');
  lines.push('');
  lines.push('## Method and limits');
  lines.push('');
  lines.push(
    '- Visibility is decided from `getComputedStyle` plus geometry: display, visibility, opacity, zero font size, clipped and offscreen boxes, `aria-hidden`, transparent or background-coloured text, HTML comments, attributes, JSON-LD, `<noscript>` and `<template>` content.',
  );
  lines.push(
    '- The human view is the text of nodes whose computed style leaves them visible after JavaScript runs; the raw view is the same URL fetched without executing JavaScript.',
  );
  lines.push(
    '- User-agent comparison changes only the `User-Agent` request header. It does not fingerprint, log in, or bypass bot protection.',
  );
  lines.push(
    '- Scores are heuristics over instruction-shaped phrases; a score is a reason to read the block, not proof of intent. Absence of findings is not proof of absence.',
  );
  lines.push('');
  lines.push('## Ethics');
  lines.push('');
  lines.push(
    'Scan sites you own or have permission to scan. This tool loads each page once per user agent, follows `--respect-robots` when asked, and is read-only: it never submits forms or changes content. Public disclosure of another site\'s findings is a legal and editorial decision, not a feature of the tool.',
  );
  lines.push('');
  return lines.join('\n');
}
