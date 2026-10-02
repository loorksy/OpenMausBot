/** Opens the thread id already stored on the trading occurrence.
 * The path is the existing app. It does not allocate a thread. */
export function attachedConversationHref(threadId: string): string {
  return `/?threadId=${encodeURIComponent(threadId)}`;
}
