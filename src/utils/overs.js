/**
 * Allowed overs formats: Super Over (0), 2, 3, 4, 5, 6, 8, 10, 15, 20, 30, 50
 */
const ALLOWED_OVERS = [1, 2, 3, 4, 5, 6, 8, 10, 15, 20, 30, 50];

/**
 * Get human-readable label for overs format
 * @param {number} overs - Overs value
 * @returns {string} - Label (e.g., "Super Over", "10 Overs")
 */
function getOversLabel(overs) {
  if (overs === 0) return 'Super Over';
  return `${overs} Overs`;
}

/**
 * Calculate overs string from legal balls count
 * @param {number} legalBalls - Number of legal balls
 * @returns {string} - Overs string in cricket notation (e.g., "8.2")
 */
function calculateOversString(legalBalls) {
  const completedOvers = Math.floor(legalBalls / 6);
  const remainingBalls = legalBalls % 6;
  return `${completedOvers}.${remainingBalls}`;
}

/**
 * Calculate run rate
 * @param {number} total - Total runs scored
 * @param {number} legalBalls - Number of legal balls faced
 * @returns {number} - Run rate (runs per ball * 6)
 */
function calculateRunRate(total, legalBalls) {
  if (legalBalls === 0) return 0;
  return (total / legalBalls) * 6;
}

/**
 * Calculate required run rate for chase
 * @param {number} target - Target score
 * @param {number} totalScored - Runs already scored
 * @param {number} ballsRemaining - Legal balls remaining in innings
 * @returns {number} - Required run rate
 */
function calculateRequiredRunRate(target, totalScored, ballsRemaining) {
  const runsNeeded = target - totalScored;
  if (runsNeeded <= 0) return 0;
  if (ballsRemaining === 0) return 0;
  return (runsNeeded / ballsRemaining) * 6;
}

module.exports = {
  ALLOWED_OVERS,
  getOversLabel,
  calculateOversString,
  calculateRunRate,
  calculateRequiredRunRate,
};
