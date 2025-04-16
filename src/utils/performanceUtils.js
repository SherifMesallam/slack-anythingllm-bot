// Utility functions for basic performance timing
import logger from '../logger.js';

/**
 * Starts a performance timer.
 * @returns {number} - The start time (from performance.now()).
 */
export function startTimer() {
  return performance.now();
}

/**
 * Ends a performance timer and logs the duration.
 * @param {number} startTime - The start time from startTimer().
 * @param {string} operationName - A descriptive name for the timed operation.
 * @param {object} [context={}] - Additional context to include in the log.
 * @returns {number} - The duration in milliseconds.
 */
export function endTimer(startTime, operationName, context = {}) {
  const durationMs = performance.now() - startTime;
  logger.debug(
    {
      durationMs: parseFloat(durationMs.toFixed(2)), // Log with 2 decimal places
      operation: operationName,
      ...context,
    },
    `Performance: ${operationName} completed`
  );
  return durationMs;
} 