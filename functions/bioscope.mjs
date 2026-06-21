/**
 * Cloudflare Pages Function — Bioscope Live FIFA proxy (BDIX-optimized).
 *
 * PROBLEM:
 *   User's BDIX (Bangladesh Internet Exchange) connection gets black screen
 *   even when Cloudflare proxy is working globally. Root cause:
 *
 *   1. Cloudflare fetches segments from Cloudflare's global edge (not BDIX)
 *   2. BDIX users have fast local routes to bioscopelive.com (it's hosted in BD)
 *   3. Going through Cloudflare doubles the latency and may fail on BDIX
 *   4. Also: segment URLs have `?m=<token>` which can be IP-pinned (BD IP only)
 *
 * SOLUTION v2 (this file):
 *   Use a HYBRID approach:
 *     • Player hits Cloudflare for master m3u8 + sub-playlist (small files)
 *     • Cloudflare fetches AES key with JWT auth (key is tiny, IP-agnostic)
 *     • Player fetches segments DIRECTLY from bioscopelive.com (NOT proxied)
 *       — segments are public, no auth needed
 *       — BDIX user's local route to bioscopelive.com works fast
 *       — saves Cloudflare Function invocations (free tier)
 *
 *   Web browsers (CORS) note:
 *     Web browsers enforce CORS. Since bioscopelive.com does not allow CORS,
 *     direct segment loading fails in web players (like SkipTV).
 *     To solve this, use: /bioscope?proxy_segments=true
 *     This rewrites segment URLs to proxy through Cloudflare with CORS headers.
 */

const JWT = "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQiOiIxIiwianRpIjoiYzJkYjE1MjJmMDU0ZDg1Yzc3NmFmZjlkNDU2NjcxODNlNmZlNWNjYWUwYjAwNWI1OTVhMTAxY2RmNDNlYmIyY2YzMTBiZDExMTZlOTQ4YjEiLCJpYXQiOjE3ODA3OTcxMzEuNTQwNDAxLCJuYmYiOjE3ODA3OTcxMzEuNTQwNDAzLCJleHAiOjE4MTIzMzMxMzEuNTM1MDMyLCJzdWIiOiIxODAwMDA4NDg5MDA2NjUzNDQiLCJzY29wZXMiOlsibWFuYWdlX3Byb2ZpbGVzIl19.a6GUyqbwLfixROwUhNTzaYrrYBgVR6FHI_40FpjZ9l7P20WHcv-7AbEz-XPYhGnb1Q9JHAKdMA9pBY1Od2UZsYeEw6f7Myjc0VK2kqqXdagwHTlIHvHwxkoTVfpagQNiJF4ffJZ_6j87aCR6PEUEuTWQwjnLjbnvBpu0cgLUr5p56sHGm0mGV_vbIFirvZHVYwxLZGjBmo-njpfZcvuQPq5sUT3n-j4VNX4sh8tsvaAJaqlXLnq-DIGTBGNu9efsHNTiMzFUk5gEOYlWnNGewcbsuDsP3QFINeUBRzjBP9bPXjHfv5tmvKfQaExPZgFpxpWpZyQ5PZnmuxvWawNMKLBGV3qWqNPeVc1Fphhac3vloTNtMK5UP7EZtDRUQoJWra1irCMYn0ao1oEzfrtinhw038aNSe9z5EmF_tCi0XnQigVJM_XLwmgWbVxsWq92iC3HU2dHcelqMNiFk9gMleKIgGVA2sDeLfNsM0pco8656R7TySgSBycVvTyyU4_G1QVafpmPp5Lcmhi4KxVBAOAhY5iy0ZLDC4jO366wy_5yguY7sVPb6JWiUATVcBsLbvIPmgM9laQEZttxLMPHpnlPwUGljip5J61E235GXAV-WStahGaagjgja7dDRFwPVzvlMzSX9S7MpyVyRejmre60x8HvXkgCLhEfEn027YM";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const BIOSCOPE_HOME = "https://www.bioscopelive.com/en";
const FIFA_STREAM_PATTERN = /https:\/\/[a-z0-9-]+\.bioscopelive\.com\/out\/v1\/[a-f0-9]+\/index\.m3u8/;

async function fetchWithHeaders(url, extra = {}) {
    const ips = [
        "103.25.120.14",
        "103.8.16.89",
        "103.234.24.5",
        "103.112.52.20",
        "103.108.140.12",
        "103.19.252.33",
        "103.218.24.15",
        "103.86.196.50",
        "103.234.25.10"
    ];
    const index = url.length % ips.length;
    const spoofedIp = ips[index];

    return fetch(url, {
        headers: { 
            "User-Agent": UA, 
            "Accept": "*/*",
            "X-Forwarded-For": spoofedIp,
            "X-Real-IP": spoofedIp,
            ...extra 
        },
        cf: { cacheTtl: 30, cacheEverything: false },
    });
}

// Auto-discover current FIFA stream URL from bioscopelive.com homepage
async function discoverFifaStreamUrl() {
    const r = await fetchWithHeaders(BIOSCOPE_HOME, {
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
    });
    if (!r.ok) throw new Error(`homepage fetch failed: ${r.status}`);
    const html = await r.text();
    const m = html.match(FIFA_STREAM_PATTERN);
    if (!m) throw new Error("FIFA stream URL not found in bioscopelive.com homepage");
    return m[0];
}

