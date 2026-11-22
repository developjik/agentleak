import { createHash } from 'node:crypto';

const CODES = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
  gray: '\u001b[90m',
  magenta: '\u001b[35m',
} as const;

export function painter(enabled: boolean) {
  const wrap = (code: string, text: string) => (enabled ? `${code}${text}${CODES.reset}` : text);
  return {
    bold: (t: string) => wrap(CODES.bold, t),
    dim: (t: string) => wrap(CODES.dim, t),
    red: (t: string) => wrap(CODES.red, t),
    green: (t: string) => wrap(CODES.green, t),
    yellow: (t: string) => wrap(CODES.yellow, t),
    cyan: (t: string) => wrap(CODES.cyan, t),
    gray: (t: string) => wrap(CODES.gray, t),
    magenta: (t: string) => wrap(CODES.magenta, t),
  };
}

export function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function num(n: number): string {
  return n.toLocaleString('en-US');
}

export function slugForUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.host.replace(/[^a-z0-9.-]/gi, '-');
    const hash = createHash('sha1').update(url).digest('hex').slice(0, 6);
    return `${host}-${hash}`;
  } catch {
    return 'scan';
  }
}

export function stamp(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

export function isoLocal(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

export function severityBadge(severity: 'high' | 'medium' | 'low', color: boolean): string {
  const p = painter(color);
  if (severity === 'high') return p.red(p.bold('[HIGH]'));
  if (severity === 'medium') return p.yellow('[MED]');
  return p.gray('[LOW]');
}

export function percentage(n: number): string {
  return `${Math.round(n * 100)}%`;
}
