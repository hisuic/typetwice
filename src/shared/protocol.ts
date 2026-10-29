import type { CorpusSource, DailyStats, Settings, SiteRule } from '../core/types';

/** What a content script needs to know about its own page. */
export type GateState =
  | { status: 'inactive' }
  | { status: 'allowed'; siteId: string; siteName: string; allowedUntil: number }
  | { status: 'gated'; siteId: string; siteName: string };

export interface ChallengeView {
  id: string;
  siteName: string;
  text: string;
  corpusVersion: string;
  minDurationSeconds: number;
  unlockDurationMinutes: number;
}

export type StartChallengeResult =
  | { status: 'inactive' }
  | { status: 'allowed'; allowedUntil: number }
  | { status: 'challenge'; challenge: ChallengeView }
  | { status: 'error'; message: string };

export type CompleteChallengeResult =
  | { ok: true; allowedUntil: number }
  | { ok: false; reason: 'inactive' | 'unknown-challenge' | 'mismatch' | 'too-early' | 'closed'; message: string };

export type SiteStatus = 'protected' | 'permission-required' | 'off';

export interface SiteView extends SiteRule {
  status: SiteStatus;
  /** Host permission patterns this site needs. */
  origins: string[];
}

export interface CorpusView {
  source: CorpusSource;
  count: number;
  version: string;
  importedAt?: number;
  fileName?: string;
  /** Set when the active message set could not be loaded. */
  error?: string;
}

export interface SettingsView {
  settings: Settings;
  sites: SiteView[];
  corpus: CorpusView;
  today: DailyStats;
}

export type MutationResult =
  | { ok: true; view: SettingsView; notice?: string }
  | { ok: false; error: string; view: SettingsView };

export interface SettingsPatch {
  enabled?: boolean;
  minDurationSeconds?: number;
  unlockDurationMinutes?: number;
}

/** Request payloads and their responses, keyed by message type. */
export interface RequestMap {
  // Content script -> background
  GET_GATE_STATE: { request: Record<never, never>; response: GateState };
  START_CHALLENGE: { request: Record<never, never>; response: StartChallengeResult };
  CHALLENGE_SHOWN: { request: { challengeId: string }; response: { ok: boolean } };
  COMPLETE_CHALLENGE: {
    request: { challengeId: string; typed: string; elapsedMs: number };
    response: CompleteChallengeResult;
  };
  DECLINE_CHALLENGE: { request: { challengeId: string }; response: { ok: boolean } };
  OPEN_OPTIONS: { request: Record<never, never>; response: { ok: boolean } };
  // Extension pages -> background
  GET_SETTINGS: { request: Record<never, never>; response: SettingsView };
  UPDATE_SETTINGS: { request: { patch: SettingsPatch }; response: MutationResult };
  SET_SITE_ENABLED: { request: { siteId: string; enabled: boolean }; response: MutationResult };
  ADD_SITE: { request: { input: string }; response: MutationResult };
  REMOVE_SITE: { request: { siteId: string }; response: MutationResult };
  IMPORT_CORPUS: { request: { text: string; fileName: string }; response: MutationResult };
  RESTORE_BUNDLED_CORPUS: { request: Record<never, never>; response: MutationResult };
}

export type RequestType = keyof RequestMap;

export type RequestMessage = {
  [K in RequestType]: { type: K } & RequestMap[K]['request'];
}[RequestType];

export type ResponseOf<K extends RequestType> = RequestMap[K]['response'];

/** Wraps every response so that unexpected failures reach the caller as errors. */
export type Envelope<T> = { result: T } | { error: string };

export const CONTENT_REQUESTS: ReadonlySet<RequestType> = new Set<RequestType>([
  'GET_GATE_STATE',
  'START_CHALLENGE',
  'CHALLENGE_SHOWN',
  'COMPLETE_CHALLENGE',
  'DECLINE_CHALLENGE',
  'OPEN_OPTIONS',
]);

/** Messages the background worker sends to content scripts. */
export type ContentEvent = { type: 'PING' } | { type: 'REFRESH' };
