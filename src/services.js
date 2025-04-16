import { createClient } from 'redis';
import pg from 'pg';
import { Octokit } from '@octokit/rest';
import { redisUrl, databaseUrl, botUserId, developerId, feedbackEnabled, githubToken, githubFeaturesEnabled } from './config.js';
import logger from './logger.js';

// --- Redis Client Setup ---
export let redisClient;
export let isRedisReady = false;

if (redisUrl) {
    console.log("[Service Init] Configuring Redis...");
    redisClient = createClient({
        url: redisUrl,
        socket: { reconnectStrategy: retries => Math.min(retries * 100, 3000) },
    });
    redisClient.on('error', err => { console.error('Redis error:', err); isRedisReady = false; });
    redisClient.on('connect', () => console.log('Redis connecting...'));
    redisClient.on('ready', () => { console.log('Redis connected!'); isRedisReady = true; });
    redisClient.on('end', () => { console.log('Redis connection closed.'); isRedisReady = false; });
    redisClient.connect().catch(err => {
        console.error("Initial Redis connection failed:", err);
        // Optionally exit if Redis is critical
        // process.exit(1);
    });
} else {
    console.warn("[Service Init] Redis URL not provided. Using dummy Redis client.");
    redisClient = {
        isReady: false,
        set: async () => null, get: async() => null, del: async() => 0,
        on: () => {}, connect: async () => {}, isOpen: false, quit: async () => {}
    };
}

// --- Database Setup (PostgreSQL Example) ---
export let dbPool;

if (databaseUrl) {
    console.log("[Service Init] Configuring Database Pool...");
    dbPool = new pg.Pool({
        connectionString: databaseUrl,
        // ssl: { rejectUnauthorized: false } // Uncomment/adjust if needed
    });
    dbPool.on('error', (err, client) => {
         console.error('Unexpected DB pool error', err);
    });
} else {
    console.warn("[Service Init] Database URL not provided. Using dummy DB pool.");
    dbPool = {
        query: async (...args) => {
             console.warn("DB query attempted but DATABASE_URL not set. Args:", args);
             return { rows: [{ id: null }], rowCount: 0, command: 'INSERT' };
        },
        connect: async () => ({
            query: async (...args) => {
                console.warn("DB query attempted on dummy client but DATABASE_URL not set. Args:", args);
                return { rows: [{ id: null }], rowCount: 0, command: 'INSERT' };
            },
            release: () => {}
        })
    };
}

// --- GitHub Service (Octokit) ---
let octokit = null;
if (githubFeaturesEnabled && githubToken) {
    logger.info('[GitHub Service] Initializing Octokit...');
    octokit = new Octokit({ auth: githubToken });
} else if (githubFeaturesEnabled && !githubToken) {
    logger.warn('[GitHub Service] GitHub features enabled but GITHUB_TOKEN not set. GitHub features will be unavailable.');
} else {
    logger.info('[GitHub Service] GitHub features are disabled.');
}

/**
 * Fetches the latest release for a given GitHub repository.
 * @param {string} owner - The repository owner.
 * @param {string} repo - The repository name.
 * @returns {Promise<{tagName: string, publishedAt: string, url: string} | null>} Release details or null if not found/error/disabled.
 */
export async function getLatestRelease(owner, repo) {
    // Check if feature enabled and client initialized
    if (!githubFeaturesEnabled || !octokit) {
        logger.warn({ owner, repo }, "Attempted to get latest release but GitHub features are disabled or Octokit not initialized.");
        return null;
    }

    if (!owner || !repo) {
        logger.error('[GitHub Service] getLatestRelease requires owner and repo arguments.');
        return null;
    }

    const logContext = { owner, repo };
    logger.debug(logContext, 'Fetching latest release from GitHub');
    try {
        const response = await octokit.repos.getLatestRelease({ owner, repo });
        if (response.status === 200 && response.data) {
            logger.info({ ...logContext, tag: response.data.tag_name }, 'Found latest release');
            return {
                tagName: response.data.tag_name,
                publishedAt: response.data.published_at,
                url: response.data.html_url
            };
        } else {
            // This case might not be reachable if getLatestRelease throws on non-200
            logger.warn({ ...logContext, status: response.status }, 'Unexpected response status from GitHub API for latest release');
            return null;
        }
    } catch (error) {
        if (error.status === 404) {
            // 404 is common if a repo exists but has no releases yet
            logger.info({ ...logContext }, 'No releases found for repository (404).');
        } else {
            // Log other errors more verbosely
            logger.error({ ...logContext, status: error.status, message: error.message, error }, 'Error fetching latest release from GitHub');
        }
        return null;
    }
}

