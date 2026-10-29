import type { Envelope, RequestMap, RequestType, ResponseOf } from './protocol';

export class ExtensionContextError extends Error {
  constructor() {
    super('The extension was reloaded or updated.');
    this.name = 'ExtensionContextError';
  }
}

/** False once the extension has been reloaded, updated or disabled under this page. */
export function isExtensionContextValid(): boolean {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

export async function callBackground<K extends RequestType>(
  type: K,
  payload: RequestMap[K]['request'],
): Promise<ResponseOf<K>> {
  if (!isExtensionContextValid()) throw new ExtensionContextError();
  let response: Envelope<ResponseOf<K>> | undefined;
  try {
    response = await chrome.runtime.sendMessage({ type, ...payload });
  } catch (error) {
    if (!isExtensionContextValid() || /context invalidated/i.test(String(error))) {
      throw new ExtensionContextError();
    }
    throw error;
  }
  if (!response) throw new Error('The extension did not respond.');
  if ('error' in response) throw new Error(response.error);
  return response.result;
}
