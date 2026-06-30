/**
 * Cloudflare Pages Function — Toffee Live token auto-refresh proxy.
 *
 * FIXED: Now extracts FRESH token on every request from fifalive.click/play.
 * The user's previous playlist had a hardcoded URL WITHOUT `?hdntl=...` token,
 * which is why Toffee stopped playing.
 *
 * Deploy: push this file to `functions/toffee.mjs` in your Cloudflare Pages repo.
 * Endpoint: https://<your-project>.pages.dev/toffee
 *
 * Usage in .m3u8 playlist:
 *   #EXTINF:-1,Toffee Live FIFA
 *   https://<your-project>.pages.dev/toffee?mode=proxy&target=toffee
 *
 * Available targets:
 *   • toffee               — Toffee Live FIFA (auto-extract fresh token)
 *   • online24             — online24 stream (auto-extract from fifalive.click)
 *   • streamhost-<N>       — direct streamhost slot #N (no token needed)
 *   • thebosstv-<slug>     — thebosstv.com channel (Somoy-TV, Jamuna-TV, etc.)
 *   • fox-usa              — Fox USA stream (from fifalive.click Pages.dev)
 *   • fox4k-usa            — Fox 4K USA stream (from fifalive.click Pages.dev)
 *
 * The function fetches a fresh upstream URL on every request, so tokens
 * never expire in the playlist.
 */

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Extractors — each fetches fifalive.click/play and extracts a URL by regex
const EXTRACTORS = {
  "toffee": {
    source: "https://fifalive.click/",
    pattern: /https:\/\/prod-cdn\d+-live\.toffeelive\.com\/live\/[A-Za-z0-9\-]+\/\d+\/master_\d+\.m3u8\?hdntl=[^"'\s<>]+/,
    fallbackPattern: /https:\/\/tahmidx\.[A-Za-z0-9\-]+\.workers\.dev[^\s"']*/,
    needsReferer: true,
    referer: "https://fifalive.click/",
  },
  "toffee-cdn": {
    source: "https://fifalive.click/",
    pattern: /https:\/\/prod-cdn\d+-live\.toffeelive\.com\/live\/[A-Za-z0-9\-]+\/\d+\/master_\d+\.m3u8\?hdntl=[^"'\s<>]+/,
    needsReferer: true,
    referer: "https://fifalive.click/",
  },
  "toffee-wurl": {
    source: "https://fifalive.click/",
    pattern: /https:\/\/[a-z0-9]+\.wurl\.com\/manifest\/[^"'\s<>]+/,
    needsReferer: false,
    referer: "https://fifalive.click/",
  },
  "toffee-streamhost": {
    source: "https://fifalive.click/",
    pattern: /https:\/\/1nyaler\.streamhostingcdn\.top\/stream\/\d+\/index\.m3u8/,
    needsReferer: false,
    referer: "https://fifalive.click/",
  },
  "online24": {
    source: "https://fifalive.click/",
    pattern: /https:\/\/ua\.online24\.pm\/play\/[^"'\s<>]+\.m3u8/,
    needsReferer: true,
    referer: "https://fifalive.click/",
  },
  "fox-usa": {
    source: "https://fifalive.click/",
    pattern: /https:\/\/[^"'\s<>]+\/fox-sports-1\.m3u8/,
    needsReferer: false,
    referer: "https://fifalive.click/",
  },
  "fox4k-usa": {
    source: "https://fifalive.click/",
    pattern: /https:\/\/[^"'\s<>]+\/fox4k-usa\.m3u8/,
    needsReferer: false,
    referer: "https://fifalive.click/",
  },
};

// Direct URL builders (no extraction needed)
const BOSS_TV_SLUGS = {
  "thebosstv-somoy": "Somoy-TV",
  "thebosstv-jamuna": "Jamuna-TV",
  "thebosstv-aakash": "AAKAASH-AATH",
  "thebosstv-ruposhi": "Ruposhi-Bangla",
};

function getStreamhostUrl(slot) {
  return `https://1nyaler.streamhostingcdn.top/stream/${slot}/index.m3u8`;
}

function getBosstvUrl(slug) {
  return `https://live.thebosstv.com:30443/dwlive/${slug}/playlist.m3u8`;
}

async function extractFreshUrl(sourceUrl, pattern, fallbackPattern = null) {
  const r = await fetch(sourceUrl, {
    headers: { "User-Agent": UA },
    cf: { cacheTtl: 30, cacheEverything: false },
  });
  if (!r.ok) throw new Error(`source fetch failed: ${r.status}`);
  const html = await r.text();
  let m = html.match(pattern);
  if (!m && fallbackPattern) {
    m = html.match(fallbackPattern);
  }
  if (!m) throw new Error("pattern not found in source page");
  return m[0];
}

async function proxyM3u8(upstreamUrl, referer, origin) {
  const r = await fetch(upstreamUrl, {
    headers: {
      "User-Agent": UA,
      "Referer": referer,
      "Origin": new URL(referer).origin,
    },
    cf: { cacheTtl: 15, cacheEverything: false },
  });
  if (!r.ok) throw new Error(`upstream fetch failed: ${r.status}`);
  const text = await r.text();
  const ct = r.headers.get("content-type") || "application/vnd.apple.mpegurl";

  // Rewrite relative URLs so segments also route through this proxy
  const baseDir = upstreamUrl.split("/").slice(0, -1).join("/") + "/";
  const upstreamOrigin = new URL(upstreamUrl).origin;
  const rewritten = text.split("\n").map(line => {
    const s = line.trim();
    if (!s) return "";
    if (s.startsWith("#")) {
      // Rewrite URI="..." in #EXT-X-KEY lines (for AES-128 encrypted streams)
      return line.replace(/(URI=")([^"]+)(")/g, (m, p1, p2, p3) => {
        let full;
        if (p2.startsWith("http")) full = p2;
        else if (p2.startsWith("/")) full = upstreamOrigin + p2;
        else full = baseDir + p2;
        return `${p1}${origin}/toffee?mode=key&u=${encodeURIComponent(full)}&r=${encodeURIComponent(referer)}${p3}`;
      });
    }
    let full;
    if (s.startsWith("http")) full = s;
    else if (s.startsWith("/")) full = upstreamOrigin + s;
    else full = baseDir + s;
    return `${origin}/toffee?mode=seg&u=${encodeURIComponent(full)}&r=${encodeURIComponent(referer)}`;
  }).join("\n");

  return new Response(rewritten, {
    headers: {
      "Content-Type": ct,
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

async function proxySegment(segUrl, referer) {
  const r = await fetch(segUrl, {
    headers: {
      "User-Agent": UA,
      "Referer": referer,
      "Origin": new URL(referer).origin,
    },
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!r.ok) throw new Error(`segment fetch failed: ${r.status}`);
  const ct = r.headers.get("content-type") || "video/mp2t";
  return new Response(r.body, {
    headers: {
      "Content-Type": ct,
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

async function proxyKey(keyUrl, referer) {
  // For AES-128 keys on streams that need auth (e.g., Bioscope ivy.bioscopelive.com)
  // Most streamhost streams don't need this — keys are public.
  const r = await fetch(keyUrl, {
    headers: {
      "User-Agent": UA,
      "Referer": referer,
      "Origin": new URL(referer).origin,
    },
    cf: { cacheTtl: 3600, cacheEverything: true },
  });
  if (!r.ok) throw new Error(`key fetch failed: ${r.status}`);
  const buf = await r.arrayBuffer();
  return new Response(buf, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const origin = url.origin;
  const params = url.searchParams;
  const mode = params.get("mode") || "proxy";
  const target = params.get("target") || "toffee";
  const segUrl = params.get("u");
  const segReferer = params.get("r");

  // Segment / key proxy mode
  if (mode === "seg" && segUrl) {
    try {
      return await proxySegment(segUrl, segReferer || "https://fifalive.click/");
    } catch (e) {
      return new Response(`segment proxy error: ${e.message}`, { status: 502 });
    }
  }
  if (mode === "key" && segUrl) {
    try {
      return await proxyKey(segUrl, segReferer || "https://fifalive.click/");
    } catch (e) {
      return new Response(`key proxy error: ${e.message}`, { status: 502 });
    }
  }

  // Resolve target → upstream URL
  let upstreamUrl;
  let referer = "https://fifalive.click/";

  if (target.startsWith("streamhost-")) {
    const slot = target.split("-")[1];
    upstreamUrl = getStreamhostUrl(slot);
  } else if (target.startsWith("thebosstv-")) {
    const slug = BOSS_TV_SLUGS[target];
    if (!slug) return new Response(`unknown thebosstv target: ${target}`, { status: 400 });
    upstreamUrl = getBosstvUrl(slug);
  } else if (EXTRACTORS[target]) {
    const cfg = EXTRACTORS[target];
    try {
      upstreamUrl = await extractFreshUrl(cfg.source, cfg.pattern, cfg.fallbackPattern);
      if (cfg.needsReferer) referer = cfg.referer;
    } catch (e) {
      return new Response(`extract error: ${e.message}`, { status: 502 });
    }
  } else {
    return new Response(
      `unknown target: ${target}\n\nAvailable targets:\n` +
      Object.keys(EXTRACTORS).map(t => `  • ${t}`).join("\n") +
      `\n  • streamhost-<N>     (e.g., streamhost-89 for TVP Sport)\n` +
      `  • thebosstv-<slug>   (${Object.keys(BOSS_TV_SLUGS).map(k => k.replace("thebosstv-","")).join(", ")})\n`,
      { status: 400, headers: { "Content-Type": "text/plain" } }
    );
  }

  // Redirect mode — just send 302 to upstream (player needs its own Referer support)
  if (mode === "redirect") {
    return Response.redirect(upstreamUrl, 302);
  }

  // Proxy mode — fetch with Referer, rewrite URLs, return m3u8
  try {
    return await proxyM3u8(upstreamUrl, referer, origin);
  } catch (e) {
    return new Response(`proxy error: ${e.message}\n\nupstream: ${upstreamUrl}`, { status: 502 });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    },
  });
}
