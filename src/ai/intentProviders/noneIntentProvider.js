// Default intent provider when none is configured or needed
import logger from '../../logger.js';

export function detectIntentAndWorkspace(query, availableIntents, availableWorkspaces) {
  logger.debug('Using noneIntentProvider');
  return {
    intent: null,
    confidence: 0,
    suggestedWorkspace: null,
  };
} 