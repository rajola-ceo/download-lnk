# VIDROOM download-lnk — separate download service

This service adds real file downloads without changing your existing VIDROOM movie server. The frontend is already configured for `https://download-lnk.onrender.com`.

## What is actually included

- Direct HTTPS video sources with byte/header validation.
- Internet Archive metadata/file adapter for explicitly configured files.
- Backend WebTorrent preparation, bounded temporary disk use and HTTP file delivery.
- Automatic fallback across sources within a quality/format variant.
- Exact TMDB movie or TV season/episode matching.
- Signed expiring download URLs, job tokens, byte-range downloads and source allowlists.
- Actual preparation progress for torrents. The browser manages transfer progress after handoff; the page does not falsely claim the movie was saved.
- Full updated VIDROOM HTML supplied separately: Download on details and player; quality selection and TV episode selection. Existing cards and their dimensions are unchanged. Existing home title artwork stays intact.

The default catalogue contains ONLY Big Buck Bunny (2008), TMDB 10378, an openly licensed film. It lists publisher MOV files, an Archive MP4 and a curated torrent. Direct links are probed when requested; a missing/inaccessible file is excluded. Torrent peer availability is established during preparation. External source availability was not verified from this workspace because DNS was blocked. These are genuine external sources, not mock download progress or trailer substitutions. Other movies correctly show “No downloads are available for this title yet.”

There is no unrestricted torrent search, embed scraping, DRM bypass or invented video URL. Additional real sources must be entered in catalog.json.

## 1. Upload the backend to GitHub

1. Extract download-lnk-server.zip.
2. Create a NEW folder called `download-lnk` in your GitHub repository.
3. Upload the ZIP's CONTENTS into that folder. `package.json`, `server.mjs`, `catalog.json` and `lib/` must be directly inside it.
4. Commit. Keep your existing vidroom-backend-1 and LOLAN folders unchanged.

Alternatively use a new repository with the extracted files at its root; then leave Render Root Directory blank.

## 2. Create the Render service

Render > New > Web Service > connect the repository.

| Render field | Value |
| --- | --- |
| Name | download-lnk |
| Root Directory | download-lnk (blank if using a separate repository with files at root) |
| Runtime | Node |
| Build Command | npm install |
| Start Command | node server.mjs |
| Health Check Path | /health |

Use a single service instance. The package requests Node 24 and includes package-lock.json. npm install runs the torrent dependency's native installation scripts; do not use --ignore-scripts on Render. No changes to your existing movie backend are required.

## 3. Environment variables

Add these in the NEW service's Environment panel:

| Key | Value |
| --- | --- |
| NODE_ENV | production |
| PUBLIC_URL | https://download-lnk.onrender.com |
| CLIENT_ORIGINS | https://vidr00m.netlify.app,https://rajola-ceo.github.io |
| ALLOWED_SOURCE_HOSTS | download.blender.org,webtorrent.io,archive.org,*.archive.org |
| ENABLE_TORRENTS | true |
| DOWNLOAD_DIR | /tmp/vidroom-downloads |
| MAX_TORRENT_BYTES | 2147483648 |
| MAX_ACTIVE_TORRENTS | 1 |
| JOB_TTL_SECONDS | 1800 |
| TORRENT_TIMEOUT_SECONDS | 900 |

No MongoDB, Firebase, Cloudinary or provider API keys are needed for this starter catalogue. Render supplies PORT; do not manually add it. DOWNLOAD_SIGNING_SECRET is optional: if omitted, a random per-process key is used; restart invalidates old links either way because jobs are in memory. If you supply a secret, use a long random value and keep it out of the HTML.

CLIENT_ORIGINS values are HTTPS origins, without paths or trailing slashes. Add any other actual VIDROOM hosting origin here. Do not use `*`.

Render decides the final public URL. If download-lnk is unavailable and Render adds a suffix, change PUBLIC_URL and the HTML's DOWNLOAD_SERVER constant to the actual HTTPS URL.

## 4. Check backend before replacing frontend

1. Wait for Render's deployment to show Live.
2. Visit `https://download-lnk.onrender.com/health`.
3. Expect `{ "ok": true, "service": "download-lnk", "version": "1.0.0", ... }`.
4. Visit `/api/v1/catalog` to see the registered movie.
5. The health response checks the service, not external seed availability.

## 5. Replace the frontend

1. Keep a backup of your current index.html.
2. Rename the supplied VIDROOM-home-updated.html to `index.html`.
3. Replace only that frontend file on your existing Netlify or GitHub Pages site. Keep your existing icon, manifest and service worker files.
4. Refresh with Ctrl+F5. If a previous service worker still serves the old HTML, clear this site's cached data and reopen it.
5. Search VIDROOM for **Big Buck Bunny (2008)**, open it and press Download.
6. Select a listed file. Torrent preparation may take time; no torrent app is needed on the user's device.
7. A normal browser download starts when ready; Save video remains available if automatic handoff is blocked.
8. On mobile, the Download button is in the player. In desktop details it is also alongside Watch/Trailer. Series can choose an episode directly without starting playback.

