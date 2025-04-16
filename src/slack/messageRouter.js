// Routes incoming Slack message events
import logger from '../logger.js';
import {
    botUserId,
    githubFeaturesEnabled,
    commandPrefixes,
    intentRoutingEnabled, // Import flag
    possibleIntents, // Import possible intents list
    intentConfidenceThreshold, // Import threshold
    RESET_HISTORY_TTL // Use this TTL for confirmation state
} from '../config.js';
import {
    handleDeleteLastMessage,
    handleGithubReleaseCheck,
    handleExportCommand, // Import the new handler
    handleGithubPrefixedCommand, // Import the new handler
    handleGithubApiCommand, // <-- Import the new handler
    handleGithubIssueAnalysis, // <-- Import the new handler
    handleGithubPrReview // <-- Import the new handler
} from './commandHandlers.js';
import { handleLlmQuery } from './llmQueryHandler.js';
import { detectIntentAndWorkspace } from '../ai/intentDetectionService.js'; // Import intent detection service
import { getWorkspaces } from '../services/workspaceService.js'; // Import workspace service
import { startTimer, endTimer } from '../utils/performanceUtils.js'; // Import performance utils
import { redisClient, isRedisReady } from '../services.js'; // Import Redis client

/**
 * Routes incoming Slack message events to the appropriate handler.
 * @param {object} event - The Slack event object (e.g., from app_mention or message.channels).
 * @param {object} slackWebClient - The initialized Slack WebClient.
 * @returns {Promise<void>}
 */
