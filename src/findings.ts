import { createHash } from 'node:crypto';
import type {
  Channel,
  CloakingReport,
  Finding,
  Severity,
  Snapshot,
  UaObservation,
} from './types.js';
import { isInstructionScore, scoreText, severityForScore } from './score/patterns.js';
import { normalizeText } from './html/text.js';
import type { InvisibleCharHit } from './score/unicode.js';

export interface UnicodeRecord {
  uaId: string;
  source: 'html' | 'hidden' | 'visible';
  hit: InvisibleCharHit;
}

const MAX_EVIDENCE = 600;

function findingId(kind: string, text: string): string {
  return `f_${createHash('sha1').update(`${kind}|${normalizeText(text).slice(0, 400)}`).digest('hex').slice(0, 12)}`;
}

function snippet(text: string, max = 180): string {
  const clean = normalizeText(text);
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function kindForChannel(channel: Channel): Finding['kind'] {
  switch (channel) {
    case 'hidden-dom':
      return 'hidden-ai-instruction';
    case 'comment':
      return 'comment-instruction';
    case 'attribute':
      return 'attribute-instruction';
    case 'script-metadata':
      return 'metadata-instruction';
    case 'raw-html-only':
      return 'raw-html-only';
    case 'ua-response':
      return 'ua-response';
    default:
      return 'hidden-text';
  }
}

interface Pending {
  finding: Finding;
  uaIds: Set<string>;
}

export function buildFindings(
  observations: UaObservation[],
  cloaking: CloakingReport,
  unicode: UnicodeRecord[],
): Finding[] {
  const pending = new Map<string, Pending>();

  const add = (
    kind: Finding['kind'],
    text: string,
    channel: Channel,
    severity: Severity,
    score: number,
    uaId: string,
    reasons: string[],
    selector?: string,
  ): void => {
    const clean = normalizeText(text);
    if (!clean) return;
    const id = findingId(kind, clean);
    const existing = pending.get(id);
    if (existing) {
      existing.uaIds.add(uaId);
      for (const r of reasons) if (!existing.finding.reasons.includes(r)) existing.finding.reasons.push(r);
      return;
    }
    const scored = scoreText(clean);
    pending.set(id, {
      finding: {
        id,
        kind,
        channel,
        severity,
        score,
        text: clean.slice(0, MAX_EVIDENCE),
        snippet: snippet(clean),
        uaId,
        uaIds: [uaId],
        reasons: [...new Set(reasons)],
        selector,
        matches: scored.matches,
      },
      uaIds: new Set([uaId]),
    });
  };

  for (const obs of observations) {
    if (obs.error) continue;

    for (const block of obs.hiddenBlocks) {
      const scored = scoreText(block.text);
      const instruction = isInstructionScore(scored.score);
      add(
        instruction ? 'hidden-ai-instruction' : 'hidden-text',
        block.text,
        'hidden-dom',
        instruction ? severityForScore(scored.score) : 'low',
        scored.score,
        obs.uaId,
        block.reasons,
        block.selector,
      );
    }

    for (const block of obs.comments) {
      const scored = scoreText(block.text);
      const instruction = isInstructionScore(scored.score);
      add(
        instruction ? 'comment-instruction' : 'hidden-text',
        block.text,
        'comment',
        instruction ? severityForScore(scored.score) : 'low',
        scored.score,
        obs.uaId,
        ['html-comment'],
        block.selector,
      );
    }

    for (const block of obs.attributes) {
      const scored = scoreText(block.text);
      const instruction = isInstructionScore(scored.score);
      add(
        instruction ? 'attribute-instruction' : 'hidden-text',
        block.text,
        'attribute',
        instruction ? severityForScore(scored.score) : 'low',
        scored.score,
        obs.uaId,
        block.reasons,
        block.selector,
      );
    }

    for (const block of obs.metadata) {
      const scored = scoreText(block.text);
      if (!isInstructionScore(scored.score)) continue;
      add(
        'metadata-instruction',
        block.text,
        'script-metadata',
        severityForScore(scored.score),
        scored.score,
        obs.uaId,
        block.reasons,
        block.selector,
      );
    }
  }

  const knownTexts = new Set([...pending.values()].map((p) => normalizeText(p.finding.text)));

  for (const pair of cloaking.pairs) {
    if (pair.verdict !== 'cloaked' || pair.botOnly.length === 0) continue;
    let maxScore = 0;
    for (const block of pair.botOnly) {
      const scored = scoreText(block);
      maxScore = Math.max(maxScore, scored.score);
      if (knownTexts.has(normalizeText(block))) continue;
      if (isInstructionScore(scored.score)) {
        add(
          'ua-response',
          block,
          'ua-response',
          severityForScore(scored.score),
          scored.score,
          pair.uaId,
          ['ua-cloaking', `only in ${pair.label} response`],
        );
      }
    }
    const severity: Severity = maxScore >= 4 || pair.botOnly.length >= 3 ? 'high' : 'medium';
    add(
      'ua-response',
      `UA cloaking: ${pair.label} received ${pair.botOnly.length} text block(s) absent from the human-browser response`,
      'ua-response',
      severity,
      Math.max(maxScore, 3),
      pair.uaId,
      ['ua-cloaking', `similarity ${pair.similarity}`],
    );
  }

  for (const record of unicode) {
    const decoded = record.hit.decoded?.trim();
    const text =
      record.hit.kind === 'tag-chars' && decoded
        ? `Unicode tag characters encode: "${decoded}"`
        : record.hit.kind === 'tag-chars'
          ? 'Unicode tag characters (invisible ASCII channel)'
          : `${record.hit.count} ${record.hit.kind.replace(/-/g, ' ')} in ${record.source} text`;
    add(
      'unicode-smuggling',
      text,
      'unicode',
      record.hit.kind === 'tag-chars' ? 'high' : 'medium',
      record.hit.kind === 'tag-chars' ? 10 : 6,
      record.uaId,
      [record.hit.kind, record.source],
    );
  }

  const severityRank: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  return [...pending.values()]
    .map((p) => ({ ...p.finding, uaIds: [...p.uaIds] }))
    .sort(
      (a, b) =>
        severityRank[a.severity] - severityRank[b.severity] ||
        b.score - a.score ||
        a.snippet.localeCompare(b.snippet),
    );
}

export function summarize(snapshot: Omit<Snapshot, 'summary'>): Snapshot['summary'] {
  const baseline = snapshot.observations.find((o) => o.uaId === snapshot.baselineUa) ?? snapshot.observations[0];
  const findingsBySeverity: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
  for (const f of snapshot.findings) findingsBySeverity[f.severity] += 1;
  const leakCount = findingsBySeverity.high + findingsBySeverity.medium;
  const uniqueHidden = new Map<string, number>();
  for (const obs of snapshot.observations) {
    for (const block of obs.hiddenBlocks) uniqueHidden.set(normalizeText(block.text), block.text.length);
  }
  return {
    pages: 1,
    userAgents: snapshot.observations.length,
    visibleChars: baseline?.visibleChars ?? 0,
    hiddenBlocks: snapshot.findings.filter((f) => f.channel === 'hidden-dom').length,
    hiddenChars: [...uniqueHidden.values()].reduce((n, v) => n + v, 0),
    comments: baseline?.comments.length ?? 0,
    attributeBlocks: baseline?.attributes.length ?? 0,
    cloakedPairs: snapshot.cloaking.pairs.filter((p) => p.verdict === 'cloaked').length,
    blockedBots: snapshot.cloaking.blockedBots.length,
    unicodeHits: snapshot.findings.filter((f) => f.kind === 'unicode-smuggling').length,
    findingsBySeverity,
    leak: leakCount > 0,
    leakCount,
  };
}
