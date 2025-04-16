// Handles incoming Slack interactions (slash commands, button clicks)
import logger from '../logger.js';
import { botUserId, feedbackEnabled, githubFeaturesEnabled } from '../config.js';
import {
    redisClient,
    isRedisReady,
    storeFeedback // Assuming storeFeedback is in services.js
} from '../services.js';
import {
    handleDeleteLastMessage,
    handleExportCommand, // Import handler
    handleGithubReleaseCheck, // Import release check handler
    handleGithubPrefixedCommand, // Import general gh- handler
} from './commandHandlers.js';
import { handleLlmQuery } from './llmQueryHandler.js';

/**
 * Handles incoming Slack interactions (slash commands, button clicks, etc.).
 * @param {object} payload - The interaction payload from Slack.
 * @param {object} slackWebClient - The initialized Slack WebClient.
 */
export async function handleInteraction(payload, slackWebClient) {
    const interactionType = payload.type;
    const user = payload.user;
    const logContext = { interactionType, userId: user?.id, triggerId: payload.trigger_id };
    logger.debug(logContext, 'Handling interaction');

    try {
        if (interactionType === 'block_actions' && payload.actions?.[0]) {
            const action = payload.actions[0];
            const actionId = action.action_id;
            const blockId = action.block_id;
            const channelId = payload.channel?.id;
            const messageTs = payload.message?.ts;

            // --- Handle Intent Confirmation Buttons ---
            if (actionId === 'intent_confirm_yes' || actionId === 'intent_confirm_no') {
                 logger.info({ ...logContext, actionId, blockId }, 'Handling intent confirmation action');

                 if (!isRedisReady || !redisClient) {
                     logger.error({ ...logContext, actionId }, 'Redis not available, cannot process intent confirmation.');
                     // Try to update the message to show an error
                     if (channelId && messageTs) {
                         await slackWebClient.chat.update({
                             channel: channelId, ts: messageTs, blocks: [],
                             text: '❌ Sorry, I cannot process this confirmation right now (Redis unavailable). Please try your request again.'
                         });
                     }
                     return;
                 }

                 // Extract key from block_id (e.g., intent_confirm:C123:1234.567)
                 const redisKey = blockId; // Assuming block_id is the exact Redis key
                 if (!redisKey || !redisKey.startsWith('intent_confirm:')) {
                     logger.error({ ...logContext, blockId }, 'Invalid block_id for intent confirmation.');
                     return;
                 }

                 // Get state from Redis AND delete it immediately to prevent replay
                 let storedStateJSON;
                 try {
                     storedStateJSON = await redisClient.getDel(redisKey);
                 } catch (redisError) {
                      logger.error({ ...logContext, redisKey, error: redisError }, 'Error getting/deleting state from Redis.');
                      // Update message to indicate transient error
                      if (channelId && messageTs) {
                          await slackWebClient.chat.update({
                              channel: channelId, ts: messageTs, blocks: [],
                              text: '❌ Sorry, there was an error retrieving the confirmation details. Please try your request again.'
                          });
                      }
                      return;
                 }

                 if (!storedStateJSON) {
                     logger.warn({ ...logContext, redisKey }, 'Intent confirmation state not found or expired in Redis.');
                     // Update the original message to indicate expiry
                     if (channelId && messageTs) {
                         await slackWebClient.chat.update({
                             channel: channelId, ts: messageTs, blocks: [],
                             text: '⏳ This confirmation request has expired. Please try your request again.'
                         });
                     }
                     return;
                 }

                 // Parse the state
                 let confirmationState;
                 try {
                     confirmationState = JSON.parse(storedStateJSON);
                 } catch (parseError) {
                     logger.error({ ...logContext, redisKey, error: parseError }, 'Failed to parse stored confirmation state.');
                     // Update message
                     if (channelId && messageTs) {
                          await slackWebClient.chat.update({
                              channel: channelId, ts: messageTs, blocks: [],
                              text: '❌ Sorry, there was an internal error processing the confirmation details. Please try your request again.'
                          });
                     }
                     return;
                 }

                 const { intent, suggestedWorkspace, cleanedQuery, replyTarget: stateReplyTarget, originalTs: stateOriginalTs, channelId: stateChannelId, userId: stateUserId } = confirmationState;

                 // --- Process Yes/No --- 
                 if (actionId === 'intent_confirm_yes') {
                    logger.info({ ...logContext, intent, suggestedWorkspace }, 'User confirmed intent.');
                    // Update the confirmation message
                     if (channelId && messageTs) {
                         await slackWebClient.chat.update({
                             channel: channelId, ts: messageTs, blocks: [],
                             text: `✅ Okay, proceeding with action: *${intent}*...`
                         });
                     }

                    // Call the appropriate handler asynchronously
                    // Important: Use context stored in Redis state, NOT from the interaction payload
                    switch (intent) {
                        case 'export_thread':
                             logger.warn({ ...logContext, intent }, 'Confirmed export thread intent but handler not implemented.');
                            // TODO: Call handleExportCommand({ channelId: stateChannelId, threadTs: stateReplyTarget, slackWebClient, userId: stateUserId });
                            break;
                        case 'delete_message':
                            handleDeleteLastMessage({ channel: stateChannelId, originalTs: stateOriginalTs, threadTs: stateReplyTarget, replyTarget: stateReplyTarget, slackWebClient, userId: stateUserId })
                                .catch(err => logger.error({ ...logContext, intent, error: err }, 'Error executing confirmed delete handler'));
                            break;
                        case 'general_query':
                        default:
                            handleLlmQuery({ query: cleanedQuery, userId: stateUserId, channelId: stateChannelId, threadTs: stateReplyTarget, originalTs: stateOriginalTs, isDM: stateChannelId.startsWith('D'), isMention: true, replyTarget: stateReplyTarget, suggestedWorkspace, slackWebClient })
                                .catch(err => logger.error({ ...logContext, intent, error: err }, 'Error executing confirmed LLM query handler'));
                            break;
                    }

                 } else { // intent_confirm_no
                    logger.info({ ...logContext, intent }, 'User rejected intent.');
                    // Update the confirmation message
                     if (channelId && messageTs) {
                         await slackWebClient.chat.update({
                             channel: channelId, ts: messageTs, blocks: [],
                             text: '❌ Okay, cancelled. Please feel free to rephrase your request or ask something else.'
                         });
                     }
                    // No further action needed
                 }

            // --- Handle Feedback Buttons ---
            } else if (actionId.startsWith('feedback_')) {
                logger.info({ ...logContext, actionId }, 'Handling feedback action');
                if (!feedbackEnabled) {
                    logger.warn({ ...logContext, actionId }, 'Feedback received but feature is disabled.');
                    return; // Ignore if feedback is disabled
                }

                const feedbackValue = action.value;
                let originalQuestionTs = null;
                let responseSphere = null;
                let encodedFallbackText = null;
                let botMessageTs = messageTs; // TS of the message containing the button

                // Extract context from block_id (feedback_originalUserMessageTs_workspaceSlug_botMessageTs_encodedText)
                if (blockId?.startsWith('feedback_')) {
                    const parts = blockId.substring(9).split('_');
                    if (parts.length >= 4) {
                        originalQuestionTs = parts[0];
                        responseSphere = parts[1];
                        botMessageTs = parts[2]; // Overwrite with TS from ID if present
                        encodedFallbackText = parts.slice(3).join('_');
                    } else {
                         logger.warn({ ...logContext, blockId }, 'Could not parse all expected parts from feedback block_id');
                    }
                }

                let botMessageText = null;
                if (encodedFallbackText) {
                    try { botMessageText = decodeURIComponent(encodedFallbackText); }
                    catch (e) { logger.warn({ ...logContext, blockId }, 'Failed to decode text from feedback block_id'); }
                }
                if (!botMessageText) {
                    botMessageText = payload.message?.text; // Fallback
                }

                // Fetch original user message text (best effort)
                let originalUserMessageText = null;
                if (originalQuestionTs && channelId) {
                    try {
                        const historyResult = await slackWebClient.conversations.history({ channel: channelId, latest: originalQuestionTs, oldest: originalQuestionTs, inclusive: true, limit: 1 });
                        if (historyResult.ok && historyResult.messages?.[0]?.text) {
                            originalUserMessageText = historyResult.messages[0].text;
                        }
                    } catch (historyError) {
                        logger.warn({ ...logContext, error: historyError }, 'Could not fetch original user message text for feedback');
                    }
                }

                // Prepare data and store feedback (run async)
                storeFeedback({
                    feedback_value: parseInt(feedbackValue, 10) || 0, // Ensure number (e.g., 1, -1)
                    user_id: user.id,
                    channel_id: channelId,
                    bot_message_ts: botMessageTs,
                    original_user_message_ts: originalQuestionTs,
                    action_id: actionId,
                    sphere_slug: responseSphere,
                    bot_message_text: botMessageTs,
                    original_user_message_text: originalUserMessageText
                }).catch(err => logger.error({ ...logContext, error: err }, 'Failed to store feedback'));

                // Update the message UI immediately
                 try {
                    const originalBlocks = payload.message?.blocks;
                    if (originalBlocks && originalBlocks.length > 0) {
                        const actionBlockIndex = originalBlocks.findIndex(b => b.type === 'actions' && b.block_id === blockId);
                        if (actionBlockIndex !== -1) {
                            const updatedBlocks = [
                                ...originalBlocks.slice(0, actionBlockIndex),
                                { "type": "context", "elements": [ { "type": "mrkdwn", "text": `🙏 Thanks for the feedback!` } ] }
                            ];
                             await slackWebClient.chat.update({
                                channel: channelId,
                                ts: messageTs,
                                text: payload.message?.text + "\n\n🙏 Thanks!",
                                blocks: updatedBlocks
                            });
                        } else {
                             logger.warn({ ...logContext, blockId }, 'Could not find action block to update for feedback');
                        }
                    }
                } catch (updateError) {
                    logger.warn({ ...logContext, error: updateError }, "Failed to update feedback message UI");
                }
            }

            // --- Add other block action handlers here ---

        } else if (interactionType === 'slash_command') {
            const command = payload.command;
            const text = payload.text?.trim() || ''; // Arguments provided by user
            const channelId = payload.channel_id;
            const userId = payload.user_id;
            // Slash commands don't reliably provide thread context unless invoked from menu
            // Use payload.channel_id and assume no thread_ts for general slash commands
            const replyTarget = payload.thread_ts || channelId; // Might just be channel ID
            const commandLogContext = { ...logContext, command, text, channelId, userId };
            logger.info(commandLogContext, 'Handling slash command');

            // Acknowledge command immediately to avoid timeout warning in Slack
            // For commands that might take longer, we need to send a deferred response later
            // res.status(200).send(); // Acknowledge immediately - moved to app.js for non-commands

            // Route command (asynchronously)
            switch (command) {
                 case '/export':
                     logger.info(commandLogContext, 'Routing to Export command handler via slash command');
                     try {
                         await slackWebClient.chat.postEphemeral({
                             channel: channelId,
                             user: userId,
                             text: `⏳ Received /export command. Exporting thread... (Note: Slash commands export the main thread message's context)`
                         });
                     } catch (e) { logger.error({ ...commandLogContext, error: e }, 'Failed to send ephemeral ack for /export'); }
                     // Call handler asynchronously. Note: threadTs from slash commands is tricky.
                     // Slack often sends the channelId and the ts of the command message itself.
                     // We might need the user to *be in* the thread for this to work as expected,
                     // or parse arguments if they specify a thread_ts.
                     // For now, assume it exports the thread the command was invoked *on* (if any).
                     // We pass `payload.message_ts` or similar if available and makes sense, otherwise null.
                     // Let the handler deal with null threadTs.
                     handleExportCommand({ channelId, threadTs: payload.thread_ts || null, userId, slackWebClient })
                        .catch(err => logger.error({ ...commandLogContext, error: err }, 'Error executing export handler via slash command'));
                     break;
                 case '/github': { // Handle /github command
                    const args = text.split(/\s+/);
                    const subCommand = args[0]?.toLowerCase();
                    const subCommandArgs = args.slice(1).join(' '); // Rest of the text as args
                    const githubLogContext = { ...commandLogContext, subCommand, subCommandArgs };

                    logger.info(githubLogContext, 'Handling /github slash command');

                    // Send immediate ephemeral ack
                    try {
                        await slackWebClient.chat.postEphemeral({
                            channel: channelId,
                            user: userId,
                            text: `⏳ Received your \`/github ${subCommand}\` command. Processing...`
                        });
                    } catch (e) { logger.error({ ...githubLogContext, error: e }, 'Failed to send ephemeral ack for /github'); }

                    // Check feature flag before calling handlers - Use direct variable
                    if (!githubFeaturesEnabled) {
                         logger.warn(githubLogContext, 'GitHub features disabled, ignoring /github command.');
                         // Maybe update the ephemeral message? Requires response_url or further logic.
                         return;
                     }

                    // Call the appropriate handler based on sub-command
                    // Reuse the logic/handlers from the prefixed commands
                    switch (subCommand) {
                        case 'release':
                            // handleGithubPrefixedCommand handles owner/repo parsing
                            handleGithubPrefixedCommand(`release ${subCommandArgs}`, { channelId, replyTarget, slackWebClient, userId })
                                .catch(err => logger.error({ ...githubLogContext, error: err }, 'Error executing github release handler via slash command'));
                            break;
                        case 'issue':
                             handleGithubPrefixedCommand(`issue ${subCommandArgs}`, { channelId, replyTarget, slackWebClient, userId })
                                .catch(err => logger.error({ ...githubLogContext, error: err }, 'Error executing github issue handler via slash command'));
                            break;
                        case 'pr':
                            handleGithubPrefixedCommand(`pr ${subCommandArgs}`, { channelId, replyTarget, slackWebClient, userId })
                                .catch(err => logger.error({ ...githubLogContext, error: err }, 'Error executing github pr handler via slash command'));
                            break;
                        case 'api': // Handle /github api
                            handleGithubApiCommand(subCommandArgs, { channelId, replyTarget, slackWebClient, userId })
                                .catch(err => logger.error({ ...githubLogContext, error: err }, 'Error executing github api handler via slash command'));
                            break;
                        case 'review-pr': // Handle /github review-pr
                            handleGithubPrReview(subCommandArgs, { channelId, replyTarget, slackWebClient, userId })
                                .catch(err => logger.error({ ...githubLogContext, error: err }, 'Error executing github pr review handler via slash command'));
                            break;
                        case 'analyze-issue': // Handle /github analyze-issue
                            handleGithubIssueAnalysis(subCommandArgs, { channelId, replyTarget, slackWebClient, userId })
                                .catch(err => logger.error({ ...githubLogContext, error: err }, 'Error executing github issue analysis handler via slash command'));
                            break;
                        default:
                            logger.warn(githubLogContext, 'Unknown /github sub-command');
                             try {
                                // Update ephemeral message if possible, or post new one
                                await slackWebClient.chat.postEphemeral({
                                    channel: channelId,
                                    user: userId,
                                    text: `Sorry, I don\'t recognize the sub-command \\\"${subCommand}\\\" for \`/github\`. Try \`release\`, \`issue\`, or \`pr\`.`
                                });
                             } catch (e) { logger.error({ ...githubLogContext, error: e }, 'Failed to send ephemeral unknown /github sub-command message'); }
                    }
                    break; // End /github case
                 }
                // Add other slash command cases
                default:
                    logger.warn(commandLogContext, 'Received unknown slash command');
                     try {
                         await slackWebClient.chat.postEphemeral({
                             channel: channelId,
                             user: userId,
                             text: `Sorry, I don\'t recognize the command \\\"${command}\\\".`
                         });
                     } catch (e) { logger.error({ ...commandLogContext, error: e }, 'Failed to send ephemeral unknown command message'); }
            }
             // Since we handle slash commands async after ack, ensure app.js sends final 200 OK if needed.
        }

        // --- Add handlers for other interaction types (view_submission, etc.) ---

    } catch (error) {
        logger.error({ ...logContext, error }, 'Top-level error in interaction handler');
    }
} 