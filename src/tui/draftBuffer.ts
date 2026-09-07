/**
 * Batched streaming-draft buffer.
 *
 * Token events arrive far faster than the terminal should repaint. This buffer
 * coalesces token/reasoning fragments and flushes them into the draft signals
 * at most every 32ms (or immediately once 2048 chars accumulate).
 */

type Setter = (fn: (prev: string) => string) => void;

export interface DraftBuffer {
  append: (content: string, reasoning: string) => void;
  flush: () => void;
  /** Cancel a pending flush without draining (used on close). */
  clearTimer: () => void;
  /** Drop pending fragments without emitting them (turn reset). */
  reset: () => void;
}

export function createDraftBuffer(setDraft: Setter, setDraftReasoning: Setter): DraftBuffer {
  let pendingText = "";
  let pendingReasoning = "";
  let timer: ReturnType<typeof setTimeout> | undefined;

  function clearTimer(): void {
    if (timer) clearTimeout(timer);
    timer = undefined;
  }

  function flush(): void {
    clearTimer();
    const text = pendingText;
    const reasoning = pendingReasoning;
    pendingText = "";
    pendingReasoning = "";
    if (reasoning) setDraftReasoning((prev) => prev + reasoning);
    if (text) setDraft((prev) => prev + text);
  }

  function schedule(): void {
    if (timer) return;
    timer = setTimeout(() => flush(), 32);
  }

  function append(content: string, reasoning: string): void {
    if (!content && !reasoning) return;
    pendingText += content;
    pendingReasoning += reasoning;
    if (pendingText.length + pendingReasoning.length >= 2048) {
      flush();
    } else {
      schedule();
    }
  }

  function reset(): void {
    clearTimer();
    pendingText = "";
    pendingReasoning = "";
  }

  return { append, flush, clearTimer, reset };
}
