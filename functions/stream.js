/**
 * Cloudflare Pages Function - Streamed.pk/strmd.st Referrer and CORS Bypass Proxy
 *
 * This function receives a target stream or segment URL and fetches it with 
 * a spoofed 'Referer: https://embed.st/' header to bypass strmd.st checks.
 * It also rewrites URLs in manifest files to ensure segments are fetched via proxy.
 *
 * Endpoint: /stream
 * Parameters:
 *   - u: target stream or segment URL (urlencoded)
 *   - mode: 'proxy' (for manifest) or 'seg' (for video segments)
 *   - r: referer to use (defaults to https://embed.st/)
 */

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const DEFAULT_REFERER = "https://embed.st/";

async function proxyM3u8(upstreamUrl, referer, origin) {
  const r = await fetch(upstreamUrl, {
    headers: {
      "User-Agent": UA,
      "Referer": referer,
      "Origin": new URL(referer).origin,
    },
    cf: { cacheTtl: 10, cacheEverything: false },
  });
  
  if (!r.ok) {
    throw new Error(`Upstream fetch failed: ${r.status}`);
  }
  
  const text = await r.text();
  const contentType = r.headers.get("content-type") || "application/vnd.apple.mpegurl";

  const baseDir = upstreamUrl.split("/").slice(0, -1).join("/") + "/";
  const upstreamOrigin = new URL(upstreamUrl).origin;
  
  const rewritten = text.split("\n").map(line => {
    const s = line.trim();
    if (!s) return "";
    if (s.startsWith("#")) {
      // Rewrite key URI if present
      return line.replace(/(URI=")([^"]+)(")/g, (m, p1, p2, p3) => {
        let full;
        if (p2.startsWith("http")) full = p2;
        else if (p2.startsWith("/")) full = upstreamOrigin + p2;
        else full = baseDir + p2;
        return `${p1}${origin}/stream?mode=key&u=${encodeURIComponent(full)}&r=${encodeURIComponent(referer)}${p3}`;
      });
    }
    
    let full;
    if (s.startsWith("http")) full = s;
    else if (s.startsWith("/")) full = upstreamOrigin + s;
    else full = baseDir + s;
    return `${origin}/stream?mode=seg&u=${encodeURIComponent(full)}&r=${encodeURIComponent(referer)}`;
  }).join("\n");

  return new Response(rewritten, {
    headers: {
      "Content-Type": contentType,
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
    cf: { cacheTtl: 180, cacheEverything: true },
  });
  
  if (!r.ok) {
    throw new Error(`Segment fetch failed: ${r.status}`);
  }
  
  const contentType = r.headers.get("content-type") || "video/mp2t";
  return new Response(r.body, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=180",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const origin = url.origin;
  const params = url.searchParams;
  
  const targetUrl = params.get("u");
  const mode = params.get("mode") || "proxy";
  const referer = params.get("r") || DEFAULT_REFERER;

  if (!targetUrl) {
    return new Response(
      "Streamed.pk Bypass Proxy Active.\n\nUsage: /stream?u=ENCODED_STREAM_URL", 
      { 
        status: 200, 
        headers: { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" } 
      }
    );
  }

  const decodedUrl = decodeURIComponent(targetUrl);

  try {
    if (mode === "seg") {
      return await proxySegment(decodedUrl, referer);
    } else {
      return await proxyM3u8(decodedUrl, referer, origin);
    }
  } catch (e) {
    return new Response(`Bypass Proxy Error: ${e.message}`, { status: 502, headers: { "Access-Control-Allow-Origin": "*" } });
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
