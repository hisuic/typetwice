/** The small subset of chrome.storage used by the worker, so tests can swap it out. */
export interface KeyValueArea {
  get<T>(key: string): Promise<T | undefined>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

/** chrome.storage.local */
export const LOCAL_KEYS = {
  settings: 'settings',
  customCorpus: 'customCorpus',
  stats: 'stats',
} as const;

/** chrome.storage.session: survives worker restarts, cleared on browser restart or extension reload. */
export const SESSION_KEYS = {
  grants: 'grants',
  challenges: 'challenges',
  lastPicked: 'lastPicked',
} as const;

export function chromeArea(area: chrome.storage.StorageArea): KeyValueArea {
  return {
    async get<T>(key: string) {
      const values = await area.get(key);
      return values[key] as T | undefined;
    },
    set: (values) => area.set(values),
    remove: (keys) => area.remove(keys),
  };
}

/** In-memory area with JSON round-tripping, like the real storage. */
export class MemoryArea implements KeyValueArea {
  readonly data = new Map<string, string>();

  async get<T>(key: string): Promise<T | undefined> {
    const raw = this.data.get(key);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  }

  async set(values: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(values)) this.data.set(key, JSON.stringify(value));
  }

  async remove(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.data.delete(key);
  }
}
