// Service to detect intent and suggest workspace using a configured provider
import logger from '../logger.js';
import { config } from '../config.js';

// Dynamically import providers based on config
let provider;

async function loadProvider() {
  const providerName = config.intentProvider || 'none';
  logger.info({ providerName }, 'Loading intent provider');
  try {
    switch (providerName) {
      case 'gemini':
        provider = await import('./intentProviders/geminiIntentProvider.js');
        break;
      case 'none':
      default:
        provider = await import('./intentProviders/noneIntentProvider.js');
        break;
    }
  } catch (error) {
    logger.error({ error, providerName }, 'Failed to load intent provider, falling back to none.');
    provider = await import('./intentProviders/noneIntentProvider.js');
  }
}

// Load provider on startup
loadProvider();

export async function detectIntentAndWorkspace(query, availableIntents, availableWorkspaces) {
  if (!provider || !provider.detectIntentAndWorkspace) {
    logger.error('Intent detection provider not loaded or invalid.');
    // Fallback to none provider logic directly if load failed catastrophically
    return { intent: null, confidence: 0, suggestedWorkspace: null };
  }

  // Add performance timing
  const timer = performance.now();
  try {
    const result = await provider.detectIntentAndWorkspace(query, availableIntents, availableWorkspaces);
    const durationMs = performance.now() - timer;
    logger.debug({ durationMs, provider: config.intentProvider, query }, 'Intent detection completed');
    return result;
  } catch (error) {
    const durationMs = performance.now() - timer;
    logger.error({ error, durationMs, provider: config.intentProvider, query }, 'Error during intent detection');
    return { intent: null, confidence: 0, suggestedWorkspace: null }; // Fail safe
  }
} 