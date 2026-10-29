/**
 * Error text without URLs, so that console output never contains the page
 * being browsed (paths, queries) or anything the user typed.
 */
export function safeErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>').slice(0, 300);
}

export function logWarning(context: string, error: unknown): void {
  console.warn(`TypeTwice: ${context}: ${safeErrorMessage(error)}`);
}
