import { readFileSync } from 'node:fs';
import type { DiffResult, Finding, Snapshot } from './types.js';
import { normalizeText } from './html/text.js';
import { isoLocal, painter, severityBadge, truncate } from './report/util.js';

export function loadSnapshot(path: string): Snapshot {
  const raw = readFileSync(path, 'utf8');
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`);
  }
  const snap = data as Snapshot;
  if (!snap || snap.schema !== 'agentleak.snapshot/v1' || !Array.isArray(snap.findings)) {
    throw new Error(`${path} is not an agentleak snapshot (expected schema agentleak.snapshot/v1)`);
  }
  return snap;
}

function textKey(f: Finding): string {
  return normalizeText(f.text).slice(0, 400);
}

function changesBetween(before: Finding, after: Finding): string[] {
  const changes: string[] = [];
  if (before.channel !== after.channel) changes.push(`channel: ${before.channel} → ${after.channel}`);
  if (before.severity !== after.severity) changes.push(`severity: ${before.severity} → ${after.severity}`);
  if (before.score !== after.score) changes.push(`score: ${before.score} → ${after.score}`);
  const beforeReasons = before.reasons.join(', ');
  const afterReasons = after.reasons.join(', ');
  if (beforeReasons !== afterReasons) changes.push('visibility reasons changed');
  const beforeUas = [...before.uaIds].sort().join(',');
  const afterUas = [...after.uaIds].sort().join(',');
  if (beforeUas !== afterUas) changes.push('agent coverage changed');
  return changes;
}

function findingKeySet(findings: Finding[]): Map<string, Finding> {
  const map = new Map<string, Finding>();
  for (const f of findings) {
    const key = textKey(f);
    if (!map.has(key)) map.set(key, f);
  }
  return map;
}

export function diffSnapshots(before: Snapshot, after: Snapshot): DiffResult {
  const beforeMap = findingKeySet(before.findings);
  const afterMap = findingKeySet(after.findings);

  const added: Finding[] = [];
  const removed: Finding[] = [];
  const changed: DiffResult['changed'] = [];
  const persistent: Finding[] = [];

  for (const [key, f] of afterMap) {
    const old = beforeMap.get(key);
    if (!old) {
      added.push(f);
      continue;
    }
    const changes = changesBetween(old, f);
    if (changes.length) changed.push({ before: old, after: f, changes });
    else persistent.push(f);
  }
  for (const [key, f] of beforeMap) {
    if (!afterMap.has(key)) removed.push(f);
  }

  const rank = { high: 0, medium: 1, low: 2 } as const;
  added.sort((a, b) => rank[a.severity] - rank[b.severity] || b.score - a.score);
  removed.sort((a, b) => rank[a.severity] - rank[b.severity] || b.score - a.score);

  const newInstructions = added.filter((f) => f.score >= 4);
  let verdict: DiffResult['verdict'] = 'unchanged';
  if (newInstructions.length) verdict = 'new-instructions';
  else if (added.length || changed.length || removed.length) {
    verdict = removed.length > added.length ? 'less-instructions' : 'changed';
  }

  return {
    before: { url: before.url, createdAt: before.createdAt, findings: before.findings.length },
    after: { url: after.url, createdAt: after.createdAt, findings: after.findings.length },
    added,
    removed,
    changed,
    persistent,
    newInstructions,
    verdict,
  };
}

export function renderDiffTerminal(result: DiffResult, color: boolean): string {
  const p = painter(color);
  const lines: string[] = [];
  lines.push('');
  lines.push(`${p.bold('agentleak')} ${p.cyan('diff')}`);
  lines.push(p.gray(`  before  ${result.before.url}  ${isoLocal(new Date(result.before.createdAt))}  (${result.before.findings} findings)`));
  lines.push(p.gray(`  after   ${result.after.url}  ${isoLocal(new Date(result.after.createdAt))}  (${result.after.findings} findings)`));
  lines.push('');

  if (result.added.length) {
    lines.push(p.bold(`New blocks (${result.added.length})`));
    for (const f of result.added) {
      lines.push(`  ${p.green('+')} ${severityBadge(f.severity, color)} ${p.gray(`${f.channel} · score ${f.score}`)}`);
      lines.push(`      "${truncate(f.text, 150)}"`);
    }
    lines.push('');
  }
  if (result.removed.length) {
    lines.push(p.bold(`Removed blocks (${result.removed.length})`));
    for (const f of result.removed) {
      lines.push(`  ${p.red('-')} ${severityBadge(f.severity, color)} ${p.gray(`${f.channel} · score ${f.score}`)}`);
      lines.push(`      "${truncate(f.text, 150)}"`);
    }
    lines.push('');
  }
  if (result.changed.length) {
    lines.push(p.bold(`Changed blocks (${result.changed.length})`));
    for (const c of result.changed) {
      lines.push(`  ${p.yellow('~')} "${truncate(c.after.text, 110)}"`);
      lines.push(p.gray(`      ${c.changes.join('; ')}`));
    }
    lines.push('');
  }
  if (!result.added.length && !result.removed.length && !result.changed.length) {
    lines.push(p.gray('No changes in hidden, comment, attribute, Unicode or cloaking findings.'));
    lines.push('');
  }

  if (result.verdict === 'new-instructions') {
    lines.push(
      `${p.red(p.bold('NEW INSTRUCTIONS'))} ${p.gray('—')} ${result.newInstructions.length} new machine-directed block(s) since the previous snapshot`,
    );
  } else if (result.verdict === 'less-instructions') {
    lines.push(`${p.green(p.bold('FEWER BLOCKS'))} ${p.gray('—')} ${result.removed.length} block(s) disappeared`);
  } else if (result.verdict === 'changed') {
    lines.push(`${p.yellow(p.bold('CHANGED'))} ${p.gray('—')} no new instructions, but the page changed`);
  } else {
    lines.push(`${p.green(p.bold('UNCHANGED'))} ${p.gray('—')} identical findings`);
  }
  lines.push('');
  return lines.join('\n');
}

export function renderDiffMarkdown(result: DiffResult): string {
  const lines: string[] = [];
  lines.push(`# agentleak diff`);
  lines.push('');
  lines.push(`| | URL | Snapshot time | Findings |`);
  lines.push('| --- | --- | --- | ---: |');
  lines.push(`| Before | ${result.before.url} | ${isoLocal(new Date(result.before.createdAt))} | ${result.before.findings} |`);
  lines.push(`| After | ${result.after.url} | ${isoLocal(new Date(result.after.createdAt))} | ${result.after.findings} |`);
  lines.push('');
  lines.push(`**Verdict: ${result.verdict}** — ${result.newInstructions.length} new instruction block(s).`);
  lines.push('');
  if (result.added.length) {
    lines.push('## New');
    lines.push('');
    lines.push('| Severity | Channel | Score | Text |');
    lines.push('| --- | --- | ---: | --- |');
    for (const f of result.added) {
      lines.push(`| ${f.severity} | ${f.channel} | ${f.score} | ${truncate(f.text, 160).replace(/\|/g, '\\|')} |`);
    }
    lines.push('');
  }
  if (result.removed.length) {
    lines.push('## Removed');
    lines.push('');
    lines.push('| Severity | Channel | Score | Text |');
    lines.push('| --- | --- | ---: | --- |');
    for (const f of result.removed) {
      lines.push(`| ${f.severity} | ${f.channel} | ${f.score} | ${truncate(f.text, 160).replace(/\|/g, '\\|')} |`);
    }
    lines.push('');
  }
  if (result.changed.length) {
    lines.push('## Changed');
    lines.push('');
    for (const c of result.changed) {
      lines.push(`- "${truncate(c.after.text, 160)}" — ${c.changes.join('; ')}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
