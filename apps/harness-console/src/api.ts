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

export async function readApiResponse(response: Response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}
