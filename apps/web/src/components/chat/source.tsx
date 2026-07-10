import { Globe } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Shared source-card link primitives (plan 58.6.4 D7), deduped out of web_search / web_fetch / docs:
 * the www-stripped `prettyUrl`, the same-origin favicon derivation, and the `SourceFavicon` /
 * `SourceUrl` renderers. Keeping one copy means the favicon, its fallback, and the truncation behave
 * identically on every web source row.
 *
 * Responsible for: the source-card hostname line + its lazy same-origin favicon and globe fallback.
 * Not for: source-recall rows (local file paths, no URL - deliberately excluded).
 */

/** Hostname + path, www-stripped, for the subdued source link line under a title. */
export function prettyUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === "/" ? "" : u.pathname;
    return `${u.hostname.replace(/^www\./u, "")}${path}${u.search}`;
  } catch {
    return url;
  }
}

/**
 * The site's own `/favicon.ico` for a URL, or null when the URL can't be parsed or isn't http(s) (a
 * file:/data: source has no site icon). Deliberately SAME-ORIGIN only - no third-party favicon
 * aggregator - so rendering a cited source never leaks the browsed domain to a favicon provider
 * (D-004). The request rides `referrerPolicy="no-referrer"` at the img.
 */
export function faviconUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return null;
    }
    return `${u.origin}/favicon.ico`;
  } catch {
    return null;
  }
}

/** Rendered favicon edge (px): matches the adjacent xs hostname text. */
const FAVICON_SIZE = 14;

/**
 * The site favicon for a source card: a lazy, no-referrer `<img>` from the site's own `/favicon.ico`,
 * falling back to a neutral globe the instant it fails to load - so a source row never shows a
 * broken-image icon (mirrors ArtifactThumb's `broken` fallback). A non-web URL (no derivable favicon)
 * renders the globe directly.
 */
export function SourceFavicon({ url, className }: { url: string; className?: string }) {
  const [broken, setBroken] = useState(false);
  const src = faviconUrl(url);
  if (!src || broken) {
    return (
      <Globe
        aria-hidden
        className={className}
        style={{ width: FAVICON_SIZE, height: FAVICON_SIZE }}
      />
    );
  }
  return (
    <img
      src={src}
      alt=""
      aria-hidden
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
      width={FAVICON_SIZE}
      height={FAVICON_SIZE}
      className={className}
      style={{ width: FAVICON_SIZE, height: FAVICON_SIZE, borderRadius: 2, objectFit: "contain" }}
    />
  );
}

/**
 * The subdued hostname line for a source card: the site favicon beside the www-stripped hostname/path,
 * truncated. Shared across the web_search / web_fetch / docs source rows so the favicon + fallback +
 * truncation stay identical everywhere.
 */
export function SourceUrl({ url, className }: { url: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 text-xs text-smui-frost-3/80",
        className,
      )}
    >
      <SourceFavicon url={url} className="shrink-0 text-muted-foreground/70" />
      <span className="truncate">{prettyUrl(url)}</span>
    </span>
  );
}
