/**
 * Cloudflare Pages Function — Bioscope Live FIFA proxy with AES-128 key auth.
 *
 * FIXED in this version:
 *   1. Auto-discover current FIFA stream URL from bioscopelive.com homepage
 *      (no hardcoded stream ID — works even when match changes)
 *   2. Dynamic AES key URL rewriting (key path changes from match to match,
 *      e.g., /4zo6tUNS → /feVs66fL → ... — proxy handles whatever is in m3u8)
 *   3. Better JWT handling — key endpoint requires Authorization: Bearer
 *
 * WHY BIOSCOPE WASN'T PLAYING:
 *   • Stream is AES-128 encrypted
 *   • Key URL: https://ivy.bioscopelive.com/<dynamic-path>
 *   • Key endpoint requires JWT Bearer token (Authorization header)
 *   • Players (VLC, MX, OTT Navigator) can't send custom auth headers
 *   • Without key, segments download (consuming MB) but can't decrypt → black screen
 *
 * SOLUTION:
 *   This function proxies everything:
 *     1. GET /bioscope → fetch bioscopelive.com homepage → extract FIFA stream URL
 *     2. Fetch master m3u8 → rewrite sub-playlist URLs through /bioscope
 *     3. Fetch sub-playlist → rewrite #EXT-X-KEY URI to /bioscope?mode=key
 *     4. GET /bioscope?mode=key&u=<key_url> → fetch key WITH JWT Bearer
 *     5. GET /bioscope?mode=seg&u=<seg_url> → proxy segment
 *
 * JWT TOKEN:
 *   Token below is valid until ~June 2027 (exp=1812333131).
 *   If it expires, get a new one:
 *     1. Open https://www.bioscopelive.com in browser
 *     2. DevTools → Network → click any api-dynamic.bioscopelive.com request
 *     3. Copy Authorization: Bearer ... header value
 *     4. Paste below as JWT
 *
 * Deploy: push to `functions/bioscope.mjs` in your Cloudflare Pages repo.
 * Endpoint: https://<your-project>.pages.dev/bioscope
 */

const JWT = "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQiOiIxIiwianRpIjoiYzJkYjE1MjJmMDU0ZDg1Yzc3NmFmZjlkNDU2NjcxODNlNmZlNWNjYWUwYjAwNWI1OTVhMTAxY2RmNDNlYmIyY2YzMTBiZDExMTZlOTQ4YjEiLCJpYXQiOjE3ODA3OTcxMzEuNTQwNDAxLCJuYmYiOjE3ODA3OTcxMzEuNTQwNDAzLCJleHAiOjE4MTIzMzMxMzEuNTM1MDMyLCJzdWIiOiIxODAwMDA4NDg5MDA2NjUzNDQiLCJzY29wZXMiOlsibWFuYWdlX3Byb2ZpbGVzIl19.a6GUyqbwLfixROwUhNTzaYrrYBgVR6FHI_40FpjZ9l7P20WHcv-7AbEz-XPYhGnb1Q9JHAKdMA9pBY1Od2UZsYeEw6f7Myjc0VK2kqqXdagwHTlIHvHwxkoTVfpagQNiJF4ffJZ_6j87aCR6PEUEuTWQwjnLjbnvBpu0cgLUr5p56sHGm0mGV_vbIFirvZHVYwxLZGjBmo-njpfZcvuQPq5sUT3n-j4VNX4sh8tsvaAJaqlXLnq-DIGTBGNu9efsHNTiMzFUk5gEOYlWnNGewcbsuDsP3QFINeUBRzjBP9bPXjHfv5tmvKfQaExPZgFpxpWpZyQ5PZnmuxvWawNMKLBGV3qWqNPeVc1Fphhac3vloTNtMK5UP7EZtDRUQoJWra1irCMYn0ao1oEzfrtinhw038aNSe9z5EmF_tCi0XnQigVJM_XLwmgWbVxsWq92iC3HU2dHcelqMNiFk9gMleKIgGVA2sDeLfNsM0pco8656R7TySgSBycVvTyyU4_G1QVafpmPp5Lcmhi4KxVBAOAhY5iy0ZLDC4jO366wy_5yguY7sVPb6JWiUATVcBsLbvIPmgM9laQEZttxLMPHpnlPwUGljip5J61E235GXAV-WStahGaagjgja7dDRFwPVzvlMzSX9S7MpyVyRejmre60x8HvXkgCLhEfEn027YM";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Homepage — we scrape this to find current FIFA stream URL
const BIOSCOPE_HOME = "https://www.bioscopelive.com/en";

