/**
 * Generate a unique idempotency key
 * @returns {string} - Idempotency key
 */
function generateIdempotencyKey() {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

module.exports = {
  generateIdempotencyKey,
};
