const rateLimit = require('express-rate-limit');

/**
 * Rate limiter for mutation endpoints (30 requests per minute)
 */
const mutationLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  message: 'Too many requests, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Rate limiter for read endpoints (100 requests per minute)
 */
const readLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100,
  message: 'Too many requests, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = {
  mutationLimiter,
  readLimiter,
};
