
import axios from 'axios';
import {
    anythingLLMBaseUrl,
    anythingLLMApiKey,
    WORKSPACE_LIST_CACHE_KEY,
    WORKSPACE_LIST_CACHE_TTL,
    redisUrl,
    // Import config needed for determineInitialWorkspace
    enableUserWorkspaces,
    userWorkspaceMapping,
    workspaceMapping,
    fallbackWorkspace
} from './config.js';
import { redisClient, isRedisReady } from './services.js';

// Cache for available workspace slugs
let availableWorkspacesCache = null;
let cacheTimestamp = 0;

// --- Helper: Get Available Sphere Slugs (with In-Memory + Redis Cache) ---
async function getAvailableSphereSlugs() {
    const now = Date.now();

    // 1. Check in-memory cache
    if (availableWorkspacesCache && (now - cacheTimestamp < WORKSPACE_LIST_CACHE_TTL * 1000)) {
        console.log(`[LLM Service/getSlugs] In-memory cache HIT.`);
        return availableWorkspacesCache;
    }

    // 2. Check Redis cache
    if (redisUrl && isRedisReady) {
        try {
            const cachedData = await redisClient.get(WORKSPACE_LIST_CACHE_KEY);
            if (cachedData) {
                const slugs = JSON.parse(cachedData);
                console.log(`[LLM Service/getSlugs] Redis cache HIT. Found ${slugs.length} slugs.`);
                availableWorkspacesCache = slugs;
                cacheTimestamp = now; // Update in-memory cache timestamp
                return slugs;
            }
            console.log(`[LLM Service/getSlugs] Redis cache MISS.`);
        } catch (err) {
            console.error(`[Redis Error] Failed to get workspace cache key ${WORKSPACE_LIST_CACHE_KEY}:`, err);
        }
    }

    // 3. Fetch from API
    console.log(`[LLM Service/getSlugs] Fetching available workspaces from API...`);
    try {
        const response = await axios.get(`${anythingLLMBaseUrl}/api/v1/workspaces`, {
            headers: { 'Accept': 'application/json', Authorization: `Bearer ${anythingLLMApiKey}` },
            timeout: 10000, // 10 seconds timeout
        });

        if (response.data && Array.isArray(response.data.workspaces)) {
            const slugs = response.data.workspaces
                .map(ws => ws.slug)
                .filter(slug => slug && typeof slug === 'string');
            console.log(`[LLM Service/getSlugs] API returned ${slugs.length} slugs.`);

            availableWorkspacesCache = slugs; // Update in-memory cache
            cacheTimestamp = now;

            // Update Redis cache asynchronously (don't block return)
            if (redisUrl && isRedisReady && slugs.length > 0) {
                redisClient.set(WORKSPACE_LIST_CACHE_KEY, JSON.stringify(slugs), { EX: WORKSPACE_LIST_CACHE_TTL })
                    .then(() => console.log(`[LLM Service/getSlugs] Updated Redis cache key ${WORKSPACE_LIST_CACHE_KEY}.`))
                    .catch(cacheSetError => console.error(`[Redis Error] Failed to set workspace cache key ${WORKSPACE_LIST_CACHE_KEY}:`, cacheSetError));
            }
            return slugs;
        } else {
            console.error('[LLM Service/getSlugs] Unexpected API response structure:', response.data);
        }
    } catch (error) {
        console.error('[LLM Service/getSlugs] API Fetch failed:', error.response?.data || error.message);
    }

    // Fallback if all attempts fail
    console.warn("[LLM Service/getSlugs] Failed to get slugs from all sources. Returning empty list.");
    return []; // Return empty list on failure
}


// --- Helper Function: Determine Initial Workspace ---
/**
 * Determines the appropriate AnythingLLM workspace slug based on config priority
 * for creating a *new* thread.
 * Priority: User Mapping > Channel Mapping > Fallback Workspace
 * @param {string} userId - Slack User ID
 * @param {string} channelId - Slack Channel ID
 * @returns {string | null} The determined workspace slug or null if none found/configured.
 */
export function determineInitialWorkspace(userId, channelId) {
    let targetWorkspace = null;

    // 1. User Mapping (Only if enabled)
    if (enableUserWorkspaces && userWorkspaceMapping && typeof userWorkspaceMapping === 'object') {
        const userMappedWorkspace = userWorkspaceMapping[userId];
        if (typeof userMappedWorkspace === 'string' && userMappedWorkspace.trim()) {
            targetWorkspace = userMappedWorkspace.trim();
            console.log(`[Workspace Logic] User mapping found for ${userId}: ${targetWorkspace}`);
        } else if (userMappedWorkspace) {
             console.warn(`[Workspace Logic] Invalid workspace value in user mapping for ${userId}: "${userMappedWorkspace}". Ignoring.`);
        }
    }

    // 2. Channel Mapping (only if user mapping didn't apply or was invalid)
    if (!targetWorkspace && workspaceMapping && typeof workspaceMapping === 'object') {
        const channelMappedWorkspace = workspaceMapping[channelId];
         if (typeof channelMappedWorkspace === 'string' && channelMappedWorkspace.trim()) {
            targetWorkspace = channelMappedWorkspace.trim();
            console.log(`[Workspace Logic] Channel mapping found for ${channelId}: ${targetWorkspace}`);
        } else if (channelMappedWorkspace){
             console.warn(`[Workspace Logic] Invalid workspace value in channel mapping for ${channelId}: "${channelMappedWorkspace}". Ignoring.`);
        }
    }

    // 3. Fallback Workspace (only if neither user nor channel mapping applied)
    if (!targetWorkspace) {
        if (typeof fallbackWorkspace === 'string' && fallbackWorkspace.trim()) {
            targetWorkspace = fallbackWorkspace.trim();
            console.log(`[Workspace Logic] Using fallback workspace: ${targetWorkspace}`);
        } else {
             console.warn(`[Workspace Logic] No user/channel mapping found and fallback workspace is not configured or invalid.`);
        }
    }

    console.log(`[Workspace Logic] Final determined initial workspace: ${targetWorkspace}`);
    return targetWorkspace;
}
// --- End Helper Function ---