## 6. Add more sources

Edit catalog.json and redeploy this download service. Do not change the frontend for each movie. Every title requires attribution, a licence/permission reference, and actual downloadable video sources.

Movie example (substitute real values; this is a schema example, not a working provider):

```json
{
  "type": "movie",
  "tmdbId": 12345,
  "title": "Your Movie",
  "year": 2026,
  "license": "https://your-publisher.example/license",
  "credit": "Publisher credit",
  "permissionSource": "https://your-publisher.example/download-permission",
  "variants": [{
    "id": "your-movie-1080p",
    "quality": "1080p",
    "format": "MP4",
    "sources": [
      {"kind":"direct","provider":"Publisher","url":"https://files.your-publisher.example/movie-1080.mp4"},
      {"kind":"direct","provider":"Publisher mirror","url":"https://mirror.your-publisher.example/movie-1080.mp4"}
    ]
  }]
}
```

For TV use `"type":"tv"`, the series TMDB ID and exact integer `season` and `episode` fields. Each episode is a separate catalogue record.

Archive source shape:

```json
{"kind":"archive","provider":"Internet Archive","identifier":"EXACT_ITEM_ID","filename":"EXACT_FILE_NAME.mp4"}
```

Torrent source shape:

```json
{"kind":"torrent","provider":"Publisher torrent","url":"https://your-publisher.example/movie.torrent","filePath":"Movie/Movie.mp4","infoHash":"OPTIONAL_40_CHARACTER_LOWERCASE_SHA1"}
```

Omit infoHash if not supplied; it is validated when present. filePath is required when a torrent has multiple video files; when it has exactly one video it can be omitted. Only curated HTTPS .torrent metadata is accepted in the catalogue; public users cannot submit URLs or magnets. The backend strips web seeds and embedded trackers, and uses its fixed public tracker. If an official torrent depends exclusively on web seeds/WebRTC peers, it may not have reachable BitTorrent peers under this configuration.

Add new publisher domains to ALLOWED_SOURCE_HOSTS. Redirect targets must also be allowed. Quality labels are supplied by the source catalogue, not generated/upscaled by the server. Use Source if the resolution is unknown. Only group identical quality/format/content as fallbacks. Do not advertise 4K unless a real 4K file is supplied.

## Storage, bandwidth and limitations

- Direct files stream through the backend without storing the whole movie or buffering it in page memory.
- Torrent files are prepared on disk before browser download. A torrent's total declared size must be within MAX_TORRENT_BYTES, even if only one file is selected.
- MAX_ACTIVE_TORRENTS limits preparation AND cached torrent sessions; expired jobs release unused sessions. A second torrent may report busy until cache expires. Default is one session and 2 GiB per torrent.
- Files and jobs expire after 30 minutes by default. A Render restart loses temporary data and old links. File transfers exceeding that lifetime may need another preparation; increase JOB_TTL_SECONDS for slower connections (maximum 7200).
- Free Render services sleep when idle, cannot attach a persistent disk, lose temporary files on restart, and have transfer/resource limits. This is useful for trials, not a promise of free high-volume movie distribution.
- For sustained use, run a suitably sized service/VPS with temporary/persistent disk, check torrent/network support, and budget egress. Inbound peer ports are not automatically exposed by the Render HTTP service; outgoing peers must be reachable.
- CORS controls browsers; it is not user authentication. This starter has source restrictions and rate/job limits, not billing, quotas or a production abuse-control account system.
- No automatic transcoding, extraction from current embeds, or whole-catalogue movie supply is included.

## Tests and API

Run `npm install`, `npm run check`, `npm test`. Tests include real HTTP attachment delivery against fixture files and a real native WebTorrent transfer between local peers, plus source validation, fallback, byte ranges, CORS, tokens and expiry. Frontend DOM checks verified the quality selector, browser handoff, empty state and exact TV episode parameters. No production movie download or visual browser inspection was possible here.

Endpoints:
- GET /health
- GET /api/v1/catalog
- POST /api/v1/resolve — `{type, tmdbId, season?, episode?}`
- POST /api/v1/jobs — add `{optionId, clientRequestId}`; returns jobToken
- GET /api/v1/jobs/:id — Authorization: Bearer jobToken
- DELETE /api/v1/jobs/:id — same token
- GET/HEAD /api/v1/files/:id?expires=...&signature=... — signed attachment

## Source documentation

- https://archive.org/developers/items.html
- https://archive.org/developers/index-apis.html
- https://webtorrent.io/docs
- https://webtorrent.io/intro
- https://peach.blender.org/about/
- https://peach.blender.org/download/
- https://render.com/docs/free
