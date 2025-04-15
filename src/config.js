import dotenv from 'dotenv';

dotenv.config();

// --- Slack Configuration ---
export const signingSecret = process.env.SLACK_SIGNING_SECRET;
export const botToken = process.env.SLACK_BOT_TOKEN;
export const appToken = process.env.SLACK_APP_TOKEN;
export const botUserId = process.env.SLACK_BOT_USER_ID; // Bot's own User ID
export const developerId = process.env.DEVELOPER_ID; // Optional: Restrict usage
export const userWorkspaceMapping = JSON.parse(process.env.SLACK_USER_WORKSPACE_MAPPING || '{}');

// Added enableUserWorkspaces
export const enableUserWorkspaces = process.env.ENABLE_USER_WORKSPACES === 'true';

// Added fallbackWorkspace
export const fallbackWorkspace = process.env.FALLBACK_WORKSPACE_SLUG || null;

// Added workspaceMapping for channel/default routing
export const workspaceMapping = JSON.parse(process.env.WORKSPACE_MAPPING || '{}');

// --- AnythingLLM Configuration ---
export const anythingLLMBaseUrl = process.env.LLM_API_BASE_URL;
export const anythingLLMApiKey = process.env.LLM_API_KEY;

// --- Routing/Intent Configuration ---
export const routingLlmApiKey = process.env.ROUTING_LLM_API_KEY || null; // Gemini API Key
export const routingLlmModelName = process.env.ROUTING_LLM_MODEL_NAME || "gemini-2.5-pro-preview-03-25"; // Model for routing

// --- GitHub Feature Configuration ---
export const githubToken = process.env.GITHUB_TOKEN || null; // Optional: Used for GitHub features (release check, PR, issue)
export const githubWorkspaceSlug = process.env.GITHUB_WORKSPACE_SLUG || null; // AnythingLLM workspace for generating GitHub API calls
export const formatterWorkspaceSlug = process.env.FORMATTER_WORKSPACE_SLUG || null; // AnythingLLM workspace for formatting GitHub responses
export const GITHUB_OWNER = process.env.GITHUB_OWNER || 'gravityforms'; // Default GH owner

// --- Infrastructure Configuration ---
export const port = process.env.PORT || 3000;
export const redisUrl = process.env.REDIS_URL || null;
export const databaseUrl = process.env.DATABASE_URL || null;

// --- Bot Behavior Configuration ---
export const MAX_SLACK_BLOCK_TEXT_LENGTH = 2950; // Slightly less than 3000 limit for safety
export const MAX_SLACK_BLOCK_CODE_LENGTH = process.env.MAX_SLACK_BLOCK_CODE_LENGTH ? parseInt(process.env.MAX_SLACK_BLOCK_CODE_LENGTH) : 2800; // Max length for text in a code block element
export const RESET_CONVERSATION_COMMAND = 'reset conversation';
export const WORKSPACE_OVERRIDE_COMMAND_PREFIX = '#'; // Prefix to trigger manual workspace selection
export const MIN_SUBSTANTIVE_RESPONSE_LENGTH = process.env.MIN_SUBSTANTIVE_RESPONSE_LENGTH ? parseInt(process.env.MIN_SUBSTANTIVE_RESPONSE_LENGTH) : 100; // Minimum length for a response to be considered substantive enough for feedback buttons

// --- Cache Configuration ---
export const DUPLICATE_EVENT_TTL = 600; // 10 minutes
export const RESET_HISTORY_TTL = 300; // 5 minutes
export const WORKSPACE_LIST_CACHE_TTL = 3600; // 1 hour
export const THREAD_WORKSPACE_TTL = 3600; // Seconds to cache the chosen workspace for a thread

// --- Redis Prefixes ---
export const DUPLICATE_EVENT_REDIS_PREFIX = 'slack_event_id:';
export const RESET_HISTORY_REDIS_PREFIX = 'slack_reset_hist:';
export const WORKSPACE_LIST_CACHE_KEY = 'anythingllm_workspaces';
export const THREAD_WORKSPACE_PREFIX = 'thread_workspace:'; // Key: thread_workspace:channel_id:thread_ts

// --- Validation ---
export function validateConfig() {
    console.log("[Config] Validating configuration...");
    if (!signingSecret) console.error("❌ SLACK_SIGNING_SECRET is not set!");
    if (!botToken) console.error("❌ SLACK_BOT_TOKEN is not set!");
    if (!appToken) console.error("❌ SLACK_APP_TOKEN is not set!");
    if (!botUserId) console.error("❌ SLACK_BOT_USER_ID is not set!");
    if (!anythingLLMBaseUrl) console.error("❌ LLM_API_BASE_URL is not set!");
    if (!anythingLLMApiKey) console.error("❌ LLM_API_KEY is not set!");

    // Workspace configuration check
    if (!fallbackWorkspace && !enableUserWorkspaces && Object.keys(workspaceMapping).length === 0) {
        console.warn("⚠️ No primary workspace configuration found (FALLBACK_WORKSPACE_SLUG, WORKSPACE_MAPPING, or ENABLE_USER_WORKSPACES+SLACK_USER_WORKSPACE_MAPPING). Bot may struggle to find default destinations.");
    }

    // Optional checks
    if (!enableUserWorkspaces && Object.keys(workspaceMapping).length === 0 && !fallbackWorkspace) {
        // This duplicates the warning above slightly, but emphasizes lack of channel/default mapping
        console.warn("⚠️ No channel/default WORKSPACE_MAPPING or FALLBACK_WORKSPACE_SLUG set. Bot might not know where to send non-user-specific messages.");
    }
    if (enableUserWorkspaces && Object.keys(userWorkspaceMapping).length === 0) {
        console.warn("⚠️ ENABLE_USER_WORKSPACES is true, but SLACK_USER_WORKSPACE_MAPPING is empty or invalid JSON.");
    }
    if (!redisUrl) console.warn("⚠️ REDIS_URL not set. Duplicate detection and history reset features disabled.");
    if (!databaseUrl) console.warn("⚠️ DATABASE_URL not set. Feedback storage disabled (will log to console).");

    // Routing & GitHub Feature Checks
    if (!routingLlmApiKey) console.warn("⚠️ ROUTING_LLM_API_KEY not set. Intent-based routing via Gemini disabled. Bot will rely on default LLM.");
    if (!githubToken) console.warn("⚠️ GITHUB_TOKEN not set. GitHub features (release check, PR/Issue analysis, API calls) disabled.");
    if (githubToken && !githubWorkspaceSlug) console.warn("⚠️ GITHUB_TOKEN is set, but GITHUB_WORKSPACE_SLUG is not. Generic GitHub API commands (#github, github ...) may fail.");
    if (githubToken && !formatterWorkspaceSlug) console.warn("⚠️ GITHUB_TOKEN is set, but FORMATTER_WORKSPACE_SLUG is not. GitHub API responses will be sent as raw JSON.");

    console.log("[Config] Basic validation complete.");
}