// +++ Function to Create a New AnythingLLM Thread +++
/**
 * Creates a new thread in a specific AnythingLLM workspace.
 * @param {string} sphere - The workspace slug.
 * @returns {Promise<string | null>} The new thread slug, or null on error.
 */
export async function createNewAnythingLLMThread(sphere) {
    if (!sphere) {
        console.error("[LLM Service/createThread] Cannot create thread without a workspace slug.");
        return null;
    }
    console.log(`[LLM Service/createThread] Creating new thread in sphere: ${sphere}...`);
    try {
        const response = await axios.post(`${anythingLLMBaseUrl}/api/v1/workspace/${sphere}/thread/new`,
            {}, // No body needed
            {
                headers: { Authorization: `Bearer ${anythingLLMApiKey}` },
                timeout: 15000, // 15s timeout
            });

        if (response.data?.thread?.slug) {
            const newThreadSlug = response.data.thread.slug;
            console.log(`[LLM Service/createThread] Successfully created thread slug: ${newThreadSlug}`);
            return newThreadSlug;
        } else {
            console.error('[LLM Service/createThread] Unexpected API response structure:', response.data);
            return null;
        }
    } catch (error) {
        console.error(`[LLM Error - Create Thread - Sphere: ${sphere}]`, error.response?.data || error.message);
        return null;
    }
}

// --- Main LLM Chat Function (Handles workspace and thread chats) ---
export async function queryLlm(sphere, anythingLLMThreadSlug, inputText, mode = 'chat', attachments = []) {
    console.log(`[LLM Service/queryLlm] Querying sphere: ${sphere}, thread: ${anythingLLMThreadSlug || 'None'}, mode: ${mode}`);

    if (!sphere) {
        console.error('[LLM Service/queryLlm] Error: sphere (workspace slug) is required.');
        throw new Error('Internal error: Missing workspace slug for LLM query.');
    }
     if (!inputText || typeof inputText !== 'string' || !inputText.trim()) {
        console.error('[LLM Service/queryLlm] Error: inputText is required and must be a non-empty string.');
        throw new Error('Internal error: Missing input text for LLM query.');
    }


    // Construct the endpoint URL based on whether a thread slug is provided
    const endpointUrl = anythingLLMThreadSlug
        ? `${anythingLLMBaseUrl}/api/v1/workspace/${sphere}/thread/${anythingLLMThreadSlug}/chat`
        : `${anythingLLMBaseUrl}/api/v1/workspace/${sphere}/chat`;

    console.log(`[LLM Service/queryLlm] Using endpoint: ${endpointUrl}`);

    const requestBody = {
        message: inputText,
        mode: mode, // 'chat' or 'query'
        // attachments: attachments // Add attachments later if needed
    };
     // console.log("[LLM Service/queryLlm] Request Body:", JSON.stringify(requestBody)); // Verbose logging if needed

    try {
        const llmResponse = await axios.post(
            endpointUrl,
            requestBody,
            {
                headers: { Authorization: `Bearer ${anythingLLMApiKey}`, 'Content-Type': 'application/json' },
                timeout: 90000, // 90s timeout
            }
        );

        if (!llmResponse?.data) {
            console.error('[LLM Service/queryLlm] Error: Empty or invalid response from LLM API');
            throw new Error('LLM API returned an empty or invalid response.');
        }

        // Log raw response structure for debugging if needed
        // console.log("[LLM Service/queryLlm] Raw API Response Data:", llmResponse.data);

        if (llmResponse.data.textResponse === undefined || llmResponse.data.textResponse === null) {
            console.warn('[LLM Service/queryLlm] Warning: No textResponse field in LLM response.', llmResponse.data);
            // Decide how to handle this - return empty string, null, or throw?
            // Returning empty string might be safer for downstream processing.
            return "";
        }
        // Return the text content
        return llmResponse.data.textResponse;

    } catch (error) {
        let errorDetails = error.message;
        if (error.response) {
            console.error(`[LLM Error Data - ${error.response.status}]:`, error.response.data);
            errorDetails = `Status ${error.response.status}: ${JSON.stringify(error.response.data)}`;
        } else if (error.request) {
            console.error('[LLM Error Request]: Request made but no response received.');
            errorDetails = 'No response received from LLM server.';
        } else { console.error('[LLM Error Message]:', error.message); }
        console.error('[LLM Error Config]:', error.config);

        const errorMsg = `LLM query failed for sphere ${sphere}${anythingLLMThreadSlug ? ", thread "+anythingLLMThreadSlug : ''}: ${errorDetails}`;
        console.error(`[LLM Error Full Context]`, errorMsg);
        throw new Error(errorMsg); // Rethrow with more context
    }
}

// --- Function to get available workspaces (exposed) ---
export const getWorkspaces = getAvailableSphereSlugs;

