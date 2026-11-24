import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const exec = promisify(execFile);
for (const scenario of ['wildcard', 'exception', 'disabled', 'path'] as const) {
  test(`built CLI robots policy: ${scenario}`, async () => {
    const requests: string[] = [];
    const policy = scenario === 'exception'
      ? 'User-agent: *\nDisallow: /\nUser-agent: GPTBot\nAllow: /'
      : scenario === 'path' ? 'User-agent: *\nDisallow: /private' : 'User-agent: *\nDisallow: /';
    const server = createServer((req, res) => {
      if (req.url === '/robots.txt') {
        res.writeHead(200, { 'content-type': 'text/plain' }); res.end(policy); return;
      }
      if (req.url?.startsWith('/private')) requests.push(req.headers['user-agent'] ?? '');
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>Robots fixture</title><main>Same safe fixture content for every visitor.</main>');
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No fixture port');
    const out = await mkdtemp(join(tmpdir(), 'agentleak-robots-'));
    try {
      const args = [resolve('dist/cli.js'), 'scan', `http://127.0.0.1:${address.port}/private/page`, '--ua', 'browser,gptbot,claudebot', '--out', out, '--format', 'json', '--settle', '0'];
      if (scenario !== 'disabled') args.push('--respect-robots');
      const result = await exec(process.execPath, args, { timeout: 90_000, env: { ...process.env, NO_COLOR: '1' } });
      const files = (await readdir(out)).filter((f) => f.endsWith('.json'));
      expect(files).toHaveLength(1);
      const snapshot = JSON.parse(await readFile(join(out, files[0]!), 'utf8'));
      const gpt = snapshot.observations.find((o: {uaId: string}) => o.uaId === 'gptbot');
      const claude = snapshot.observations.find((o: {uaId: string}) => o.uaId === 'claudebot');
      const gptRequests = requests.filter((ua) => /GPTBot/i.test(ua)).length;
      const claudeRequests = requests.filter((ua) => /ClaudeBot/i.test(ua)).length;
      if (scenario === 'disabled') {
        expect(gptRequests).toBeGreaterThan(0); expect(claudeRequests).toBeGreaterThan(0);
        expect(gpt.error).toBeUndefined(); expect(claude.error).toBeUndefined();
      } else {
        expect(claudeRequests).toBe(0); expect(claude.error).toContain('skipped: robots.txt');
        expect(result.stderr).toContain('skipped because robots.txt');
        if (scenario === 'exception') {
          expect(gptRequests).toBeGreaterThan(0); expect(gpt.error).toBeUndefined();
        } else { expect(gptRequests).toBe(0); expect(gpt.error).toContain('skipped: robots.txt'); }
      }
      expect(snapshot.observations[0].status).toBe(200);
    } finally {
      await new Promise<void>((done, reject) => server.close((err) => err ? reject(err) : done()));
      await rm(out, { recursive: true, force: true });
    }
  });
}
