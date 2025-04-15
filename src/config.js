
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

// --- GitHub Feature Configuration ---
export const githubToken = process.env.GITHUB_TOKEN || null; // REQUIRED for GitHub features (gh> commands, /gh-* commands)
export const githubWorkspaceSlug = process.env.GITHUB_WORKSPACE_SLUG || null; // REQUIRED for generic 'gh> api' / '/gh-api' command
export const formatterWorkspaceSlug = process.env.FORMATTER_WORKSPACE_SLUG || null; // Optional: For formatting 'gh> api' / '/gh-api' responses
export const GITHUB_OWNER = process.env.GITHUB_OWNER || 'gravityforms'; // Default GH owner for commands unless specified otherwise

// --- Infrastructure Configuration ---
export const port = process.env.PORT || 3000;
export const redisUrl = process.env.REDIS_URL || null;
export const databaseUrl = process.env.DATABASE_URL || null;

// --- Bot Behavior Configuration ---
export const MAX_SLACK_BLOCK_TEXT_LENGTH = 2950; // Slightly less than 3000 limit for safety
export const MAX_SLACK_BLOCK_CODE_LENGTH = process.env.MAX_SLACK_BLOCK_CODE_LENGTH ? parseInt(process.env.MAX_SLACK_BLOCK_CODE_LENGTH) : 2800; // Max length for text in a code block element
export const RESET_CONVERSATION_COMMAND = 'reset conversation';
export const WORKSPACE_OVERRIDE_COMMAND_PREFIX = '#'; // Prefix to trigger manual workspace selection IN NORMAL CHAT
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
    } else {
         console.log("[Config] Found workspace config (User, Channel, or Fallback).")
    }
    if (enableUserWorkspaces && Object.keys(userWorkspaceMapping).length === 0) {
        console.warn("⚠️ ENABLE_USER_WORKSPACES is true, but SLACK_USER_WORKSPACE_MAPPING is empty or invalid JSON.");
    }

    // Optional checks
    if (!redisUrl) console.warn("⚠️ REDIS_URL not set. Duplicate detection and history reset features disabled.");
    if (!databaseUrl) console.warn("⚠️ DATABASE_URL not set. Feedback storage disabled (will log to console).");

    // GitHub Feature Checks (More critical now)
    if (!githubToken) console.error("❌ GITHUB_TOKEN is not set. GitHub features (`gh>` commands, `/gh-*` commands) will be disabled.");
    if (githubToken && !githubWorkspaceSlug) console.warn("⚠️ GITHUB_TOKEN is set, but GITHUB_WORKSPACE_SLUG is not. Generic GitHub API commands (`gh> api`, `/gh-api`) may fail.");
    if (githubToken && !formatterWorkspaceSlug) console.warn("⚠️ GITHUB_TOKEN is set, but FORMATTER_WORKSPACE_SLUG is not. GitHub API (`gh> api`, `/gh-api`) responses will be sent as raw JSON.");

    console.log("[Config] Basic validation complete.");
}
