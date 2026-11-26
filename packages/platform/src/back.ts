// The back-interceptor stack. An overlay that is open but has no history entry
// of its own (a popover, a picker panel) pushes a function that closes it. The
// Android back action calls the topmost one before it goes back in history, so
// back closes only the topmost overlay and leaves everything under it alone.

const stack: Array<() => void> = [];

/**
 * Registers `close` as the topmost back interceptor and returns a function
 * that removes it. Call it when the overlay opens and remove it when it closes.
 */
export function pushBackInterceptor(close: () => void): () => void {
  const entry = () => close();
  stack.push(entry);
  return () => {
    const i = stack.lastIndexOf(entry);
    if (i >= 0) stack.splice(i, 1);
  };
}

/**
 * Gives the back action to the topmost interceptor. Returns true if there was
 * one, in which case the action is used up and nothing else should go back.
 */
export function runBackInterceptor(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top();
  return true;
}
