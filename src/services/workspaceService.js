// Service for determining and caching AnythingLLM workspaces
import logger from '../logger.js';
// REMOVED: import { config } from '../config.js';
import {
    enableUserWorkspaces, 
    userWorkspaceMapping, 
    workspaceMapping, 
    fallbackWorkspace 
} from '../config.js'; // Import specific config vars
import { getWorkspaces as fetchWorkspacesFromLLM } from '../llm.js'; // Uncommented import

// TODO: Implement robust caching (in-memory with TTL, potentially Redis for multi-instance)
let workspaceCache = {
  data: null,
  lastUpdated: 0,
  ttl: 5 * 60 * 1000, // 5 minutes
};

/**
 * Gets the list of available workspaces, using cache if possible.
 * @param {boolean} useCache - Whether to attempt using the cache.
 * @returns {Promise<Array<object>>} - List of workspace objects or empty array.
 */
export async function getWorkspaces(useCache = true) {
  const now = Date.now();
  if (useCache && workspaceCache.data && (now - workspaceCache.lastUpdated < workspaceCache.ttl)) {
    logger.debug('Using cached workspaces');
    return workspaceCache.data;
  }

  logger.info('Fetching workspaces from LLM API...');
  // TODO: Add performance timing here
  try {
    const workspaces = await fetchWorkspacesFromLLM(); // Replace placeholder with actual call
    workspaceCache.data = workspaces;
    workspaceCache.lastUpdated = Date.now();
    logger.info({ count: workspaces.length }, 'Workspaces fetched and cached');
    return workspaces;
  } catch (error) {
    logger.error({ error }, 'Failed to fetch workspaces');
    workspaceCache.data = null; // Invalidate cache on error
    return []; // Return empty on error
  }
}

/**
 * Determines the final workspace slug based on suggestion, user/channel mappings, and fallback.
 * @param {object} params
 * @param {string|null} params.suggestedWorkspace - Workspace suggested by intent detection.
 * @param {string} params.userId - The Slack user ID.
 * @param {string} params.channelId - The Slack channel ID.
 * @returns {Promise<string|null>} - The determined workspace slug or null.
 */
export async function determineWorkspace({ suggestedWorkspace, userId, channelId }) {
  const availableWorkspaces = await getWorkspaces();
  const availableSlugs = availableWorkspaces.map(ws => ws.slug);

  // 1. Check suggested workspace validity
  if (suggestedWorkspace && availableSlugs.includes(suggestedWorkspace)) {
    logger.debug({ suggestedWorkspace, userId, channelId }, 'Using suggested workspace');
    return suggestedWorkspace;
  }

  // 2. Check user-specific mapping (if enabled) - Use direct variables
  if (enableUserWorkspaces && userWorkspaceMapping?.[userId]) {
      const userMappedSlug = userWorkspaceMapping[userId];
      if (availableSlugs.includes(userMappedSlug)) {
          logger.debug({ workspace: userMappedSlug, userId }, 'Using user-mapped workspace');
          return userMappedSlug;
      } else {
          logger.warn({ workspace: userMappedSlug, userId }, 'User-mapped workspace slug not found in available workspaces');
      }
  }

  // 3. Check channel/workspace mapping - Use direct variable
  const channelMappedSlug = workspaceMapping?.[channelId];
  if (channelMappedSlug && availableSlugs.includes(channelMappedSlug)) {
    logger.debug({ workspace: channelMappedSlug, channelId }, 'Using channel-mapped workspace');
    return channelMappedSlug;
  }

  // 4. Use fallback workspace - Use direct variable
  if (fallbackWorkspace && availableSlugs.includes(fallbackWorkspace)) {
    logger.debug({ workspace: fallbackWorkspace }, 'Using fallback workspace');
    return fallbackWorkspace;
  }

  logger.warn({ userId, channelId, suggestedWorkspace }, 'Could not determine a valid workspace, no workspace will be used.');
  return null; // No valid workspace found
} 