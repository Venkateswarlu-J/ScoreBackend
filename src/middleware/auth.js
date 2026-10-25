const { verifyToken } = require('../utils/generateToken');

/**
 * Middleware to verify scorer token
 * Extracts token from x-scorer-token header and validates it
 */
function authMiddleware(req, res, next) {
  const token = req.headers['x-scorer-token'];
  const matchId = req.params.matchId;

  if (!token) {
    return res.status(401).json({ error: 'Scorer token required' });
  }

  if (!matchId) {
    return res.status(400).json({ error: 'Match ID required' });
  }

  // Store token and matchId for later use
  req.scorerToken = token;
  req.matchId = matchId;

  next();
}

module.exports = authMiddleware;
