const { createApp } = require('../server/index');

let cachedApp = null;

module.exports = (req, res) => {
  if (!cachedApp) {
    cachedApp = createApp();
  }
  const app = cachedApp;
  try {
    if (typeof req.url === 'string' && req.url.startsWith('/api/')) {
      req.url = req.url.slice('/api'.length) || '/';
    } else if (typeof req.url === 'string' && req.url === '/api') {
      req.url = '/';
    }
    return app(req, res);
  } catch (e) {
    try {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'Internal server error' }));
    } catch {
    }
    try {
      const msg = e instanceof Error ? e.stack || e.message : String(e);
      process.stderr.write(`${msg}\n`);
    } catch {
    }
    return undefined;
  }
};
