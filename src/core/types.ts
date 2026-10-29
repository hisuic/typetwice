/** Persistent user settings (chrome.storage.local). */
export interface Settings {
  schemaVersion: 1;
  enabled: boolean;
  /** Integer, 5..300. */
  minDurationSeconds: number;
  /** Integer, 1..60. */
  unlockDurationMinutes: number;
  sites: SiteRule[];
  corpusSource: CorpusSource;
}

export interface SiteRule {
  id: string;
  name: string;
  /** Root domains; each one also covers its subdomains. */
  domains: string[];
  enabled: boolean;
  /** Built-in sites can be turned off but not removed. */
  builtin: boolean;
}

export type CorpusSource = 'bundled' | 'custom';

export interface Corpus {
  /** Changes whenever the normalized messages change. */
  version: string;
  source: CorpusSource;
  /** Validated, normalized and de-duplicated. */
  messages: string[];
  importedAt?: number;
  fileName?: string;
}

/** allowedUntil per siteId (chrome.storage.session). */
export type GrantMap = Record<string, number>;

export type ChallengeStatus = 'pending' | 'completed' | 'declined';

export interface Challenge {
  id: string;
  tabId: number;
  siteId: string;
  text: string;
  corpusVersion: string;
  minDurationSeconds: number;
  unlockDurationMinutes: number;
  createdAt: number;
  status: ChallengeStatus;
  /** Whether this challenge already counted towards "Gates shown". */
  shownCounted: boolean;
}

export interface DailyStats {
  /** Local date of the device, YYYY-MM-DD. */
  date: string;
  shown: number;
  opened: number;
  declined: number;
}

export type StatKind = 'shown' | 'opened' | 'declined';

/** DailyStats keyed by date. */
export type StatsMap = Record<string, DailyStats>;
