// FILE: src/middleware/asyncHandler.js
// Removes the try/catch boilerplate from every route. Pass an async handler,
// any thrown error is forwarded to Express's error middleware.

export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

export default asyncHandler;