/**
 * Fetches basic details for a specific Pull Request.
 * @param {string} owner - The repository owner.
 * @param {string} repo - The repository name.
 * @param {number} pullNumber - The PR number.
 * @returns {Promise<{title: string, url: string, state: string, user: string, body: string | null} | null>} PR details or null.
 */
export async function getPrDetails(owner, repo, pullNumber) {
    if (!githubFeaturesEnabled || !octokit) {
        logger.warn({ owner, repo, pullNumber }, "Attempted to get PR details but GitHub features are disabled or Octokit not initialized.");
        return null;
    }
    if (!owner || !repo || !pullNumber) {
        logger.error('[GitHub Service] getPrDetails requires owner, repo, and pullNumber.');
        return null;
    }

    const logContext = { owner, repo, pullNumber };
    logger.debug(logContext, 'Fetching PR details from GitHub');
    try {
        const { data: pr } = await octokit.pulls.get({
            owner,
            repo,
            pull_number: pullNumber,
        });
        logger.info({ ...logContext, title: pr.title }, 'Found PR details');
        return {
            title: pr.title,
            url: pr.html_url,
            state: pr.state, // e.g., 'open', 'closed'
            user: pr.user?.login || 'unknown',
            body: pr.body
        };
    } catch (error) {
        logger.error({ ...logContext, status: error.status, message: error.message, error }, 'Error fetching PR details from GitHub');
        return null;
    }
}

/**
 * Fetches the list of files changed in a specific Pull Request.
 * @param {string} owner - The repository owner.
 * @param {string} repo - The repository name.
 * @param {number} pullNumber - The PR number.
 * @returns {Promise<Array<{filename: string, status: string, changes: number, additions: number, deletions: number}> | null>} Array of file details or null.
 */
export async function getPrFiles(owner, repo, pullNumber) {
    if (!githubFeaturesEnabled || !octokit) {
        logger.warn({ owner, repo, pullNumber }, "Attempted to get PR files but GitHub features are disabled or Octokit not initialized.");
        return null;
    }
    if (!owner || !repo || !pullNumber) {
        logger.error('[GitHub Service] getPrFiles requires owner, repo, and pullNumber.');
        return null;
    }

    const logContext = { owner, repo, pullNumber };
    logger.debug(logContext, 'Fetching PR files from GitHub');
    try {
        // GitHub API might paginate this, fetch all pages if necessary (up to a limit)
        const files = await octokit.paginate(octokit.pulls.listFiles, {
            owner,
            repo,
            pull_number: pullNumber,
            per_page: 100, // Max per page
        });

        logger.info({ ...logContext, fileCount: files.length }, 'Found PR files');
        return files.map(file => ({
            filename: file.filename,
            status: file.status, // e.g., 'added', 'modified', 'removed'
            changes: file.changes,
            additions: file.additions,
            deletions: file.deletions
        }));
    } catch (error) {
        logger.error({ ...logContext, status: error.status, message: error.message, error }, 'Error fetching PR files from GitHub');
        return null;
    }
}

/**
 * Fetches the diff for a specific Pull Request.
 * @param {string} owner - The repository owner.
 * @param {string} repo - The repository name.
 * @param {number} pullNumber - The PR number.
 * @returns {Promise<string | null>} The diff content as a string or null.
 */
