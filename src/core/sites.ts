import type { SiteRule } from './types';

/** Candidates shown on first run; they stay off until host access is granted. */
export const BUILTIN_SITES: readonly SiteRule[] = [
  { id: 'x', name: 'X', domains: ['x.com', 'twitter.com'], enabled: false, builtin: true },
  { id: 'instagram', name: 'Instagram', domains: ['instagram.com'], enabled: false, builtin: true },
];

export function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, '');
}

/** Exact match or a subdomain of `domain` (so notx.com and x.com.evil.example do not match). */
export function hostMatchesDomain(hostname: string, domain: string): boolean {
  const host = normalizeHostname(hostname);
  return host === domain || host.endsWith(`.${domain}`);
}

/** Parses a page URL; only http and https are supported. */
export function parseHttpUrl(url: string | undefined): URL | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
}

/** The site whose domains cover the URL's hostname, whether or not it is enabled. */
export function findSiteForUrl(url: string | undefined, sites: readonly SiteRule[]): SiteRule | undefined {
  const parsed = parseHttpUrl(url);
  if (!parsed) return undefined;
  return sites.find((site) => site.domains.some((domain) => hostMatchesDomain(parsed.hostname, domain)));
}

export function domainsOverlap(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/** The first registered site whose range includes or is included by `domain`. */
export function findOverlappingSite(
  domain: string,
  sites: readonly SiteRule[],
): { site: SiteRule; domain: string } | undefined {
  for (const site of sites) {
    const existing = site.domains.find((d) => domainsOverlap(domain, d));
    if (existing) return { site, domain: existing };
  }
  return undefined;
}

/** Match patterns covering http and https on each domain and its subdomains. */
export function originPatterns(domains: readonly string[]): string[] {
  return domains.map((domain) => `*://*.${domain}/*`);
}

export function customSiteId(domain: string): string {
  return `custom:${domain}`;
}

export function makeCustomSite(domain: string, enabled: boolean): SiteRule {
  return { id: customSiteId(domain), name: domain, domains: [domain], enabled, builtin: false };
}
