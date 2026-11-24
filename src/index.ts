export { scanUrl } from './scan.js';
export type { ScanResult } from './scan.js';
export { diffSnapshots, loadSnapshot, renderDiffMarkdown, renderDiffTerminal } from './diff.js';
export { renderMarkdown } from './report/markdown.js';
export { renderTerminal } from './report/terminal.js';
export { scoreText, severityForScore, isInstructionScore, PATTERN_RULES } from './score/patterns.js';
export { findInvisibleChars, stripInvisible } from './score/unicode.js';
export { compareUserAgents } from './cloaking.js';
export { extractRawText, blocksMissingFrom, tokenSimilarity, normalizeText } from './html/text.js';
export { startFixtureServer } from './fixtures/serve.js';
export { BROWSER_UA, DEFAULT_USER_AGENTS, ALL_USER_AGENTS, resolveUserAgents } from './ua.js';
export { PRODUCT, VERSION } from './version.js';
export type {
  ScanOptions,
  Snapshot,
  Finding,
  DiffResult,
  Channel,
  Severity,
  UaObservation,
  UaSpec,
  CloakingReport,
  CloakingPair,
} from './types.js';

export * from './crawl.js';