export async function getPrDiff(owner, repo, pullNumber) {
    if (!githubFeaturesEnabled || !octokit) {
        logger.warn({ owner, repo, pullNumber }, "Attempted to get PR diff but GitHub features are disabled or Octokit not initialized.");
        return null;
    }
    if (!owner || !repo || !pullNumber) {
        logger.error('[GitHub Service] getPrDiff requires owner, repo, and pullNumber.');
        return null;
    }

    const logContext = { owner, repo, pullNumber };
    logger.debug(logContext, 'Fetching PR diff from GitHub');
    try {
        const { data: diff } = await octokit.pulls.get({
            owner,
            repo,
            pull_number: pullNumber,
            mediaType: {
                format: 'diff' // Request the diff format
            }
        });
        logger.info({ ...logContext, diffLength: diff?.length }, 'Found PR diff');
        return diff; // Returns the diff content as a string
    } catch (error) {
        logger.error({ ...logContext, status: error.status, message: error.message, error }, 'Error fetching PR diff from GitHub');
        return null;
    }
}

// Graceful shutdown function for services
export async function shutdownServices(signal) {
    console.log(`${signal} signal received: closing service connections.`);
    if (redisClient?.isOpen) {
        try {
            await redisClient.quit();
            console.log('Redis connection closed gracefully.');
        } catch(err) {
            console.error('Error closing Redis connection:', err);
        }
    }
    if (dbPool && databaseUrl) {
        try {
            await dbPool.end();
            console.log('Database pool closed gracefully.');
        } catch (err) {
            console.error('Error closing Database pool:', err);
        }
    }
}

// --- Slack/AnythingLLM Thread Mapping --- 

/**
 * Retrieves the AnythingLLM thread mapping for a given Slack thread.
 * Updates the last_accessed_at timestamp.
 * @param {string} channelId - The Slack channel ID.
 * @param {string} slackThreadTs - The starting timestamp of the Slack thread.
 * @returns {Promise<{anythingllm_thread_slug: string, anythingllm_workspace_slug: string} | null>} Mapping object or null if not found.
 */
export async function getAnythingLLMThreadMapping(channelId, slackThreadTs) {
    if (!dbPool || !databaseUrl) {
        console.warn("[Service/ThreadMap] DB unavailable, cannot get mapping.");
        return null;
    }
    const selectQuery = `
        SELECT anythingllm_thread_slug, anythingllm_workspace_slug
        FROM slack_anythingllm_threads
        WHERE slack_channel_id = $1 AND slack_thread_ts = $2;`;
    const updateAccessTimeQuery = `
        UPDATE slack_anythingllm_threads
        SET last_accessed_at = CURRENT_TIMESTAMP
        WHERE slack_channel_id = $1 AND slack_thread_ts = $2;`;

    let client;
    try {
        client = await dbPool.connect();
        // Select first
        const result = await client.query(selectQuery, [channelId, slackThreadTs]);
        if (result.rows.length > 0) {
            const mapping = result.rows[0];
            console.log(`[Service/ThreadMap] Found mapping: Slack ${channelId}:${slackThreadTs} -> AnythingLLM ${mapping.anythingllm_workspace_slug}:${mapping.anythingllm_thread_slug}`);
            // Update access time asynchronously (don't wait for it)
            client.query(updateAccessTimeQuery, [channelId, slackThreadTs])
                .catch(err => console.error("[Service/ThreadMap] Failed update access time:", err));
            return mapping;
        } else {
            console.log(`[Service/ThreadMap] No mapping found for Slack ${channelId}:${slackThreadTs}`);
            return null;
        }
    } catch (err) {
        console.error("[Service/ThreadMap DB Error] Failed getting mapping:", err);
        return null;
    } finally {
        if (client) client.release();
    }
}

/**
 * Stores a new mapping between a Slack thread and an AnythingLLM thread.
 * @param {string} channelId - The Slack channel ID.
 * @param {string} slackThreadTs - The starting timestamp of the Slack thread.
 * @param {string} workspaceSlug - The AnythingLLM workspace slug.
 * @param {string} anythingLLMThreadSlug - The AnythingLLM thread slug.
 * @returns {Promise<boolean>} True if successful, false otherwise.
 */
