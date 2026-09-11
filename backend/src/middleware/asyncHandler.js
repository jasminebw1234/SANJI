/**
 * Express 4 does not catch rejections from async route handlers: an
 * `await` that throws inside `router.get('/x', async (req, res) => ...)`
 * becomes an unhandled promise rejection, which Node turns into an
 * uncaught exception that kills the whole process. One transient database
 * error on a read endpoint takes the server down for every user.
 *
 * Wrapping a handler in asyncHandler forwards those rejections to Express's
 * error middleware instead, so they become a 500 for that one request.
 *
 *   router.get('/:id', asyncHandler(async (req, res) => { ... }));
 */
export function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

/**
 * Terminal error middleware. Must be registered after all routes, and must
 * declare all four arguments — Express identifies error middleware by
 * arity, so dropping `next` silently turns this into a normal middleware
 * that never runs.
 */
export function errorMiddleware(err, req, res, next) {
  console.error(`Unhandled error on ${req.method} ${req.originalUrl}:`, err);

  if (res.headersSent) {
    return next(err);
  }

  res.status(500).json({
    error: 'INTERNAL_ERROR',
    message: 'Something went wrong on our end. Please try again in a moment.'
  });
}
