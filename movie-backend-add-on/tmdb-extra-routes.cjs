'use strict';

// Install after existing CORS/rate middleware and before the 404 handler.
// Keeps the current backend's other routes, authentication and streaming intact.
module.exports = function installTmdbExtraRoutes(app, options = {}) {
  const request = options.fetch || globalThis.fetch;
  const clock = options.clock || Date.now;
  const apiKey = options.apiKey || process.env.TMDB_API_KEY || '';
  const configuredToken = options.token || process.env.TMDB_BEARER_TOKEN || process.env.TMDB_READ_ACCESS_TOKEN || '';
  const token = configuredToken || (apiKey.startsWith('eyJ') ? apiKey : '');
  const cache = new Map(), pending = new Map();
  if (!app || typeof app.get !== 'function') throw Error('Pass the existing Express app to the TMDB route installer.');

  const integer = (value, minimum, maximum) => {
    const text = String(value ?? '');
    if (!/^\d{1,10}$/.test(text)) return null;
    const number = Number(text);
    return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : null;
  };
  const httpError = (status, code) => Object.assign(new Error(code), { status, code });
  async function tmdb(path, parameters, ttl) {
    if (!apiKey && !token) throw httpError(503, 'tmdb_not_configured');
    const address = new URL('https://api.themoviedb.org/3/' + path);
    for (const [key, value] of Object.entries(parameters)) if (value) address.searchParams.set(key, value);
    const key = address.pathname + '?' + address.searchParams.toString();
    const cached = cache.get(key);
    if (cached && cached.expires > clock()) return cached.data;
    if (!pending.has(key)) {
      if (pending.size >= 16) throw httpError(503, 'metadata_busy');
      const task = (async () => {
        if (!token) address.searchParams.set('api_key', apiKey);
        const response = await request(address.href, { headers: { Accept: 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, signal: AbortSignal.timeout(10000) });
        if (!response.ok) {
          throw httpError(response.status === 404 ? 404 : response.status === 429 ? 503 : 502, 'tmdb_upstream_unavailable');
        }
        const data = await response.json();
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw httpError(502, 'metadata_invalid');
        if (cache.size >= 200) cache.delete(cache.keys().next().value);
        cache.set(key, { data, expires: clock() + ttl }); return data;
      })().finally(() => pending.delete(key));
      pending.set(key, task);
    }
    return pending.get(key);
  }
  function fail(res, error) {
    console.warn('TMDB extra route unavailable', { code: error.code || error.name });
    return res.status(error.status || 503).json({ error: 'This information is temporarily unavailable. Please try again.' });
  }
  app.get('/api/tmdb/:type/:id/images', async (req, res) => {
    const id = integer(req.params.id, 1, 2147483647), type = req.params.type;
    if (!id || !['movie', 'tv'].includes(type)) return res.status(400).json({ error: 'Choose a movie or series.' });
    const query = req.query || {};
    const languages = typeof query.include_image_language === 'string' ? query.include_image_language : 'en,null';
    if (languages.length > 100 || !/^(?:[a-z]{2}(?:-[A-Za-z]{2})?|null)(?:,(?:[a-z]{2}(?:-[A-Za-z]{2})?|null))*$/.test(languages)) return res.status(400).json({ error: 'Invalid image language.' });
    try { return res.json(await tmdb(`${type}/${id}/images`, { include_image_language: languages }, 3600000)); }
    catch (error) { return fail(res, error); }
  });
  app.get('/api/tmdb/tv/:id/season/:season/episode/:episode', async (req, res) => {
    const id = integer(req.params.id, 1, 2147483647), season = integer(req.params.season, 0, 9999), episode = integer(req.params.episode, 1, 99999);
    if (!id || season === null || episode === null) return res.status(400).json({ error: 'Choose a valid season and episode.' });
    const language = typeof req.query?.language === 'string' ? req.query.language : 'en-US';
    if (!/^[a-z]{2}(?:-[A-Za-z]{2})?$/.test(language)) return res.status(400).json({ error: 'Invalid language.' });
    try { return res.json(await tmdb(`tv/${id}/season/${season}/episode/${episode}`, { language }, 600000)); }
    catch (error) { return fail(res, error); }
  });
};
