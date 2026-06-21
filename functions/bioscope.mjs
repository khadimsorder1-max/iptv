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
 *   Player → Cloudflare for m3u8 + key only (tiny requests, 1-2 KB each)
 *   Player → bioscopelive.com directly for segments (2 MB each, BDIX-fast)
 *
 * ALTERNATIVE if still fails:
 *   Use the local_proxy.py script in the same directory — runs on user's
 *   own machine (PC/Termux), so all requests come from the same IP.
 */

const JWT = "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQiOiIxIiwianRpIjoiYzJkYjE1MjJmMDU0ZDg1Yzc3NmFmZjlkNDU2NjcxODNlNmZlNWNjYWUwYjAwNWI1OTVhMTAxY2RmNDNlYmIyY2YzMTBiZDExMTZlOTQ4YjEiLCJpYXQiOjE3ODA3OTcxMzEuNTQwNDAxLCJuYmYiOjE3ODA3OTcxMzEuNTQwNDAzLCJleHAiOjE4MTIzMzMxMzEuNTM1MDMyLCJzdWIiOiIxODAwMDA4NDg5MDA2NjUzNDQiLCJzY29wZXMiOlsibWFuYWdlX3Byb2ZpbGVzIl19.a6GUyqbwLfixROwUhNTzaYrrYBgVR6FHI_40FpjZ9l7P20WHcv-7AbEz-XPYhGnb1Q9JHAKdMA9pBY1Od2UZsYeEw6f7Myjc0VK2kqqXdagwHTlIHvHwxkoTVfpagQNiJF4ffJZ_6j87aCR6PEUEuTWQwjnLjbnvBpu0cgLUr5p56sHGm0mGV_vbIFirvZHVYwxLZGjBmo-njpfZcvuQPq5sUT3n-j4VNX4sh8tsvaAJaqlXLnq-DIGTBGNu9efsHNTiMzFUk5gEOYlWnNGewcbsuDsP3QFINeUBRzjBP9bPXjHfv5tmvKfQaExPZgFpxpWpZyQ5PZnmuxvWawNMKLBGV3qWqNPeVc1Fphhac3vloTNtMK5UP7EZtDRUQoJWra1irCMYn0ao1oEzfrtinhw038aNSe9z5EmF_tCi0XnQigVJM_XLwmgWbVxsWq92iC3HU2dHcelqMNiFk9gMleKIgGVA2sDeLfNsM0pco8656R7TySgSBycVvTyyU4_G1QVafpmPp5Lcmhi4KxVBAOAhY5iy0ZLDC4jO366wy_5yguY7sVPb6JWiUATVcBsLbvIPmgM9laQEZttxLMPHpnlPwUGljip5J61E235GXAV-WStahGaagjgja7dDRFwPVzvlMzSX9S7MpyVyRejmre60x8HvXkgCLhEfEn027YM";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const BIOSCOPE_HOME = "https://www.bioscopelive.com/en";
const FIFA_STREAM_PATTERN = /https:\/\/[a-z0-9-]+\.bioscopelive\.com\/out\/v1\/[a-f0-9]+\/index\.m3u8/;

async function fetchWithHeaders(url, extra = {}) {
    return fetch(url, {
        headers: { "User-Agent": UA, "Accept": "*/*", ...extra },
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
 *
 * For sub-playlists:
 *   • Rewrite #EXT-X-KEY URI → /bioscope?mode=key&u=... (JWT auth needed)
 *   • LEAVE segment URLs AS-IS (pointing to bioscopelive.com directly)
 *     — segments are public (no auth needed)
 *     — BDIX users have fast direct route to bioscopelive.com
 *     — avoids Cloudflare becoming bottleneck for 2MB segment downloads
 */
async function proxyPlaylistBdix(upstreamUrl) {
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
                return `${p1}/bioscope?mode=key&u=${encodeURIComponent(full)}${p3}`;
            });
        }

        // Skip other comments
        if (s.startsWith("#")) return line;

        // Sub-playlists → still proxy through Cloudflare (need rewriting)
        // (these are tiny files, no BDIX benefit)
        let full;
        if (s.startsWith("http")) full = s;
        else if (s.startsWith("/")) full = upstreamOrigin + s;
        else full = baseDir + s;

        if (full.endsWith(".m3u8") || full.includes(".m3u8?")) {
            return `/bioscope?mode=m3u8&u=${encodeURIComponent(full)}`;
        }

        // Segments → return ORIGINAL URL (let player fetch directly from Bioscope)
        // This is the key BDIX optimization — segments bypass Cloudflare entirely.
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
    const params = url.searchParams;
    const mode = params.get("mode") || "master";
    const upstreamUrl = params.get("u");

    try {
        if (mode === "key" && upstreamUrl) {
            return await fetchKey(upstreamUrl);
        }
        if (mode === "m3u8" && upstreamUrl) {
            return await proxyPlaylistBdix(upstreamUrl);
        }
        if (mode === "master") {
            const masterUrl = await discoverFifaStreamUrl();
            return await proxyPlaylistBdix(masterUrl);
        }
        // Legacy seg mode — proxy if someone still uses it
        if (mode === "seg" && upstreamUrl) {
            const r = await fetchWithHeaders(upstreamUrl, {
                "Referer": "https://www.bioscopelive.com/",
                "Origin": "https://www.bioscopelive.com",
            });
            if (!r.ok) throw new Error(`segment fetch failed: ${r.status}`);
            return new Response(await r.arrayBuffer(), {
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
            `  /bioscope                  — auto-discover FIFA stream, return rewritten m3u8\n` +
            `  /bioscope?mode=m3u8&u=<url>— proxy a sub-playlist\n` +
            `  /bioscope?mode=key&u=<url> — fetch AES-128 key with JWT auth\n\n` +
            `BDIX optimization:\n` +
            `  • Master + sub-playlists go through Cloudflare (tiny files)\n` +
            `  • AES key goes through Cloudflare (needs JWT, tiny)\n` +
            `  • SEGMENTS go DIRECTLY from bioscopelive.com to player (BDIX-fast)\n\n` +
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
