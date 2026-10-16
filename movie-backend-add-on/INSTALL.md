# Patch for the existing VIDROOM movie backend

Apply this to the repository serving https://vidroom-backend-1.onrender.com.

Live checks found:

- /api/health returns 200, version 3.0.0.
- /api/tmdb/movie/1291595 and /api/tmdb/movie/popular work.
- /api/tmdb/movie/1291595/images returns 404.
- /api/tmdb/tv/79744/season/1/episode/1 returns 404.

The two missing endpoints prevent separate studio-logo requests and episode-detail requests. This small module adds them while preserving the current backend's other routes. It is not a replacement for the entire existing server.

1. Copy tmdb-extra-routes.cjs into the same folder as your current server entry file.
2. In that entry file, after existing CORS and rate-limit middleware, before the existing TMDB routes and before any final 404 handler, add:

```js
require('./tmdb-extra-routes.cjs')(app);
```

For an ES-module server that uses import statements instead of require, add this import near the top and call it at the same installation point:

```js
import installTmdbExtraRoutes from './tmdb-extra-routes.cjs';

installTmdbExtraRoutes(app);
```

3. Keep the existing Render build/start commands and TMDB_API_KEY setting. If your key exists only in an existing JavaScript constant, you can pass that constant explicitly:

```js
require('./tmdb-extra-routes.cjs')(app, { apiKey: TMDB_API_KEY });
```

The module also supports TMDB_BEARER_TOKEN or TMDB_READ_ACCESS_TOKEN. Put tokens only in Render environment settings. Node 18 or newer is required; no npm dependencies are added.

4. Deploy the current movie-backend repository once.
5. Verify these URLs now return JSON rather than an endpoint 404:

https://vidroom-backend-1.onrender.com/api/tmdb/movie/533535/images?include_image_language=en,null

https://vidroom-backend-1.onrender.com/api/tmdb/tv/79744/season/1/episode/1

## The separate playback failure

The submitted log shows player.videasy.to fetching api.speedracelight.com/seed, which lacks the required Access-Control-Allow-Origin header. Those requests originate inside the third-party iframe. Changing CORS on VIDROOM's Render server cannot change that upstream response or the iframe's origin. The Videasy statistics endpoint also returned 429 and another Videasy hostname failed DNS resolution. Image requests separately failed with HTTP/2 protocol errors; the log alone does not establish their precise network cause.

This module fixes the missing metadata routes. It cannot fix Videasy's internal CORS, DNS or source availability. The frontend keeps its alternative players and fixes manual source cycling and stale iframe-loading callbacks. An iframe load event is not proof that a movie played. Do not disable browser security to make an embedded source load.

The latest deployed v3 backend source was not available among the retrieved files; the available older backend copy was v2. This add-on avoids overwriting newer routes with that older implementation.

Run its checks with:

    node --test test/routes.test.cjs