// Fetch AES-128 key with JWT Bearer auth
async function fetchKey(keyUrl) {
    const r = await fetchWithHeaders(keyUrl, {
        "Authorization": `Bearer ${JWT}`,
        "Referer": "https://www.bioscopelive.com/",
        "Origin": "https://www.bioscopelive.com",
    });
    if (!r.ok) throw new Error(`key fetch failed: ${r.status} (JWT may have expired — see README)`);
    const buf = await r.arrayBuffer();
    return new Response(buf, {
        headers: {
            "Content-Type": "application/octet-stream",
            "Cache-Control": "public, max-age=3600",
            "Access-Control-Allow-Origin": "*",
        },
    });
}

/**
 * BDIX-OPTIMIZED m3u8 rewriter.
 */
async function proxyPlaylistBdix(upstreamUrl, proxySegments = false, origin = "") {
    const r = await fetchWithHeaders(upstreamUrl, {
        "Referer": "https://www.bioscopelive.com/",
        "Origin": "https://www.bioscopelive.com",
    });
    if (!r.ok) throw new Error(`playlist fetch failed: ${r.status}`);
    const text = await r.text();
    const ct = r.headers.get("content-type") || "application/vnd.apple.mpegurl";
    const baseDir = upstreamUrl.split("/").slice(0, -1).join("/") + "/";
    const upstreamOrigin = new URL(upstreamUrl).origin;

    const rewritten = text.split("\n").map(line => {
        const s = line.trim();
        if (!s) return "";

        // Rewrite ONLY the AES key URI (needs JWT auth from Cloudflare)
        if (s.startsWith("#EXT-X-KEY:")) {
            return line.replace(/(URI=")([^"]+)(")/, (m, p1, p2, p3) => {
                let full;
                if (p2.startsWith("http")) full = p2;
                else if (p2.startsWith("/")) full = "https://ivy.bioscopelive.com" + p2;
                else full = baseDir + p2;
                return `${p1}${origin}/bioscope?mode=key&u=${encodeURIComponent(full)}${p3}`;
            });
        }

        // Skip other comments
        if (s.startsWith("#")) return line;

        // Sub-playlists → still proxy through Cloudflare (need rewriting)
        let full;
        if (s.startsWith("http")) full = s;
        else if (s.startsWith("/")) full = upstreamOrigin + s;
        else full = baseDir + s;

        if (full.endsWith(".m3u8") || full.includes(".m3u8?")) {
            return `${origin}/bioscope?mode=m3u8&u=${encodeURIComponent(full)}${proxySegments ? '&proxy_segments=true' : ''}`;
        }

        // Segments → return ORIGINAL URL (let player fetch directly from Bioscope)
        // or proxy if proxySegments is requested (for web player/CORS compliance)
        if (proxySegments) {
            return `${origin}/bioscope?mode=seg&u=${encodeURIComponent(full)}`;
        }
        return full;
    }).join("\n");

    return new Response(rewritten, {
        headers: {
            "Content-Type": ct,
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Access-Control-Allow-Origin": "*",
        },
    });
}

export async function onRequestGet({ request }) {
    const url = new URL(request.url);
    const origin = url.origin;
    const params = url.searchParams;
    const mode = params.get("mode") || "master";
    const upstreamUrl = params.get("u");
    const proxySegments = params.get("proxy_segments") === "true";

    try {
        if (mode === "key" && upstreamUrl) {
            return await fetchKey(upstreamUrl);
        }
        if (mode === "m3u8" && upstreamUrl) {
            return await proxyPlaylistBdix(upstreamUrl, proxySegments, origin);
        }
        if (mode === "master") {
            const masterUrl = await discoverFifaStreamUrl();
            return await proxyPlaylistBdix(masterUrl, proxySegments, origin);
        }
        if (mode === "seg" && upstreamUrl) {
            const r = await fetchWithHeaders(upstreamUrl, {
                "Referer": "https://www.bioscopelive.com/",
                "Origin": "https://www.bioscopelive.com",
            });
            if (!r.ok) throw new Error(`segment fetch failed: ${r.status}`);
            return new Response(r.body, {
                headers: {
                    "Content-Type": "video/MP2T",
                    "Cache-Control": "public, max-age=300",
                    "Access-Control-Allow-Origin": "*",
                },
            });
        }
        return new Response(
            `Bioscope Proxy (BDIX-optimized v2)\n` +
            `==================================\n\n` +
            `Usage:\n` +
            `  /bioscope                          — auto-discover FIFA stream, return rewritten m3u8 (BDIX-direct segments)\n` +
            `  /bioscope?proxy_segments=true       — auto-discover, rewrite segments to proxy (CORS-compliant for web)\n` +
            `  /bioscope?mode=m3u8&u=<url>         — proxy a sub-playlist\n` +
            `  /bioscope?mode=key&u=<url>          — fetch AES-128 key with JWT auth\n  /bioscope?mode=seg&u=<url>          — proxy a segment (with CORS allowed)\n\n` +
            `In your .m3u8 playlist, just use:\n` +
            `  https://<your-project>.pages.dev/bioscope\n`,
            { headers: { "Content-Type": "text/plain" } }
        );
    } catch (e) {
        return new Response(
            `bioscope proxy error: ${e.message}\n\n` +
            `If JWT expired, get a new one from bioscopelive.com DevTools.`,
            { status: 502, headers: { "Content-Type": "text/plain" } }
        );
    }
}

export async function onRequestHead() {
    // Shaka Player sends HEAD requests to probe stream URLs.
    // Return 200 with appropriate headers so Shaka knows the endpoint exists.
    return new Response(null, {
        headers: {
            "Content-Type": "application/vnd.apple.mpegurl",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        },
    });
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
