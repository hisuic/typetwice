/**
 * Picks one message uniformly at random. When there are at least two
 * messages, the one picked last time for the same site is skipped.
 * Not cryptographically strong, and does not need to be.
 */
export function pickMessage(
  messages: readonly string[],
  previous: string | undefined,
  random: () => number = Math.random,
): string {
  if (messages.length === 0) throw new Error('No messages to pick from.');
  if (messages.length === 1) return messages[0]!;

  const previousIndex = previous === undefined ? -1 : messages.indexOf(previous);
  const poolSize = previousIndex === -1 ? messages.length : messages.length - 1;
  let index = Math.min(poolSize - 1, Math.floor(random() * poolSize));
  if (previousIndex !== -1 && index >= previousIndex) index += 1;
  return messages[index]!;
}
