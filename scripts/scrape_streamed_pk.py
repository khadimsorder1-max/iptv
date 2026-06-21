import re
import urllib.request
import urllib.parse
from playwright.sync_api import sync_playwright
import time
import os

STREAMED_PK_HOME = 'https://streamed.pk'
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

# Non-football keywords to filter out
SKIP_KEYWORDS = [
    'braves', 'brewers', 'tigers', 'white-sox', 'yankees', 'reds',
    'marlins', 'giants', 'rays', 'nationals', 'atp', 'wta', 'halle',
    'darts', 'rhein-fire', 'berlin-thunder', 'british-gt',
    'st-helens', 'huddersfield', 'us-open-championship', 'pdc',
    'slovak-darts', 'miami', 'cincinnati', 'phillies', 'astros',
    'rangers', 'twins', 'royals', 'tottenham', 'athletics',
    'guardians', 'padres', 'rockies', 'dodgers', 'diamondbacks',
    'cardinals', 'pirates', 'cubs', 'red-sox', 'blue-jays',
    'orioles', 'angels', 'mariners', 'astros', 'baseball', 'tennis',
    'golf', 'f1', 'formula', 'nascar', 'ufc', 'boxing', 'cricket'
]

def fetch_html(url):
    req = urllib.request.Request(
        url, 
        headers={'User-Agent': UA}
    )
    with urllib.request.urlopen(req, timeout=15) as response:
        return response.read().decode('utf-8', errors='ignore')

def is_football(slug):
    slug_lower = slug.lower()
    return not any(keyword in slug_lower for keyword in SKIP_KEYWORDS)

def clean_title(slug):
    # e.g., spain-vs-saudi-arabia -> Spain Vs Saudi Arabia
    words = slug.replace('-', ' ').split()
    return ' '.join(w.capitalize() for w in words)

def extract_match_slugs():
    print("Fetching homepage match slugs...")
    html = fetch_html(STREAMED_PK_HOME)
    seen = set()
    slugs = []
    # Find all /watch/<slug> links
    for m in re.finditer(r'/watch/([a-z0-9-]+)', html):
        slug = m.group(1)
        if slug not in seen and is_football(slug):
            seen.add(slug)
            slugs.push(slug) if hasattr(slugs, 'push') else slugs.append(slug)
    print(f"Found {len(slugs)} football matches.")
    return slugs

def extract_sources_from_page(slug):
    url = f"{STREAMED_PK_HOME}/watch/{slug}"
    print(f"Fetching match page: {url}")
    html = fetch_html(url)
    
    # Next.js payload format can contain varied quotes/spaces:
    # e.g., {"source":"admin","id":"ppv-spain-vs-saudi-arabia"} or {source:"admin", id:"ppv-spain-vs-saudi-arabia"}
    sources = []
    seen = set()
    
    # Format 1: JSON/quoted keys with flexible spacing and single/double quotes
    # {"source": "admin", "id": "ppv-spain-vs-saudi-arabia"}
    matches1 = re.finditer(r'\{["\']source["\']\s*:\s*["\']([^"\']+)["\']\s*,\s*["\']id["\']\s*:\s*["\']([^"\']+)["\']\}', html)
    for m in matches1:
        source, stream_id = m.group(1), m.group(2)
        key = (source, stream_id)
        if key not in seen:
            seen.add(key)
            sources.append({"source": source, "id": stream_id})

    # Format 2: Standard javascript objects with unquoted keys
    # {source: "admin", id: "ppv-spain-vs-saudi-arabia"}
    matches2 = re.finditer(r'\{\s*source\s*:\s*["\']([^"\']+)["\']\s*,\s*id\s*:\s*["\']([^"\']+)["\']\s*\}', html)
    for m in matches2:
        source, stream_id = m.group(1), m.group(2)
        key = (source, stream_id)
        if key not in seen:
            seen.add(key)
            sources.append({"source": source, "id": stream_id})
            
    print(f"Extracted {len(sources)} sources for match {slug}")
    return sources

def capture_m3u8(embed_url):
    m3u8_url = None
    
    with sync_playwright() as p:
        # Launch chromium browser
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(user_agent=UA)
        page = context.new_page()
        
        # Route logic to intercept network requests
        def handle_request(request):
            nonlocal m3u8_url
            url = request.url
            if '.m3u8' in url and 'strmd.st' in url:
                print(f"Captured HLS Stream: {url}")
                m3u8_url = url
        
        page.on("request", handle_request)
        
        try:
            print(f"Loading embed page in browser: {embed_url}")
            page.goto(embed_url, wait_until="domcontentloaded", timeout=30000)
            
            # Wait a few seconds for player scripts to run and trigger request
            start_time = time.time()
            while time.time() - start_time < 8:
                if m3u8_url:
                    break
                page.wait_for_timeout(500)
        except Exception as e:
            print(f"Error loading embed page {embed_url}: {e}")
        finally:
            browser.close()
            
    return m3u8_url

def main():
    slugs = extract_match_slugs()
    # Limit to top 8 matches to run within Github Action limit
    slugs = slugs[:8]
    
    playlist_entries = []
    
    for slug in slugs:
        title = clean_title(slug)
        try:
            sources = extract_sources_from_page(slug)
            for source_info in sources:
                source = source_info["source"]
                stream_id = source_info["id"]
                embed_url = f"https://embed.st/embed/{source}/{stream_id}/1"
                
                print(f"Scanning stream for {title} (Source: {source})...")
                m3u8_url = capture_m3u8(embed_url)
                
                if m3u8_url:
                    entry = {
                        "title": title,
                        "slug": slug,
                        "source": source,
                        "embed_url": embed_url,
                        "m3u8_url": m3u8_url
                    }
                    playlist_entries.append(entry)
                    print(f"Successfully added stream for {title} ({source})")
                else:
                    print(f"Failed to capture .m3u8 for {title} ({source})")
                
                # Sleep between requests to avoid overloading or get rate-limited
                time.sleep(2)
        except Exception as e:
            print(f"Failed to scrape match {slug}: {e}")
            
    # Write entries to streamed_pk_live.m3u8
    playlist_path = "streamed_pk_live.m3u8"
    print(f"Writing {len(playlist_entries)} entries to {playlist_path}...")
    
    with open(playlist_path, "w", encoding="utf-8") as f:
        f.write("#EXTM3U\n")
        f.write("#EXT-X-VERSION:3\n")
        f.write(f"# Streamed.pk live football matches — built {time.strftime('%Y-%m-%dT%H:%M:%S+00:00', time.gmtime())}\n")
        f.write(f"# {len(playlist_entries)} streams captured from {len(set(e['slug'] for e in playlist_entries))} matches\n\n")
        
        for e in playlist_entries:
            # Clean title formatting
            # Spain Vs Saudi Arabia 2391756 — admin -> Spain Vs Saudi Arabia — admin
            tvg_name = f"{e['title']} — {e['source']}"
            tvg_id = tvg_name.replace(' ', '_').replace('—', '—')
            f.write(f'#EXTINF:-1 tvg-name="{tvg_name}" tvg-id="{tvg_id}" group-title="Streamed.pk Live Football",{tvg_name}\n')
            f.write(f"# match: {e['title']}\n")
            f.write(f"# provider: {e['source']}\n")
            f.write(f"# embed: {e['embed_url']}\n")
            f.write(f"{e['m3u8_url']}\n\n")
            
    print("Scraping completed!")

if __name__ == "__main__":
    main()
