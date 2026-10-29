/**
 * Runs async tasks one at a time, in submission order. Every read-modify-write
 * of storage goes through one queue so concurrent tabs cannot lose updates
 * or create two grants at once.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
