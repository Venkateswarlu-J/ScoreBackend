const crypto = require('crypto');

/**
 * Generate a random scorer token (32 bytes, hex encoded)
 * @returns {string} - Random token
 */
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Hash a token using SHA-256
 * @param {string} token - Token to hash
 * @returns {string} - Hashed token
 */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Verify a token against a hash
 * @param {string} token - Token to verify
 * @param {string} hash - Hash to verify against
 * @returns {boolean} - True if token matches hash
 */
function verifyToken(token, hash) {
  return hashToken(token) === hash;
}

module.exports = {
  generateToken,
  hashToken,
  verifyToken,
};