export async function storeAnythingLLMThreadMapping(channelId, slackThreadTs, workspaceSlug, anythingLLMThreadSlug) {
    if (!dbPool || !databaseUrl) {
        console.warn("[Service/ThreadMap] DB unavailable, cannot store mapping.");
        return false;
    }
    const insertQuery = `
        INSERT INTO slack_anythingllm_threads 
            (slack_channel_id, slack_thread_ts, anythingllm_workspace_slug, anythingllm_thread_slug)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (slack_channel_id, slack_thread_ts) DO NOTHING; -- Avoid errors if mapping somehow already exists
    `;
    let client;
    try {
        client = await dbPool.connect();
        const result = await client.query(insertQuery, [channelId, slackThreadTs, workspaceSlug, anythingLLMThreadSlug]);
        console.log(`[Service/ThreadMap] Stored mapping: Slack ${channelId}:${slackThreadTs} -> AnythingLLM ${workspaceSlug}:${anythingLLMThreadSlug}. Result rows: ${result.rowCount}`);
        return result.rowCount > 0;
    } catch (err) {
        console.error("[Service/ThreadMap DB Error] Failed storing mapping:", err);
        return false;
    } finally {
        if (client) client.release();
    }
}

// --- Feedback Storage ---
/**
 * Stores user feedback received from Slack interactions into the database.
 * Checks the feedbackEnabled feature flag before proceeding.
 * @param {object} feedbackData - Object containing feedback details.
 * @param {number|null} feedbackData.feedback_value - e.g., 1 for positive, -1 for negative.
 * @param {string|null} feedbackData.user_id - Slack User ID.
 * @param {string|null} feedbackData.channel_id - Slack Channel ID.
 * @param {string|null} feedbackData.bot_message_ts - Timestamp of the bot message being reacted to.
 * @param {string|null} feedbackData.original_user_message_ts - Timestamp of the original user message.
 * @param {string|null} feedbackData.action_id - ID of the action triggering feedback (e.g., button ID).
 * @param {string|null} feedbackData.sphere_slug - Workspace slug associated with the interaction.
 * @param {string|null} feedbackData.bot_message_text - Text content of the bot message.
 * @param {string|null} feedbackData.original_user_message_text - Text content of the original user message.
 * @returns {Promise<void>}
 */
export async function storeFeedback(feedbackData) {
    // Check feature flag first
    if (!feedbackEnabled) {
        logger.debug('Feedback system is disabled. Skipping feedback storage.');
        return;
    }

    // Check if DB is available
    if (!dbPool) {
        logger.warn({ feedbackData }, "Database not configured, cannot store feedback. Logging to console instead.");
        // Fallback to console logging if DB is down but feature is enabled
        logger.info({ feedbackData }, "--- FEEDBACK (Console Log) ---");
        return;
    }

    const insertQuery = `
        INSERT INTO feedback (feedback_value, user_id, channel_id, bot_message_ts, original_user_message_ts, action_id, sphere_slug, bot_message_text, original_user_message_text)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id;`;
    // Map feedbackData to values, ensuring null if undefined/missing
    const values = [
        feedbackData.feedback_value ?? null,
        feedbackData.user_id ?? null,
        feedbackData.channel_id ?? null,
        feedbackData.bot_message_ts ?? null,
        feedbackData.original_user_message_ts ?? null,
        feedbackData.action_id ?? null,
        feedbackData.sphere_slug ?? null,
        feedbackData.bot_message_text ?? null,
        feedbackData.original_user_message_text ?? null
    ];

    const logContext = {
        user: values[1],
        value: values[0],
        channel: values[2],
        bot_ts: values[3],
        sphere: values[6]
    };

    let client;
    try {
        client = await dbPool.connect();
        logger.debug(logContext, 'Inserting feedback into database');
        const result = await client.query(insertQuery, values);
        if (result.rows?.[0]?.id) {
             logger.info({ ...logContext, feedbackId: result.rows[0].id }, 'Feedback saved successfully');
        } else {
             logger.warn(logContext, 'Feedback insert query executed but did not return ID.');
        }
    } catch (err) {
        logger.error({ ...logContext, error: err }, 'Database error storing feedback');
    } finally {
        if (client) client.release();
    }
} 