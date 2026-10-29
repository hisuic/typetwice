/** 32-bit FNV-1a over UTF-16 code units, as 8 hex digits. Not cryptographic. */
export function fnv1a32(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** A value that changes whenever the normalized messages change. */
export function corpusVersion(source: string, messages: readonly string[]): string {
  return `${source}-${messages.length}-${fnv1a32(messages.join('\n'))}`;
}
