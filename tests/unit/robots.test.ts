import { describe, expect, test } from 'vitest';
import { parseRobots } from '../../src/scan.js';
const names = ['gptbot', 'claudebot'];
describe('effective robots policy', () => {
  test('wildcard applies to every requested agent', () => {
    expect(parseRobots('User-agent: *\nDisallow: /', names).disallowedAgents).toEqual(names);
  });
  test('specific allow group overrides wildcard regardless of order', () => {
    for (const text of ['User-agent: *\nDisallow: /\nUser-agent: GPTBot\nAllow: /', 'User-agent: GPTBot\nAllow: /\nUser-agent: *\nDisallow: /']) {
      expect(parseRobots(text, names).disallowedAgents).toEqual(['claudebot']);
    }
  });
  test('empty disallow is a specific exception, not another UA in the wildcard group', () => {
    expect(parseRobots('User-agent: *\nDisallow: /\nUser-agent: GPTBot\nDisallow:', names).disallowedAgents).toEqual(['claudebot']);
  });
  test('merges matching groups and uses longest rule with allow on a tie', () => {
    const text = 'User-agent: GPTBot\nDisallow: /private\nUser-agent: gptbot\nAllow: /private/open';
    expect(parseRobots(text, names, '/private/closed').disallowedAgents).toEqual(['gptbot']);
    expect(parseRobots(text, names, '/private/open?q=1').disallowedAgents).toEqual([]);
    expect(parseRobots('User-agent: *\nAllow: /\nDisallow: /', names).disallowedAgents).toEqual([]);
  });
  test('handles shared groups, wildcard paths and anchors without regex injection', () => {
    const text = 'User-agent: gptbot\nUser-agent: claudebot\nDisallow: /*.pdf$';
    expect(parseRobots(text, names, '/file.pdf').disallowedAgents).toEqual(names);
    expect(parseRobots(text, names, '/fileXpdf').disallowedAgents).toEqual([]);
    expect(parseRobots(text, names, '/file.pdf/more').disallowedAgents).toEqual([]);
  });
  test('normalizes UTF-8 and unreserved escapes without decoding reserved slash', () => {
    expect(parseRobots('User-agent: *\nDisallow: /비밀', names, '/%EB%B9%84%EB%B0%80/page').disallowedAgents).toEqual(names);
    expect(parseRobots('User-agent: *\nDisallow: /%70rivate', names, '/private').disallowedAgents).toEqual(names);
    expect(parseRobots('User-agent: *\nDisallow: /a%2Fb', names, '/a/b').disallowedAgents).toEqual([]);
  });
  test('uses the full wildcard rule length and keeps blocksAll site-wide', () => {
    expect(parseRobots('User-agent: *\nAllow: /p\nDisallow: /p*', names, '/private').disallowedAgents).toEqual(names);
    expect(parseRobots('User-agent: *\nDisallow: /private', names, '/private').blocksAll).toBe(false);
  });
  test('end anchors contribute to rule priority', () => {
    expect(parseRobots('User-agent: *\nAllow: /private\nDisallow: /private$', names, '/private').disallowedAgents).toEqual(names);
  });
  test('handles adversarial wildcard patterns without backtracking', () => {
    expect(parseRobots('User-agent: *\nDisallow: /' + 'a*'.repeat(60) + 'b$', names, '/' + 'a'.repeat(120)).disallowedAgents).toEqual([]);
  });
});
