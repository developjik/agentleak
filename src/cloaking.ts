import type { CloakingPair, CloakingReport, UaObservation } from './types.js';
import { blocksMissingFrom, tokenSimilarity } from './html/text.js';

function pairReport(baseline: UaObservation, other: UaObservation): CloakingPair {
  const baseText = baseline.rawTextBlocks.map((b) => b.text).join('\n');
  const otherText = other.rawTextBlocks.map((b) => b.text).join('\n');

  const baseStatus = baseline.status ?? 0;
  const otherStatus = other.status ?? 0;
  const statusChanged = otherStatus !== baseStatus;
  const blocked = otherStatus >= 400 && baseStatus < 400;

  const botOnly = blocksMissingFrom(other.rawTextBlocks, baseText).map((b) => b.text);
  const browserOnly = blocksMissingFrom(baseline.rawTextBlocks, otherText).map((b) => b.text);
  const identicalHtml = baseline.rawHtml.length > 0 && baseline.rawHtml === other.rawHtml;
  const similarity = tokenSimilarity(baseText, otherText);

  let verdict: CloakingPair['verdict'];
  if (other.error && !other.status) verdict = 'error';
  else if (blocked) verdict = 'blocked';
  else if (identicalHtml || (similarity >= 0.995 && botOnly.length === 0)) verdict = 'same';
  else if (similarity >= 0.9 && botOnly.length <= 1) verdict = 'minor-delta';
  else verdict = 'cloaked';

  return {
    uaId: other.uaId,
    label: other.label,
    status: other.status,
    statusChanged,
    identicalHtml,
    similarity: Math.round(similarity * 1000) / 1000,
    botOnly,
    browserOnly,
    byteDelta: other.byteLength - baseline.byteLength,
    verdict,
    renderedSimilarity:
      Math.round(tokenSimilarity(baseline.visibleText, other.visibleText) * 1000) / 1000,
  };
}

export function compareUserAgents(baseline: UaObservation, others: UaObservation[]): CloakingReport {
  const pairs = others.map((other) => pairReport(baseline, other));
  return {
    baselineUa: baseline.uaId,
    suspected: pairs.some((p) => p.verdict === 'cloaked' && p.botOnly.length > 0),
    blockedBots: pairs.filter((p) => p.verdict === 'blocked').map((p) => p.uaId),
    pairs,
  };
}
