// Routes incoming Slack message events
import logger from '../logger.js';
import {
    config,
    botUserId,
    githubFeaturesEnabled,
    intentRoutingEnabled, // Import flag
    possibleIntents, // Import possible intents list
    intentConfidenceThreshold, // Import threshold
    RESET_HISTORY_TTL // Use this TTL for confirmation state
} from '../config.js';
import {
    handleDeleteLastMessage,
    handleGithubReleaseCheck,
    handleExportCommand, // Import the new handler
    handleGithubPrefixedCommand, // No longer called directly by router
    handleGithubApiCommand,
    handleGithubIssueAnalysis,
    handleGithubPrReview
} from './commandHandlers.js';
import { handleLlmQuery } from './llmQueryHandler.js';
import { detectIntentAndWorkspace } from '../ai/intentDetectionService.js'; // Import intent detection service
import { getWorkspaces } from '../services/workspaceService.js'; // Import workspace service
import { startTimer, endTimer } from '../utils/performanceUtils.js'; // Import performance utils
import { redisClient, isRedisReady } from '../services.js'; // Import Redis client

/**
 * Routes incoming Slack message events to the appropriate handler.
 * Prioritizes intent detection if enabled.
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
  const mentionString = `<@${botUserId}>`;
  const wasMentioned = originalText.includes(mentionString);
  let cleanedQuery = originalText.trim();
  if (cleanedQuery.startsWith(mentionString)) {
      cleanedQuery = cleanedQuery.substring(mentionString.length).trim();
  }

  const logContext = { userId, channelId, originalTs, threadTs, isDM, wasMentioned };
  logger.info({ ...logContext, query: cleanedQuery }, 'Received message event');

  let intentRouted = false; // Flag to check if intent routing handled the message
  let suggestedWorkspace = null; // Store suggestion for fallback

  // --- 1. Prioritize Intent Detection (if enabled) ---
  if (intentRoutingEnabled) {
       const intentTimer = startTimer();
       logger.debug(logContext, 'Intent routing enabled, checking intent first...');
       try {
            const availableWorkspaces = await getWorkspaces(); // Fetch available workspaces (cached)
            const wsSlugs = availableWorkspaces.map(ws => ws.slug);

            // Returns { intent, confidence, suggestedWorkspace, arguments (maybe future) }
            const result = await detectIntentAndWorkspace(cleanedQuery, possibleIntents, wsSlugs);
            const { intent, confidence } = result;
            suggestedWorkspace = result.suggestedWorkspace; // Capture suggestion for potential fallback
            // TODO: Use result.arguments in the future if implemented

            logger.debug({ ...logContext, intent, confidence, suggestedWorkspace }, 'Intent detection result');
            endTimer(intentTimer, 'detectIntentAndWorkspace', logContext);

            // --- A. High Confidence Intent Routing ---
            if (intent && confidence >= intentConfidenceThreshold) {
                logger.info({ ...logContext, intent, confidence }, 'Routing based on high-confidence intent');
                let handled = true; // Assume handled unless explicitly falling through

                switch (intent) {
                    case 'export_thread':
                        logger.info({ ...logContext, intent }, 'Routing to Export command handler via intent');
                        if (!threadTs) {
                            logger.warn({ ...logContext, intent }, 'Export thread intent detected outside of a thread.');
                            try {
                                 await slackWebClient.chat.postMessage({ channel: channelId, text: 'Please trigger thread exports from within the thread itself.' });
                            } catch (e) { logger.error({ ...logContext, error: e }, 'Failed to post export intent no thread message'); }
                            // Return without setting handled=true, maybe? Or just let it be handled.
                        } else {
                            handleExportCommand({ channelId, threadTs, userId, slackWebClient })
                                .catch(err => logger.error({ ...logContext, error: err }, 'Error executing export handler via intent'));
                        }
                        break; // Exit switch

                    case 'delete_message':
                        logger.info({ ...logContext, intent }, 'Intent mapped to delete message, calling handler.');
                        await handleDeleteLastMessage({ channel: channelId, originalTs, threadTs, replyTarget, slackWebClient, userId });
                        break; // Exit switch

                    case 'github_release_check': {
                        logger.info({ ...logContext, intent }, 'Intent mapped to github release check.');
                        const releaseMatchRegex = /latest (?:gravityforms\/)?([\w-]+(?: addon| checkout)?|\S+) release/i;
                        const releaseMatch = cleanedQuery.match(releaseMatchRegex);
                        if (releaseMatch && releaseMatch[1]) {
                            const productNameInput = releaseMatch[1];
                            logger.debug({ ...logContext, productNameInput }, 'Extracted product name for release check intent');
                            await handleGithubReleaseCheck({ channel: channelId, replyTarget, slackWebClient, productNameInput, userId });
                        } else {
                            logger.warn({ ...logContext, intent }, 'Could not extract product name from query for github_release_check intent. Falling through to general query.');
                            handled = false; // Fall through
                        }
                        break; // Exit switch
                    }

                    // Intents requiring arguments we cannot reliably extract yet - Log and Fall Through
                    case 'github_issue_details':
                    case 'github_pr_details':
                    case 'github_api_call':
                    case 'github_issue_analysis':
                    case 'github_pr_review':
                         logger.info({ ...logContext, intent }, `Detected high-confidence intent: ${intent}, but requires specific arguments. Passing to general LLM handler.`);
                         handled = false; // Fall through to general query handler
                         break;

                    case 'general_query':
                    default:
                        logger.debug({ ...logContext, intent }, 'Intent is general query or unmapped. Proceeding to general LLM handler.');
                        handled = false; // Fall through to general query handler
                        break;
                }

                if (handled) {
                    intentRouted = true; // Mark as handled by intent routing
                }
            }
            // --- B. Low Confidence Intent Confirmation ---
            else if (intent) {
                logger.info({ ...logContext, intent, confidence }, 'Low confidence intent detected, asking for confirmation');
                if (!isRedisReady || !redisClient) {
                    logger.warn({ ...logContext, intent }, 'Redis not available, cannot store state for intent confirmation. Falling back to LLM.');
                    // Fall through to LLM handler if Redis isn't working
                } else {
                    const confirmationState = JSON.stringify({ intent, suggestedWorkspace, userId, channelId, replyTarget, originalTs, cleanedQuery });
                    const redisKey = `intent_confirm:${channelId}:${originalTs}`;
                    const stateTTL = RESET_HISTORY_TTL || 300;
                    try {
                        await redisClient.set(redisKey, confirmationState, { EX: stateTTL });
                        const confirmationBlockId = `intent_confirm:${channelId}:${originalTs}`;
                        const confirmationText = `🤔 I think you might want to perform the action: *${intent}* ${suggestedWorkspace ? `(using workspace *${suggestedWorkspace}*)` : ''}. Is that correct?`;
                        const confirmationBlocks = [
                           { "type": "section", "text": { "type": "mrkdwn", "text": confirmationText } },
                           { "type": "actions", "block_id": confirmationBlockId, "elements": [
                               { "type": "button", "text": { "type": "plain_text", "text": "Yes", "emoji": true }, "style": "primary", "value": "yes", "action_id": "intent_confirm_yes" },
                               { "type": "button", "text": { "type": "plain_text", "text": "No", "emoji": true }, "style": "danger", "value": "no", "action_id": "intent_confirm_no" }
                           ] }
                        ];
                        await slackWebClient.chat.postMessage({ channel: channelId, thread_ts: replyTarget, text: confirmationText, blocks: confirmationBlocks });
                        logger.info({ ...logContext, redisKey }, 'Posted intent confirmation message with buttons.');
                        intentRouted = true; // Mark as handled (waiting for interaction)
                    } catch (redisError) {
                        logger.error({ ...logContext, error: redisError }, 'Failed to store intent confirmation state in Redis. Falling back to LLM.');
                        // Fall through to LLM if Redis fails
                    }
                } // End Redis check
            } // End low confidence block

       } catch (intentError) {
            endTimer(intentTimer, 'detectIntentAndWorkspace', { ...logContext, error: true });
            logger.error({ ...logContext, error: intentError }, 'Error during intent detection phase. Falling back to LLM handler.');
            // Fall through to LLM handler as a safe default
       }
  } // End of if (intentRoutingEnabled)


  // --- 2. Fallback to LLM Query Handler ---
  // Only proceed if intent routing was disabled, failed, or explicitly fell through
  if (!intentRouted) {
    logger.debug({ ...logContext, suggestedWorkspace }, 'Falling back to LLM query handler (intent not handled or disabled).');
    // Pass the cleanedQuery and any suggestedWorkspace from the intent step
    handleLlmQuery({ // Use handleLlmQuery directly
        query: cleanedQuery,
        userId,
        channelId,
        threadTs,
        originalTs,
        isDM,
        isMention: wasMentioned,
        replyTarget,
        suggestedWorkspace, // Pass suggestion from intent routing
        slackWebClient
    }).catch(err => logger.error({ ...logContext, error: err }, 'Error executing fallback LLM Query handler'));
  }
  // else: Message was handled by intent routing (either directly or via confirmation prompt)

  // --- OLD Pattern/Prefix Checks REMOVED --- 

} 