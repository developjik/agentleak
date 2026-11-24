export type Severity = 'high' | 'medium' | 'low';

export type Channel =
  | 'hidden-dom'
  | 'comment'
  | 'attribute'
  | 'script-metadata'
  | 'raw-html-only'
  | 'ua-response'
  | 'unicode';

export interface PatternMatch {
  rule: string;
  label: string;
  category: string;
  weight: number;
  snippet: string;
}

export interface ScoreResult {
  score: number;
  matches: PatternMatch[];
}

export interface UaSpec {
  id: string;
  label: string;
  userAgent: string;
  kind: 'browser' | 'ai-crawler' | 'ai-user';
}

export interface DomRecord {
  text: string;
  channel: Channel;
  reasons: string[];
  selector: string;
  tag?: string;
}

export interface RawTextBlock {
  text: string;
  kind: 'body' | 'comment' | 'noscript' | 'title';
}

export interface UaObservation {
  uaId: string;
  label: string;
  userAgent: string;
  kind: UaSpec['kind'];
  status: number | null;
  finalUrl: string;
  title: string;
  blocked: boolean;
  error?: string;
  durationMs: number;
  byteLength: number;
  rawHtml: string;
  rawTextBlocks: RawTextBlock[];
  /** Raw parsing degraded, but the successful rendered observation is retained. */
  rawTextError?: string;
  visibleText: string;
  visibleChars: number;
  innerText: string;
  domText: string;
  hiddenBlocks: DomRecord[];
  comments: DomRecord[];
  attributes: DomRecord[];
  metadata: DomRecord[];
}

export interface CloakingPair {
  /** False when raw-source parsing failed on either side. */
  rawComparable?: boolean;
  uaId: string;
  label: string;
  status: number | null;
  statusChanged: boolean;
  identicalHtml: boolean;
  similarity: number;
  botOnly: string[];
  browserOnly: string[];
  byteDelta: number;
  renderedSimilarity: number;
  verdict: 'same' | 'minor-delta' | 'cloaked' | 'blocked' | 'error';
}

export interface CloakingReport {
  baselineUa: string;
  suspected: boolean;
  blockedBots: string[];
  pairs: CloakingPair[];
}

export interface Finding {
  id: string;
  /** SHA-256 of the full normalized text before display truncation. */
  contentHash?: string;
  kind:
    | 'hidden-ai-instruction'
    | 'hidden-text'
    | 'comment-instruction'
    | 'attribute-instruction'
    | 'metadata-instruction'
    | 'raw-html-only'
    | 'ua-response'
    | 'unicode-smuggling';
  channel: Channel;
  severity: Severity;
  score: number;
  text: string;
  snippet: string;
  uaId: string;
  uaIds: string[];
  reasons: string[];
  selector?: string;
  matches: PatternMatch[];
}

export interface RobotsInfo {
  found: boolean;
  blocksAll: boolean;
  disallowedAgents: string[];
  note?: string;
}

export interface ScanSummary {
  pages: number;
  userAgents: number;
  visibleChars: number;
  hiddenBlocks: number;
  hiddenChars: number;
  comments: number;
  attributeBlocks: number;
  cloakedPairs: number;
  blockedBots: number;
  unicodeHits: number;
  findingsBySeverity: Record<Severity, number>;
  leak: boolean;
  leakCount: number;
}

export interface Snapshot {
  schema: 'agentleak.snapshot/v1';
  product: string;
  version: string;
  createdAt: string;
  url: string;
  finalUrl: string;
  baselineUa: string;
  userAgents: UaSpec[];
  robots: RobotsInfo;
  observations: UaObservation[];
  cloaking: CloakingReport;
  findings: Finding[];
  summary: ScanSummary;
}

export interface ScanOptions {
  url: string;
  userAgents?: UaSpec[];
  timeoutMs?: number;
  settleMs?: number;
  viewport?: { width: number; height: number };
  maxTextChars?: number;
  respectRobots?: boolean;
  headless?: boolean;
  browserExecutablePath?: string;
}

export interface DiffResult {
  before: { url: string; createdAt: string; findings: number };
  after: { url: string; createdAt: string; findings: number };
  added: Finding[];
  removed: Finding[];
  changed: Array<{ before: Finding; after: Finding; changes: string[] }>;
  persistent: Finding[];
  newInstructions: Finding[];
  verdict: 'new-instructions' | 'less-instructions' | 'changed' | 'unchanged';
}
