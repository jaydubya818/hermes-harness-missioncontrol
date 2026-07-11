export type BrowserAction =
  | { kind: "navigate"; url: string }
  | { kind: "snapshot" }
  | { kind: "click"; ref: string }
  | { kind: "fill"; ref: string; text: string }
  | { kind: "screenshot"; filename?: string };

export interface BrowserActionResult {
  action: BrowserAction["kind"];
  ok: boolean;
  url?: string;
  title?: string;
  snapshot?: string;
  screenshot_path?: string;
  blocked_reason?: string;
  duration_ms: number;
  error?: string;
}

export interface BrowserToolOptions {
  allowedDomains: string[];
  screenshotDir?: string;
  headless?: boolean;
  navigationTimeoutMs?: number;
  /**
   * Skip the playwright launch path entirely and return the stub session.
   * Useful for tests and environments where browser binaries are not installed.
   */
  forceStub?: boolean;
}

export interface BrowserSession {
  navigate(url: string): Promise<BrowserActionResult>;
  snapshot(): Promise<BrowserActionResult>;
  click(ref: string): Promise<BrowserActionResult>;
  fill(ref: string, text: string): Promise<BrowserActionResult>;
  screenshot(filename?: string): Promise<BrowserActionResult>;
  close(): Promise<void>;
}

export class BrowserToolError extends Error {
  blocked: boolean;
  constructor(message: string, blocked = false) {
    super(message);
    this.name = "BrowserToolError";
    this.blocked = blocked;
  }
}

export function isDomainAllowed(url: string, allowedDomains: string[]) {
  if (allowedDomains.length === 0) return false;
  if (allowedDomains.includes("*")) return true;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return allowedDomains.some((domain) => {
    const normalized = domain.toLowerCase().replace(/^\*\./, "");
    return host === normalized || host.endsWith(`.${normalized}`);
  });
}

