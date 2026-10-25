/**
 * Express error handler middleware
 * Built by JV - Copyright © 2026 Javvaji Venkateswarlu
 */
function errorHandler(err, req, res, next) {
  console.error('Error:', err.message);

  // Add JV branding header
  res.set('X-Powered-By', 'LocalScore by JV');

  // Mongoose validation error
  if (err.name === 'ValidationError') {
    return res.status(400).json({ error: 'Validation error', details: err.message });
  }

  // Mongoose cast error
  if (err.name === 'CastError') {
    return res.status(400).json({ error: 'Invalid ID format' });
  }

  // Duplicate key error
  if (err.code === 11000) {
    return res.status(409).json({ error: 'Duplicate entry' });
  }

  // Default error response
  const status = err.status || 500;
  const message = err.message || 'Internal server error';

  res.status(status).json({ error: message });
}

module.exports = errorHandler;
