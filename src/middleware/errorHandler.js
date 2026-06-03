// FILE: src/middleware/errorHandler.js
// Central error responder. Sits at the bottom of the middleware stack.

import { IS_PRODUCTION } from '../env.js';

// HttpError — throw this from any handler to control the response status.
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// 404 catch-all — mount AFTER all routes, BEFORE errorHandler.
export function notFound(req, res, next) {
  next(new HttpError(404, `Not found: ${req.method} ${req.originalUrl}`));
}

// Final error responder.
export function errorHandler(err, req, res, _next) {
  const status = err.status || 500;
  if (status >= 500) {
    console.error(`[${req.method} ${req.originalUrl}]`, err);
  }
  res.status(status).json({
    error: err.message || 'Internal server error',
    ...(IS_PRODUCTION ? {} : { stack: err.stack }),
  });
}
