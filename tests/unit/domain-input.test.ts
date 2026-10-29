import { describe, expect, it } from 'vitest';
import { parseDomainInput } from '../../src/core/domain-input';

function domainOf(input: string) {
  const result = parseDomainInput(input);
  if (!result.ok) throw new Error(result.error);
  return result;
}

function errorOf(input: string) {
  const result = parseDomainInput(input);
  if (result.ok) throw new Error(`Expected an error for ${input}, got ${result.domain}`);
  return result.error;
}

describe('parseDomainInput', () => {
  it('accepts plain domains and lowercases them', () => {
    expect(domainOf('reddit.com')).toEqual({ ok: true, domain: 'reddit.com', notes: [] });
    expect(domainOf('  News.YCombinator.com. ').domain).toBe('news.ycombinator.com');
    expect(domainOf('example.co.uk').domain).toBe('example.co.uk');
    expect(domainOf('someone.github.io').domain).toBe('someone.github.io');
  });

  it('extracts the domain from a pasted URL and says so', () => {
    const result = domainOf('https://www.youtube.com/watch?v=abc#t=1');
    expect(result.domain).toBe('youtube.com');
    expect(result.notes).toEqual([
      'Only the domain is used: www.youtube.com.',
      '"www." was removed so youtube.com and all of its subdomains are covered.',
    ]);
    expect(domainOf('reddit.com/r/all').notes).toEqual(['Only the domain is used: reddit.com.']);
    expect(domainOf('http://example.org:8080').domain).toBe('example.org');
  });

  it('stores international domain names in ASCII', () => {
    const result = domainOf('例え.jp');
    expect(result.domain).toBe('xn--r8jz45g.jp');
    expect(result.notes[0]).toContain('ASCII form');
  });

  it('rejects URLs with user information', () => {
    expect(errorOf('https://user:pw@x.example.com/')).toMatch(/user name or password/);
    expect(errorOf('me@example.com')).toMatch(/user name or password/);
  });

  it('rejects wildcards', () => {
    expect(errorOf('*.example.com')).toMatch(/Wildcards/);
    expect(errorOf('https://*.example.com/')).toMatch(/Wildcards/);
  });

  it('rejects public suffixes on their own', () => {
    expect(errorOf('co.uk')).toMatch(/public suffix/);
    expect(errorOf('github.io')).toMatch(/public suffix/);
    expect(errorOf('https://blogspot.com/')).toMatch(/public suffix/);
    expect(errorOf('com')).toMatch(/full domain/);
  });

  it('keeps www. when removing it would leave a public suffix', () => {
    expect(domainOf('www.github.io').domain).toBe('www.github.io');
    expect(domainOf('www.co.uk').domain).toBe('www.co.uk');
  });

  it('rejects browser-internal and non-http URLs', () => {
    for (const input of ['chrome://settings', 'about:blank', 'file:///tmp/a.html', 'ftp://example.com', 'javascript:alert(1)']) {
      expect(errorOf(input)).toMatch(/Only http:\/\/ and https:\/\//);
    }
  });

  it('rejects IP addresses, single labels and empty or spaced input', () => {
    expect(errorOf('127.0.0.1')).toMatch(/IP addresses/);
    expect(errorOf('http://[::1]/')).toMatch(/IP addresses/);
    expect(errorOf('localhost')).toMatch(/full domain/);
    expect(errorOf('   ')).toMatch(/Enter a domain/);
    expect(errorOf('exa mple.com')).toMatch(/spaces/);
  });
});
