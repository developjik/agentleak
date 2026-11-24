import { describe, it, expect } from 'vitest';
import { diffCrawls, parseSitemap, parseCrawlSnapshot, renderCrawlMarkdown, type CrawlSnapshot } from '../../src/crawl.js';
import { makeFinding, makeSnapshot } from './factory.js';
function crawl(text: string): CrawlSnapshot {
  const snapshot = makeSnapshot(text ? [makeFinding({ text, score: 10 })] : []);
  return { schema: 'agentleak.crawl/v1', version: 'test', createdAt: '', warnings: [], domains: [], pages: [{ url: snapshot.url, warnings: [], snapshot }] };
}
describe('crawl inputs and comparison', () => {
  it('parses standard, namespaced, entity and CDATA locs and sitemap index', () => {
    expect(parseSitemap('<?xml version="1.0"?><urlset xmlns="x"><url><loc>https://example.com/?a=1&amp;b=2</loc></url><url><loc><![CDATA[https://example.com/b?a=1&b=2]]></loc></url></urlset>').locations).toEqual(['https://example.com/?a=1&b=2', 'https://example.com/b?a=1&b=2']);
    expect(parseSitemap('<s:sitemapindex xmlns:s="x"><s:sitemap><s:loc>https://example.com/a.xml</s:loc></s:sitemap></s:sitemapindex>')).toEqual({ index: true, locations: ['https://example.com/a.xml'] });
  });
  it('rejects DTDs, misplaced loc, bad XML and invalid entities', () => {
    for (const xml of ['<!DOCTYPE x><urlset></urlset>', '<urlset><loc>https://example.com</loc></urlset>', '<urlset><url></urlset>', '<urlset><url><loc>&unknown;</loc></url></urlset>', '<urlset><url><loc>&#0;</loc></url></urlset>']) expect(() => parseSitemap(xml)).toThrow();
  });
  it('diffs each URL separately and retains failed or omitted pages as unknown', () => {
    const before = crawl('previous block'), after = crawl('current block');
    expect(diffCrawls(before, after)).toMatchObject({ newInstructions: 1, removedInstructions: 1 });
    const failed = { ...after, pages: [{ ...after.pages[0]!, error: 'offline' }] };
    expect(diffCrawls(before, failed)).toMatchObject({ newInstructions: 0, removedInstructions: 0, pages: [] });
    const omitted = { ...after, pages: [] };
    expect(diffCrawls(before, omitted).uncomparable[0]?.reason).toContain('not proof');
    const newPage = { ...after, pages: [{ ...after.pages[0]!, url: 'https://example.com/new', snapshot: { ...after.pages[0]!.snapshot!, url: 'https://example.com/new' } }] };
    expect(diffCrawls(before, newPage).addedPages).toEqual(['https://example.com/new']);
  });
  it('rejects duplicate/mismatched pages and renders remote markup as text', () => {
    const file = crawl('<script>alert(1)</script>|raw');
    expect(() => parseCrawlSnapshot({ ...file, pages: [...file.pages, ...file.pages] })).toThrow(/Duplicate/);
    expect(() => parseCrawlSnapshot({ ...file, pages: [{ ...file.pages[0], url: 'https://example.com/other' }] })).toThrow(/mismatch/);
    file.pages[0]!.warnings.push('<img src=x onerror=alert(1)>');
    expect(renderCrawlMarkdown(file)).not.toContain('<img');
    expect(renderCrawlMarkdown(file)).toContain('&lt;img');
  });
});
