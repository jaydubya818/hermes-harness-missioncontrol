// Interest feeds — top 3 headlines from configured RSS URLs.
//
// Implementation: lightweight regex-based RSS parser (avoids adding xml2js dep).
// Robust enough for well-formed RSS 2.0 / Atom feeds; falls back gracefully on parse errors.

import type { FeedHeadline } from "../types.js";

const DEMO: FeedHeadline[] = [
  { source: "[stub] Hacker News", title: "Show HN: A self-hosted second brain", url: "https://example.com/1" },
  { source: "[stub] LWN", title: "What's coming in Linux 6.10", url: "https://example.com/2" },
  { source: "[stub] Stratechery", title: "The new agent economy", url: "https://example.com/3" },
];

type ParsedItem = { source: string; title: string; url: string; pubDate?: number };

function parseFeed(xml: string, sourceFromUrl: string): ParsedItem[] {
  const channelTitle = xml.match(/<channel>[\s\S]*?<title>([\s\S]*?)<\/title>/i)?.[1]?.trim()
    ?? xml.match(/<feed[^>]*>[\s\S]*?<title>([\s\S]*?)<\/title>/i)?.[1]?.trim()
    ?? sourceFromUrl;
  const cleanedSource = channelTitle.replace(/<!\[CDATA\[|\]\]>/g, "").trim();

  const items: ParsedItem[] = [];
  // RSS 2.0 <item>
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const title = block.match(/<title>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<!\[CDATA\[|\]\]>/g, "").trim();
    const link = block.match(/<link>([\s\S]*?)<\/link>/i)?.[1]?.trim();
    const pub = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1]?.trim();
    if (title && link) {
      items.push({ source: cleanedSource, title, url: link, pubDate: pub ? Date.parse(pub) : undefined });
    }
  }
  // Atom <entry>
  if (items.length === 0) {
    const entryRe = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
    while ((m = entryRe.exec(xml)) !== null) {
      const block = m[1];
      const title = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<!\[CDATA\[|\]\]>/g, "").trim();
      const link = block.match(/<link[^>]*href=["']([^"']+)["']/i)?.[1]?.trim();
      const pub = block.match(/<(?:updated|published)>([\s\S]*?)<\/(?:updated|published)>/i)?.[1]?.trim();
      if (title && link) {
        items.push({ source: cleanedSource, title, url: link, pubDate: pub ? Date.parse(pub) : undefined });
      }
    }
  }
  return items;
}

export async function fetchFeeds(opts: {
  rssUrls: string[];
  maxTotal: number;
}): Promise<{ feeds: FeedHeadline[]; warning?: string }> {
  if (opts.rssUrls.length === 0) {
    return { feeds: DEMO.slice(0, opts.maxTotal), warning: "feeds:stub (no FEEDS_RSS_URLS)" };
  }

  const warnings: string[] = [];
  const all: ParsedItem[] = [];

  await Promise.all(
    opts.rssUrls.map(async (url) => {
      try {
        const res = await fetch(url, { headers: { "User-Agent": "daily-brief-runner/0.1" } });
        if (!res.ok) {
          warnings.push(`feeds:http-${res.status}:${url}`);
          return;
        }
        const xml = await res.text();
        const items = parseFeed(xml, new URL(url).hostname);
        all.push(...items);
      } catch (err) {
        warnings.push(`feeds:fetch-error:${url}:${(err as Error).message}`);
      }
    }),
  );

  // Newest first; tie-break by source-position.
  all.sort((a, b) => (b.pubDate ?? 0) - (a.pubDate ?? 0));
  const top = all.slice(0, opts.maxTotal).map(({ source, title, url }) => ({ source, title, url }));

  return {
    feeds: top,
    warning: warnings.length > 0 ? warnings.join(";") : undefined,
  };
}
