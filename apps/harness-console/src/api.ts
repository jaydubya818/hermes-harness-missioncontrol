// Pure request/response helpers shared by the console views. Kept free of
// window/localStorage so they stay unit-testable in a plain node runner.

export function withQuery(url: string, params: Record<string, string | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  const suffix = search.toString();
  return suffix ? `${url}?${suffix}` : url;
}

// Article slugs are wiki-relative paths built from real filenames, and they
// go into the URL *path* (not a query value), so each segment needs escaping
// on its own -- encodeURIComponent over the whole slug would eat the "/"
// separators. Unescaped, a filename containing "?" or "#" silently truncated
// the request (everything after became a query string or fragment) and one
// containing a space produced an invalid URL.
export function encodePathSegments(path: string) {
  return path.split("/").map(encodeURIComponent).join("/");
}

export async function readApiResponse(response: Response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

export function filterCommands<T extends { id: string; label: string }>(commands: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  return commands.filter((command) => command.label.toLowerCase().includes(q) || command.id.toLowerCase().includes(q));
}

// Trailing-edge throttle: fire immediately when idle, then coalesce further
// calls into one trailing invocation per window. Used to keep SSE event
// bursts (replay on connect, chatty step dispatches) from triggering a
// refetch storm -- one revalidation per window instead of one per event.
export function createTrailingThrottle(fn: () => void, windowMs: number): { (): void; cancel: () => void } {
  let lastInvokedAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const invoke = () => {
    lastInvokedAt = Date.now();
    timer = undefined;
    fn();
  };
  const throttled = () => {
    if (timer !== undefined) return;
    const elapsed = Date.now() - lastInvokedAt;
    if (elapsed >= windowMs) invoke();
    else timer = setTimeout(invoke, windowMs - elapsed);
  };
  throttled.cancel = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  return throttled;
}
