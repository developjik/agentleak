import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fixtureResponse } from './pages.js';

export interface FixtureServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

/**
 * Serves the fixture pages on localhost. Used by `agentleak fixtures`, by the
 * Playwright config's webServer and by the end-to-end tests.
 */
export async function startFixtureServer(port = 4319): Promise<FixtureServer> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if(url.pathname==='/language-cloaking') {
      const korean=String(req.headers['accept-language']??'').startsWith('ko');
      res.writeHead(200,{'content-type':'text/html; charset=utf-8'});
      res.end(korean?'<html lang="ko"><title>Language</title><main>한국어 요청에서만 제공하는 완전히 다른 별도 콘텐츠입니다. 이 페이지는 언어 축 비교 테스트용입니다.</main></html>':'<html lang="en"><title>Language</title><main>Ordinary English content for the standard language profile. This is the baseline of the header comparison fixture.</main></html>');return;
    }
    const response = fixtureResponse(url.pathname, req.headers['user-agent'] ?? '');
    if (!response) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(response.status, {
      'content-type': response.contentType ?? 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(response.body);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const actualPort = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${actualPort}`,
    port: actualPort,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

const isEntry = process.argv[1]?.endsWith('serve.ts') || process.argv[1]?.endsWith('serve.js');
if (isEntry) {
  const argPort = process.argv.includes('--port') ? Number(process.argv[process.argv.indexOf('--port') + 1]) : 4319;
  startFixtureServer(Number.isFinite(argPort) ? argPort : 4319)
    .then((srv) => {
      process.stdout.write(`agentleak fixtures listening on ${srv.url}\n`);
    })
    .catch((err) => {
      process.stderr.write(`fixture server failed: ${(err as Error).message}\n`);
      process.exitCode = 1;
    });
}