export async function createBrowserSession(options: BrowserToolOptions): Promise<BrowserSession> {
  if (options.forceStub) {
    return createStubSession(options);
  }
  const playwright = await loadPlaywright();
  if (!playwright) {
    return createStubSession(options);
  }
  const browser = await playwright.chromium.launch({ headless: options.headless ?? true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const navigationTimeout = options.navigationTimeoutMs ?? 30_000;
  let lastSnapshotRefs = new Map<string, string>();

  const refreshSnapshot = async (): Promise<string> => {
    const handles = await page.$$("button, a, input, textarea, select, [role='button']");
    const lines: string[] = [];
    lastSnapshotRefs = new Map();
    for (let i = 0; i < handles.length && i < 100; i += 1) {
      const handle = handles[i]!;
      const ref = `ref_${i + 1}`;
      try {
        const tag = await handle.evaluate((el: Element) => el.tagName.toLowerCase());
        const text = (await handle.innerText().catch(() => "")).trim().slice(0, 80);
        const role = await handle.getAttribute("role").catch(() => null);
        const aria = await handle.getAttribute("aria-label").catch(() => null);
        const placeholder = await handle.getAttribute("placeholder").catch(() => null);
        const id = await handle.getAttribute("id").catch(() => null);
        const label = aria ?? text ?? placeholder ?? id ?? tag;
        const selector = id ? `#${id}` : await handle.evaluate((el: Element) => {
          const path: string[] = [];
          let current: Element | null = el;
          while (current && current !== document.body && path.length < 5) {
            const idx = Array.from(current.parentElement?.children ?? []).indexOf(current);
            path.unshift(`${current.tagName.toLowerCase()}:nth-child(${idx + 1})`);
            current = current.parentElement;
          }
          return path.join(" > ");
        }).catch(() => tag);
        lastSnapshotRefs.set(ref, selector);
        lines.push(`${ref} <${tag}${role ? ` role=${role}` : ""}> ${label}`);
      } catch {
        continue;
      }
    }
    return lines.join("\n");
  };

  return {
    async navigate(url) {
      const started = Date.now();
      if (!isDomainAllowed(url, options.allowedDomains)) {
        return { action: "navigate", ok: false, duration_ms: Date.now() - started, blocked_reason: `domain not in allowed list: ${url}` };
      }
      try {
        await page.goto(url, { timeout: navigationTimeout, waitUntil: "domcontentloaded" });
        return { action: "navigate", ok: true, url: page.url(), title: await page.title(), duration_ms: Date.now() - started };
      } catch (err) {
        return { action: "navigate", ok: false, duration_ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
      }
    },
    async snapshot() {
      const started = Date.now();
      try {
        const snapshot = await refreshSnapshot();
        return { action: "snapshot", ok: true, url: page.url(), title: await page.title(), snapshot, duration_ms: Date.now() - started };
      } catch (err) {
        return { action: "snapshot", ok: false, duration_ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
      }
    },
    async click(ref) {
      const started = Date.now();
      const selector = lastSnapshotRefs.get(ref);
      if (!selector) return { action: "click", ok: false, duration_ms: Date.now() - started, error: `unknown ref: ${ref}. take a snapshot first.` };
      try {
        await page.click(selector, { timeout: navigationTimeout });
        return { action: "click", ok: true, duration_ms: Date.now() - started };
      } catch (err) {
        return { action: "click", ok: false, duration_ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
      }
    },
    async fill(ref, text) {
      const started = Date.now();
      const selector = lastSnapshotRefs.get(ref);
      if (!selector) return { action: "fill", ok: false, duration_ms: Date.now() - started, error: `unknown ref: ${ref}. take a snapshot first.` };
      try {
        await page.fill(selector, text, { timeout: navigationTimeout });
        return { action: "fill", ok: true, duration_ms: Date.now() - started };
      } catch (err) {
        return { action: "fill", ok: false, duration_ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
      }
    },
    async screenshot(filename) {
      const started = Date.now();
      const target = filename ?? `screenshot-${Date.now()}.png`;
      const path = options.screenshotDir ? `${options.screenshotDir.replace(/\/$/, "")}/${target}` : target;
      try {
        await page.screenshot({ path, fullPage: true });
        return { action: "screenshot", ok: true, duration_ms: Date.now() - started, screenshot_path: path };
      } catch (err) {
        return { action: "screenshot", ok: false, duration_ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
      }
    },
    async close() {
      try {
        await context.close();
      } finally {
        await browser.close();
      }
    },
  };
}

interface PlaywrightModule {
  chromium: {
    launch(options: { headless?: boolean }): Promise<{
      newContext(): Promise<{
        newPage(): Promise<any>;
        close(): Promise<void>;
      }>;
      close(): Promise<void>;
    }>;
  };
}

async function loadPlaywright(): Promise<PlaywrightModule | null> {
  try {
    const mod = (await import("playwright")) as unknown as PlaywrightModule;
    return mod;
  } catch {
    return null;
  }
}

function createStubSession(options: BrowserToolOptions): BrowserSession {
  let currentUrl = "about:blank";
  return {
    async navigate(url) {
      const started = Date.now();
      if (!isDomainAllowed(url, options.allowedDomains)) {
        return { action: "navigate", ok: false, duration_ms: Date.now() - started, blocked_reason: `domain not in allowed list: ${url}` };
      }
      currentUrl = url;
      return { action: "navigate", ok: true, url, title: `[stub] ${url}`, duration_ms: Date.now() - started };
    },
    async snapshot() {
      const started = Date.now();
      return { action: "snapshot", ok: true, url: currentUrl, snapshot: "[browser-tool] playwright not installed; install 'playwright' peer dependency for real snapshots.", duration_ms: Date.now() - started };
    },
    async click() {
      return { action: "click", ok: false, duration_ms: 0, error: "[browser-tool] playwright not installed" };
    },
    async fill() {
      return { action: "fill", ok: false, duration_ms: 0, error: "[browser-tool] playwright not installed" };
    },
    async screenshot() {
      return { action: "screenshot", ok: false, duration_ms: 0, error: "[browser-tool] playwright not installed" };
    },
    async close() {},
  };
}

export const browserToolSchemas = [
  {
    name: "browser_navigate",
    description: "Navigate to a URL. Domain must be in the allowed_domains list set by the execution envelope.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string", description: "absolute URL to navigate to" } },
      required: ["url"],
    },
  },
  {
    name: "browser_snapshot",
    description: "Return a structured aria/accessibility snapshot of the current page with refs for interactive elements.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "browser_click",
    description: "Click an interactive element using a ref returned by browser_snapshot.",
    input_schema: {
      type: "object",
      properties: { ref: { type: "string", description: "ref identifier from a recent snapshot" } },
      required: ["ref"],
    },
  },
  {
    name: "browser_fill",
    description: "Fill an input/textarea using a ref returned by browser_snapshot.",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "ref identifier from a recent snapshot" },
        text: { type: "string", description: "text to fill into the element" },
      },
      required: ["ref", "text"],
    },
  },
  {
    name: "browser_screenshot",
    description: "Capture a full-page PNG screenshot to the worker output directory.",
    input_schema: {
      type: "object",
      properties: { filename: { type: "string", description: "optional filename for the screenshot" } },
    },
  },
] as const;
