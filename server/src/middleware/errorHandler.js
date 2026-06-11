// Central error handling. Keeps controllers free of try/catch and ensures every
// failure returns a consistent JSON shape. Logs to stderr only (PM2/Cloud Logging).

export function notFound(req, res) {
  res.status(404).json({ error: `Not found: ${req.method} ${req.originalUrl}` });
}

// eslint-disable-next-line no-unused-vars -- Express needs the 4-arg signature.
export function errorHandler(err, req, res, _next) {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) {
    console.error('[error]', err.stack || err.message);
  } else {
    console.warn(`[warn] ${status} ${req.method} ${req.originalUrl}: ${err.message}`);
  }
  // multer file-size / type errors surface as err.code — pass a readable message.
  res.status(status).json({ error: err.message || 'Internal server error' });
}
