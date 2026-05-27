const { createApp } = require('../server/index');

const app = createApp();

module.exports = (req, res) => {
  if (typeof req.url === 'string' && req.url.startsWith('/api/')) {
    req.url = req.url.slice('/api'.length) || '/';
  } else if (typeof req.url === 'string' && req.url === '/api') {
    req.url = '/';
  }
  return app(req, res);
};

