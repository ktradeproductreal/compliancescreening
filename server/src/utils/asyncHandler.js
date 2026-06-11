// Wraps an async route handler so rejected promises reach Express's error
// middleware instead of hanging the request.
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

/** Throw from anywhere to produce a clean HTTP error (caught by errorHandler). */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
