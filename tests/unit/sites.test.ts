import { describe, expect, it } from 'vitest';
import {
  BUILTIN_SITES,
  domainsOverlap,
  findOverlappingSite,
  findSiteForUrl,
  hostMatchesDomain,
  makeCustomSite,
  originPatterns,
} from '../../src/core/sites';

describe('hostMatchesDomain', () => {
  it('matches the domain itself and its subdomains', () => {
    expect(hostMatchesDomain('x.com', 'x.com')).toBe(true);
    expect(hostMatchesDomain('mobile.x.com', 'x.com')).toBe(true);
    expect(hostMatchesDomain('X.COM.', 'x.com')).toBe(true);
  });

  it('does not match look-alike hosts', () => {
    expect(hostMatchesDomain('notx.com', 'x.com')).toBe(false);
    expect(hostMatchesDomain('x.com.evil.example', 'x.com')).toBe(false);
    expect(hostMatchesDomain('com', 'x.com')).toBe(false);
  });
});

describe('findSiteForUrl', () => {
  it('maps x.com and twitter.com to the same site and Instagram to another', () => {
    expect(findSiteForUrl('https://x.com/home', BUILTIN_SITES)?.id).toBe('x');
    expect(findSiteForUrl('https://mobile.twitter.com/', BUILTIN_SITES)?.id).toBe('x');
    expect(findSiteForUrl('http://www.instagram.com/p/1', BUILTIN_SITES)?.id).toBe('instagram');
  });

  it('ignores other hosts, other schemes and invalid URLs', () => {
    for (const url of [
      'https://notx.com/',
      'https://x.com.evil.example/',
      'https://instagram.com.example.org/',
      'ftp://x.com/',
      'chrome://settings',
      'not a url',
      undefined,
    ]) {
      expect(findSiteForUrl(url, BUILTIN_SITES)).toBeUndefined();
    }
  });
});

describe('overlap', () => {
  it('detects equal, parent and child domains', () => {
    expect(domainsOverlap('x.com', 'x.com')).toBe(true);
    expect(domainsOverlap('mobile.twitter.com', 'twitter.com')).toBe(true);
    expect(domainsOverlap('example.com', 'a.example.com')).toBe(true);
    expect(domainsOverlap('notx.com', 'x.com')).toBe(false);
  });

  it('names the site that already covers a domain', () => {
    const sites = [...BUILTIN_SITES, makeCustomSite('reddit.com', true)];
    expect(findOverlappingSite('mobile.twitter.com', sites)).toEqual({ site: BUILTIN_SITES[0], domain: 'twitter.com' });
    expect(findOverlappingSite('old.reddit.com', sites)?.site.id).toBe('custom:reddit.com');
    expect(findOverlappingSite('youtube.com', sites)).toBeUndefined();
  });
});

describe('originPatterns', () => {
  it('covers http and https on the domain and its subdomains', () => {
    expect(originPatterns(['x.com', 'twitter.com'])).toEqual(['*://*.x.com/*', '*://*.twitter.com/*']);
  });
});