export async function routeMessageEvent(event, slackWebClient) {
  // Ignore messages from the bot itself or without text
  if (event.user === botUserId || !event.text) {
    return;
  }

  const {
    user: userId,
    text: originalText = '',
    channel: channelId, // Rename for clarity
    ts: originalTs,
    thread_ts: threadTs // Might be undefined
  } = event;

  const isDM = channelId.startsWith('D'); // Assuming DMs start with 'D'
  const replyTarget = threadTs || originalTs; // Reply in thread if available, otherwise to the message

  // Basic text cleaning (more sophisticated cleaning might be needed later)
  // Remove mention if present (assuming format <@BOT_USER_ID>)
  const mentionString = `<@${botUserId}>`;
  const wasMentioned = originalText.includes(mentionString);
  let cleanedQuery = originalText.trim();
  if (cleanedQuery.startsWith(mentionString)) {
      cleanedQuery = cleanedQuery.substring(mentionString.length).trim();
  }

  const logContext = { userId, channelId, originalTs, threadTs, isDM, wasMentioned };
  logger.info({ ...logContext, query: cleanedQuery }, 'Received message event');

  // --- 1. Check for specific hardcoded commands / patterns ---

  // Check for #saveToConversations
  if (cleanedQuery.toLowerCase().includes('#savetoconversations')) {
    logger.debug(logContext, 'Detected #saveToConversations command');
    if (!threadTs) {
        logger.warn(logContext, '#saveToConversations used outside of a thread.');
        try {
            await slackWebClient.chat.postEphemeral({
                channel: channelId,
                user: userId,
                text: 'Please use `#saveToConversations` within the thread you want to save.',
            });
        } catch (e) { logger.error({ ...logContext, error: e }, 'Failed to post saveToConversations no thread message'); }
        return; // Exit if not in a thread
    }
    // Call the export handler
    handleExportCommand({ channelId, threadTs, userId, slackWebClient })
        .catch(err => logger.error({ ...logContext, error: err }, 'Error executing export handler via #saveToConversations'));
    return; // Command handled, exit routing
  }

  // Example: Delete last message
  if (cleanedQuery.toLowerCase().includes('#delete_last_message')) {
    logger.debug(logContext, 'Detected #delete_last_message command');
    await handleDeleteLastMessage({
        channel: channelId,
        originalTs,
        threadTs,
        replyTarget,
        slackWebClient,
        userId
    });
    return; // Command handled, exit routing
  }

  // Example: GitHub Release Check (only if feature enabled)
  if (githubFeaturesEnabled) {
      const releaseMatchRegex = /latest (?:gravityforms\/)?([\w-]+(?: addon| checkout)?|\S+) release/i;
      const releaseMatch = cleanedQuery.match(releaseMatchRegex);
      if (releaseMatch && releaseMatch[1]) {
          const productNameInput = releaseMatch[1];
          logger.debug({ ...logContext, productNameInput }, 'Detected GitHub release check command');
          await handleGithubReleaseCheck({
              channel: channelId,
              replyTarget,
              slackWebClient,
              productNameInput,
              userId
          });
          return; // Command handled, exit routing
      }
  }

  // --- 2. Check for command prefixes ---
  for (const [commandCategory, prefix] of Object.entries(commandPrefixes)) {
    if (cleanedQuery.toLowerCase().startsWith(prefix.toLowerCase())) {
        const commandArgs = cleanedQuery.substring(prefix.length).trim();
        const prefixLogContext = { ...logContext, commandCategory, prefix, commandArgs };
        logger.debug(prefixLogContext, 'Detected prefixed command');

        // Route to appropriate handler based on prefix category
        switch (commandCategory) {
            case 'github':
                if (githubFeaturesEnabled) {
                    logger.info(prefixLogContext, 'Routing to GitHub prefixed command handler');
                    // Call the actual handler
                    handleGithubPrefixedCommand(commandArgs, { channelId, replyTarget, slackWebClient, userId })
                        .catch(err => logger.error({ ...prefixLogContext, error: err }, 'Error executing github prefixed handler'));
                } else {
                    logger.warn(prefixLogContext, 'GitHub prefix detected but feature is disabled.');
                    try { // Notify user if feature disabled
                        await slackWebClient.chat.postMessage({ channel: channelId, thread_ts: replyTarget, text: 'GitHub commands are currently disabled.' });
                    } catch (e) { /* Ignore */ }
                }
                return; // Command handled (or ignored due to feature flag)

            case 'export':
                logger.info(prefixLogContext, 'Routing to Export command handler via prefix');
                // Ensure threadTs is available for export via prefix
                if (!threadTs) {
                    logger.warn(prefixLogContext, 'Export command prefix used outside of a thread.');
                    try {
                         await slackWebClient.chat.postMessage({ channel: channelId, text: 'Please use the export command within the thread you want to export.' });
                    } catch (e) { logger.error({ ...prefixLogContext, error: e }, 'Failed to post export prefix no thread message'); }
                    return;
                }
                handleExportCommand({ channelId, threadTs, userId, slackWebClient })
                     .catch(err => logger.error({ ...prefixLogContext, error: err }, 'Error executing export handler via prefix'));
                return; // Command handled

            case 'githubApi': // <-- Add case for the new category
                if (githubFeaturesEnabled) {
                    logger.info(prefixLogContext, 'Routing to GitHub API command handler');
                    handleGithubApiCommand(commandArgs, { channelId, replyTarget, slackWebClient, userId })
                        .catch(err => logger.error({ ...prefixLogContext, error: err }, 'Error executing github API handler'));
                } else {
                    logger.warn(prefixLogContext, 'GitHub API prefix detected but feature is disabled.');
                    try { // Notify user if feature disabled
                        await slackWebClient.chat.postMessage({ channel: channelId, thread_ts: replyTarget, text: 'GitHub API commands are currently disabled.' });
                    } catch (e) { /* Ignore */ }
                }
                return; // Command handled (or ignored due to feature flag)

            case 'githubAnalyzeIssue': // <-- Add case for issue analysis
                 if (githubFeaturesEnabled) {
                    logger.info(prefixLogContext, 'Routing to GitHub issue analysis handler');
                    handleGithubIssueAnalysis(commandArgs, { channelId, replyTarget, slackWebClient, userId })
                        .catch(err => logger.error({ ...prefixLogContext, error: err }, 'Error executing github issue analysis handler'));
                } else {
                    logger.warn(prefixLogContext, 'GitHub Analyze Issue prefix detected but feature is disabled.');
                    try { // Notify user if feature disabled
                        await slackWebClient.chat.postMessage({ channel: channelId, thread_ts: replyTarget, text: 'GitHub issue analysis commands are currently disabled.' });
                    } catch (e) { /* Ignore */ }
                }
                return; // Command handled (or ignored due to feature flag)

            case 'githubPrReview': // <-- Add case for PR review
                 if (githubFeaturesEnabled) {
                    logger.info(prefixLogContext, 'Routing to GitHub PR review handler');
                    handleGithubPrReview(commandArgs, { channelId, replyTarget, slackWebClient, userId })
                        .catch(err => logger.error({ ...prefixLogContext, error: err }, 'Error executing github PR review handler'));
                } else {
                    logger.warn(prefixLogContext, 'GitHub PR Review prefix detected but feature is disabled.');
                    try { // Notify user if feature disabled
                        await slackWebClient.chat.postMessage({ channel: channelId, thread_ts: replyTarget, text: 'GitHub PR review commands are currently disabled.' });
                    } catch (e) { /* Ignore */ }
                }
                return; // Command handled (or ignored due to feature flag)

            // Add cases for other prefixes here
            default:
                logger.warn(prefixLogContext, 'Detected known prefix but no handler defined for category');
                // Optionally send a message back
                // await slackWebClient.chat.postMessage({ channel, thread_ts: replyTarget, text: `Unknown command category for prefix \'${prefix}\'` });
                return; // Exit routing even if handler isn't defined for known prefix
        }
    }
  }

  // --- 3. Check intent routing (if enabled) ---
  let suggestedWorkspace = null; // Default to null, will be passed to LLM handler
  let intent = null;
  let confidence = 0;

  if (intentRoutingEnabled) {
       const intentTimer = startTimer();
       logger.debug(logContext, 'Intent routing enabled, checking intent...');
       try {
            const availableWorkspaces = await getWorkspaces(); // Fetch available workspaces (cached)
            const wsSlugs = availableWorkspaces.map(ws => ws.slug);

            const result = await detectIntentAndWorkspace(cleanedQuery, possibleIntents, wsSlugs);
            intent = result.intent;
            confidence = result.confidence;
            suggestedWorkspace = result.suggestedWorkspace; // Capture suggestion

            logger.debug({ ...logContext, intent, confidence, suggestedWorkspace }, 'Intent detection result');
            endTimer(intentTimer, 'detectIntentAndWorkspace', logContext);

            if (intent && confidence >= intentConfidenceThreshold) {
                 logger.info({ ...logContext, intent, confidence }, 'Routing based on high-confidence intent');
                // Map intent to specific command handler or potentially modify query for LLM
                switch (intent) {
                    case 'export_thread':
                        logger.info({ ...logContext, intent }, 'Routing to Export command handler via intent');
                         // Ensure threadTs is available for export via intent
                        if (!threadTs) {
                            logger.warn({ ...logContext, intent }, 'Export thread intent detected outside of a thread.');
                            try {
                                 await slackWebClient.chat.postMessage({ channel: channelId, text: 'Please trigger thread exports from within the thread itself.' });
                            } catch (e) { logger.error({ ...logContext, error: e }, 'Failed to post export intent no thread message'); }
                             return;
                        }
                        handleExportCommand({ channelId, threadTs, userId, slackWebClient })
                            .catch(err => logger.error({ ...logContext, error: err }, 'Error executing export handler via intent'));
                        return; // Handled
                    case 'delete_message':
                        logger.info({ ...logContext, intent }, 'Intent mapped to delete message, calling handler.');
                        // This might overlap with the hardcoded check, but good for consistency
                        await handleDeleteLastMessage({ channel: channelId, originalTs, threadTs, replyTarget, slackWebClient, userId });
                        return;
                    case 'github_release_check': {
                        logger.info({ ...logContext, intent }, 'Intent mapped to github release check.');
                        // Attempt to extract product name using the same regex as the command check
                        const releaseMatchRegex = /latest (?:gravityforms\/)?([\w-]+(?: addon| checkout)?|\S+) release/i;
                        const releaseMatch = cleanedQuery.match(releaseMatchRegex);
                        if (releaseMatch && releaseMatch[1]) {
                            const productNameInput = releaseMatch[1];
                            logger.debug({ ...logContext, productNameInput }, 'Extracted product name for release check intent');
                            // Call the handler directly if argument found
                            await handleGithubReleaseCheck({
                                channel: channelId,
                                replyTarget,
                                slackWebClient,
                                productNameInput,
                                userId
                            });
                            return; // Handled
                        } else {
                            logger.warn({ ...logContext, intent }, 'Could not extract product name from query for github_release_check intent. Falling through.');
                            // Fall through to default LLM if extraction fails
                            break;
                        }
                    }
                    // --- Cases for other GitHub intents (Log and Fall Through for now) ---
                    case 'github_issue_details':
                    case 'github_pr_details':
                    case 'github_api_call':
                    case 'github_issue_analysis':
                    case 'github_pr_review':
                         logger.info({ ...logContext, intent }, `Detected high-confidence intent: ${intent}. Passing to general LLM handler.`);
                         // Add specific handling here later if argument extraction from natural language becomes feasible
                         // For now, fall through to the default case
                         break;

                    case 'general_query':
                    default:
                         logger.debug({ ...logContext, intent }, 'Intent is general query or unmapped, proceeding to LLM handler.');
                        // Fall through to LLM handler, suggestedWorkspace will be passed
                        break;
                }
            } else if (intent) { // Low confidence intent - **IMPLEMENT CONFIRMATION**
                logger.info({ ...logContext, intent, confidence }, 'Low confidence intent detected, asking for confirmation');

                if (!isRedisReady || !redisClient) {
                    logger.warn({ ...logContext, intent }, 'Redis not available, cannot store state for intent confirmation. Falling back to LLM.');
                    // Fall through to LLM handler if Redis isn't working
                } else {
                    // 1. Define state to store
                    const confirmationState = JSON.stringify({
                        intent,
                        suggestedWorkspace,
                        userId,
                        channelId,
                        replyTarget,
                        originalTs,
                        cleanedQuery // Store original query for context if needed
                    });

                    // 2. Generate Redis key (use originalTs for uniqueness within TTL)
                    const redisKey = `intent_confirm:${channelId}:${originalTs}`;
                    const stateTTL = RESET_HISTORY_TTL || 300; // Use config TTL or default 5 mins

                    try {
                        // 3. Store state in Redis
                        await redisClient.set(redisKey, confirmationState, { EX: stateTTL });
                        logger.debug({ ...logContext, redisKey, ttl: stateTTL }, 'Stored intent confirmation state in Redis');

                        // 4. Construct confirmation message blocks
                        const confirmationBlockId = `intent_confirm:${channelId}:${originalTs}`; // Match Redis key structure
                        const confirmationText = `🤔 I think you might want to perform the action: *${intent}* ${suggestedWorkspace ? `(using workspace *${suggestedWorkspace}*)` : ''}. Is that correct?`;
                        const confirmationBlocks = [
                            {
                                "type": "section",
                                "text": { "type": "mrkdwn", "text": confirmationText }
                            },
                            {
                                "type": "actions",
                                "block_id": confirmationBlockId,
                                "elements": [
                                    {
                                        "type": "button",
                                        "text": { "type": "plain_text", "text": "Yes", "emoji": true },
                                        "style": "primary",
                                        "value": "yes",
                                        "action_id": "intent_confirm_yes"
                                    },
                                    {
                                        "type": "button",
                                        "text": { "type": "plain_text", "text": "No", "emoji": true },
                                        "style": "danger",
                                        "value": "no",
                                        "action_id": "intent_confirm_no"
                                    }
                                ]
                            }
                        ];

                        // 5. Post confirmation message
                        await slackWebClient.chat.postMessage({
                            channel: channelId,
                            thread_ts: replyTarget,
                            text: confirmationText, // Fallback text
                            blocks: confirmationBlocks
                        });
                        logger.info({ ...logContext, redisKey }, 'Posted intent confirmation message with buttons.');

                    } catch (redisError) {
                        logger.error({ ...logContext, error: redisError }, 'Failed to store intent confirmation state in Redis. Falling back to LLM.');
                        // Fall through to LLM if Redis fails
                    }
                    return; // Exit routing, wait for confirmation interaction
                } // End Redis check
            } // End low confidence block
       } catch (intentError) {
            endTimer(intentTimer, 'detectIntentAndWorkspace', { ...logContext, error: true });
            logger.error({ ...logContext, error: intentError }, 'Error during intent detection phase.');
            // Fall through to LLM handler as a safe default
       }
  }

  // --- 4. Fallback to LLM query handler ---
  logger.debug({ ...logContext, suggestedWorkspace }, 'Falling back to LLM query handler');
  await handleLlmQuery({
    query: cleanedQuery,
    userId,
    channelId,
    threadTs,
    originalTs,
    isDM,
    isMention: wasMentioned,
    replyTarget,
    suggestedWorkspace, // Pass suggestion from intent routing (will be null if disabled or no suggestion)
    slackWebClient
  });
}
