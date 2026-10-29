import { parse } from 'tldts';
import { normalizeHostname } from './sites';

export type DomainInputResult =
  | { ok: true; domain: string; notes: string[] }
  | { ok: false; error: string };

const BROWSER_SCHEMES =
  /^(about|blob|brave|chrome|chrome-extension|chrome-search|chrome-untrusted|data|devtools|edge|file|filesystem|javascript|mailto|view-source):/i;

const TLDTS_OPTIONS = { allowPrivateDomains: true, extractHostname: false } as const;

/**
 * Turns what the user typed (a domain or a pasted URL) into a root domain.
 * The domain and all of its subdomains will share one unlock.
 */
export function parseDomainInput(input: string): DomainInputResult {
  const trimmed = input.trim();
  if (trimmed === '') return fail('Enter a domain such as example.com.');
  if (/\s/.test(trimmed)) return fail('A domain cannot contain spaces.');
  if (trimmed.includes('*')) {
    return fail('Wildcards are not supported. Enter a domain such as example.com; its subdomains are included automatically.');
  }
  if (BROWSER_SCHEMES.test(trimmed)) return fail('Only http:// and https:// sites are supported.');

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  let url: URL;
  try {
    url = new URL(hasScheme ? trimmed : `http://${trimmed}`);
  } catch {
    return fail('Enter a valid domain such as example.com.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return fail('Only http:// and https:// sites are supported.');
  }
  if (url.username || url.password) return fail('Addresses with a user name or password are not allowed.');

  const host = normalizeHostname(url.hostname);
  if (host.startsWith('[') || parse(host, TLDTS_OPTIONS).isIp) {
    return fail('IP addresses are not supported. Enter a domain name.');
  }
  if (!host.includes('.')) return fail('Enter a full domain such as example.com.');

  const notes: string[] = [];
  if (hasScheme || /[/?#:]/.test(trimmed)) notes.push(`Only the domain is used: ${host}.`);
  if (/[^\x00-\x7f]/.test(trimmed)) {
    notes.push(`International domain names are stored in their ASCII form: ${host}.`);
  }

  let domain = host;
  if (host.startsWith('www.') && !isPublicSuffix(host.slice(4))) {
    domain = host.slice(4);
    notes.push(`"www." was removed so ${domain} and all of its subdomains are covered.`);
  }

  const info = parse(domain, TLDTS_OPTIONS);
  if (info.hostname === null) return fail('Enter a valid domain such as example.com.');
  if (isPublicSuffix(domain)) {
    return fail(
      `${domain} is a public suffix shared by many unrelated sites. Enter a specific site such as example.${domain}.`,
    );
  }

  return { ok: true, domain, notes };
}

function isPublicSuffix(hostname: string): boolean {
  const info = parse(hostname, TLDTS_OPTIONS);
  return info.domain === null || info.publicSuffix === hostname;
}

function fail(error: string): DomainInputResult {
  return { ok: false, error };
}