// Regex to find Bioscope FIFA stream URL in homepage HTML
// Matches URLs like: https://fifa-stream-XX.bioscopelive.com/out/v1/<hex>/index.m3u8
const FIFA_STREAM_PATTERN = /https:\/\/[a-z0-9-]+\.bioscopelive\.com\/out\/v1\/[a-f0-9]+\/index\.m3u8/;

async function fetchWithHeaders(url, extra = {}) {
    return fetch(url, {
        headers: {
            "User-Agent": UA,
            "Accept": "*/*",
            ...extra,
        },
        cf: { cacheTtl: 30, cacheEverything: false },
    });
}

// Discover current FIFA stream URL by scraping bioscopelive.com homepage
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

// Fetch the AES-128 decryption key with JWT
async function fetchKey(keyUrl) {
    const r = await fetchWithHeaders(keyUrl, {
        "Authorization": `Bearer ${JWT}`,
        "Referer": "https://www.bioscopelive.com/",
        "Origin": "https://www.bioscopelive.com",
    });
    if (!r.ok) throw new Error(`key fetch failed: ${r.status} (JWT may have expired)`);
    const buf = await r.arrayBuffer();
    return new Response(buf, {
        headers: {
            "Content-Type": "application/octet-stream",
            "Cache-Control": "public, max-age=3600",
            "Access-Control-Allow-Origin": "*",
        },
    });
}

// Fetch and rewrite m3u8 playlist
async function proxyPlaylist(upstreamUrl) {
    const r = await fetchWithHeaders(upstreamUrl, {
        "Referer": "https://www.bioscopelive.com/",
        "Origin": "https://www.bioscopelive.com",
    });
    if (!r.ok) throw new Error(`playlist fetch failed: ${r.status}`);
    const text = await r.text();
    const ct = r.headers.get("content-type") || "application/vnd.apple.mpegurl";
    const baseDir = upstreamUrl.split("/").slice(0, -1).join("/") + "/";

    const rewritten = text.split("\n").map(line => {
        const s = line.trim();
        if (!s) return "";

        // Handle #EXT-X-KEY:URI="..." — rewrite to point to our key proxy
        // (key path changes per match — we dynamically rewrite whatever is there)
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

        // URL line — could be sub-playlist (index_1.m3u8) or segment (index_1_X.ts?m=...)
        let full;
        if (s.startsWith("http")) full = s;
        else if (s.startsWith("/")) full = "https://fifa-stream-01.bioscopelive.com" + s;
        else full = baseDir + s;

        if (full.endsWith(".m3u8") || full.includes(".m3u8?")) {
            return `/bioscope?mode=m3u8&u=${encodeURIComponent(full)}`;
        } else {
            return full;
        }
    }).join("\n");

    return new Response(rewritten, {
        headers: {
            "Content-Type": ct,
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Access-Control-Allow-Origin": "*",
        },
    });
}

// Proxy a segment
async function proxySegment(segUrl) {
    const r = await fetchWithHeaders(segUrl, {
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
            return await proxyPlaylist(upstreamUrl);
        }
        if (mode === "seg" && upstreamUrl) {
            return await proxySegment(upstreamUrl);
        }
        if (mode === "master") {
            // Auto-discover current FIFA stream URL
            const masterUrl = await discoverFifaStreamUrl();
            return await proxyPlaylist(masterUrl);
        }
        return new Response(
            `Bioscope Proxy\n` +
            `=============\n\n` +
            `Usage:\n` +
            `  /bioscope                  — auto-discover FIFA stream + proxy\n` +
            `  /bioscope?mode=m3u8&u=<url>— proxy a specific m3u8 playlist\n` +
            `  /bioscope?mode=seg&u=<url> — proxy a segment\n` +
            `  /bioscope?mode=key&u=<url> — fetch AES-128 key with JWT auth\n\n` +
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
