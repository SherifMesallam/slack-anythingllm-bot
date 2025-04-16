// Handler for general LLM queries
import logger from '../logger.js';
import { config, botUserId, feedbackEnabled, MIN_SUBSTANTIVE_RESPONSE_LENGTH } from '../config.js';
import { determineWorkspace } from '../services/workspaceService.js'; // Import workspace determination
import { getAnythingLLMThreadMapping, storeAnythingLLMThreadMapping } from '../services.js'; // Assuming DB functions are still in services.js
import { queryLlm, createNewAnythingLLMThread } from '../llm.js';
import { fetchConversationHistory } from '../utils/historyUtils.js'; // Import history fetcher
import { startTimer, endTimer } from '../utils/performanceUtils.js'; // Import performance utils
import {
    splitMessageIntoChunks,
    formatSlackMessage, // Assuming this formats for rich text primarily
    markdownToRichTextBlock, // Use this for converting markdown segments
    extractTextAndCode, // Use this to segment the LLM response
    getSlackFiletype // For potential file uploads (like JSON)
} from '../utils.js'; // Assuming formatting utils are here

/**
 * Handles a general query to the LLM.
 * Fetches history, determines workspace, interacts with AnythingLLM, formats response.
 * @param {object} params
 * @param {string} params.query - The cleaned user query.
 * @param {string} params.userId - Slack User ID.
 * @param {string} params.channelId - Slack Channel ID.
 * @param {string|null} params.threadTs - Slack thread timestamp (if applicable).
 * @param {string} params.originalTs - Timestamp of the original user message.
 * @param {boolean} params.isDM - True if the message is a Direct Message.
 * @param {boolean} params.isMention - True if the bot was mentioned.
 * @param {string} params.replyTarget - The Slack TS to reply in (threadTs or originalTs).
 * @param {string|null} params.suggestedWorkspace - Optional workspace suggested by intent routing.
 * @param {object} params.slackWebClient - The initialized Slack WebClient.
 * @returns {Promise<void>}
 */
export async function handleLlmQuery({
    query,
    userId,
    channelId,
    threadTs,
    originalTs,
    isDM,
    isMention,
    replyTarget,
    suggestedWorkspace,
    slackWebClient
}) {
    const llmHandlerStartTime = startTimer();
    const logContext = { userId, channelId, threadTs, originalTs, isDM, isMention, replyTarget, suggestedWorkspace };
    logger.info({ ...logContext, query }, 'Handling LLM query request');

    let thinkingMessageTs = null;
    let thinkingMessagePromise = null;
    let anythingLLMThreadSlug = null;
    let workspaceSlugForQuery = null;

    // --- Define query variable that might be modified ---
    let effectiveQuery = query; // Start with the original cleaned query

    try {
        // --- 1. Post Initial Thinking Message (Asynchronously) ---
        const thinkingMessages = [
            ":rocket: Blasting off to knowledge orbit...",
            ":alien: Consulting my alien overlords...",
            ":milky_way: Searching the cosmic database...",
            ":satellite: Sending signals to distant star systems...",
            ":ringed_planet: Circling Saturn for answers...",
            ":full_moon: Moonwalking through data...",
            ":dizzy: Getting lost in a black hole of information...",
            ":flying_saucer: Abducting relevant facts...",
            ":astronaut: Spacewalking through code repositories...",
            ":stars: Counting stars while the database loads...",
            ":comet: Riding this comet to find your answer...",
            ":telescope: Peering into the knowledge universe...",
            ":robot_face: Engaging hyperdrive processors...",
        ];
        const thinkingText = thinkingMessages[Math.floor(Math.random() * thinkingMessages.length)];

        thinkingMessagePromise = slackWebClient.chat.postMessage({
            channel: channelId,
            thread_ts: replyTarget,
            text: thinkingText
        }).then(initialMsg => {
            thinkingMessageTs = initialMsg.ts;
            logger.debug({ ...logContext, ts: thinkingMessageTs, text: thinkingText }, 'Posted initial thinking message');
            return thinkingMessageTs;
        }).catch(slackError => {
            logger.error({ ...logContext, error: slackError }, "Failed post initial thinking message");
            return null; // Allow process to continue, but log error
        });

        // --- 2. Check for Manual Workspace Override ---
        let manualWorkspaceOverride = null;
        const workspaceOverrideRegex = /\s+#workspace=(\S+)/i; // Matches #workspace=slug at end or preceded by space
        const overrideMatch = effectiveQuery.match(workspaceOverrideRegex);

        if (overrideMatch && overrideMatch[1]) {
            manualWorkspaceOverride = overrideMatch[1];
            // Remove the override from the query text
            effectiveQuery = effectiveQuery.replace(workspaceOverrideRegex, '').trim();
            logger.info({ ...logContext, manualWorkspace: manualWorkspaceOverride, newQuery: effectiveQuery }, 'Manual workspace override detected');
            // Optional: Validate manualWorkspaceOverride against getWorkspaces() results here?
        }

        // --- 3. Determine Workspace (unless overridden) ---
        const wdTimer = startTimer();
        if (manualWorkspaceOverride) {
            workspaceSlugForQuery = manualWorkspaceOverride;
            logger.info({ ...logContext, workspaceSlug: workspaceSlugForQuery }, 'Using manual workspace override');
        } else {
            workspaceSlugForQuery = await determineWorkspace({ suggestedWorkspace, userId, channelId });
            logger.info({ ...logContext, workspaceSlug: workspaceSlugForQuery }, 'Determined workspace for query');
        }
        endTimer(wdTimer, 'determineWorkspace', logContext);

        if (!workspaceSlugForQuery) {
            logger.error(logContext, 'Failed to determine a valid workspace. Aborting query.');
            // Maybe post a message back to the user
            await slackWebClient.chat.postMessage({ channel: channelId, thread_ts: replyTarget, text: "Sorry, I couldn't figure out which knowledge base to use for your request." });
            throw new Error('Workspace determination failed'); // Throw to trigger finally cleanup
        }
        // Log the *final* workspace used
        logger.info({ ...logContext, finalWorkspaceSlug: workspaceSlugForQuery }, 'Final workspace selected for query');

        // --- 4. Determine AnythingLLM Thread ---
        const threadTimer = startTimer();
        const existingMapping = await getAnythingLLMThreadMapping(channelId, replyTarget);
        if (existingMapping) {
            // Verify workspace consistency if possible (optional)
            if (existingMapping.anythingllm_workspace_slug !== workspaceSlugForQuery) {
                logger.warn({ ...logContext, existingWs: existingMapping.anythingllm_workspace_slug, determinedWs: workspaceSlugForQuery }, 'Existing thread mapping workspace differs from determined workspace. Using existing mapping.');
                workspaceSlugForQuery = existingMapping.anythingllm_workspace_slug; // Prefer existing thread's workspace
            }
            anythingLLMThreadSlug = existingMapping.anythingllm_thread_slug;
            logger.info({ ...logContext, workspaceSlug: workspaceSlugForQuery, threadSlug: anythingLLMThreadSlug }, 'Found existing AnythingLLM thread mapping');
        } else {
            logger.info({ ...logContext, workspaceSlug: workspaceSlugForQuery }, 'No existing thread mapping found, creating new AnythingLLM thread');
            anythingLLMThreadSlug = await createNewAnythingLLMThread(workspaceSlugForQuery);
            if (!anythingLLMThreadSlug) {
                throw new Error(`Failed to create a new AnythingLLM thread in workspace ${workspaceSlugForQuery}.`);
            }
            await storeAnythingLLMThreadMapping(channelId, replyTarget, workspaceSlugForQuery, anythingLLMThreadSlug);
            logger.info({ ...logContext, workspaceSlug: workspaceSlugForQuery, threadSlug: anythingLLMThreadSlug }, 'Created and stored new AnythingLLM thread mapping');
        }
        endTimer(threadTimer, 'determineAnythingLLMThread', logContext);

        // --- 5. Fetch History (if needed) ---
        let historyText = "";
        // Fetch history only if mentioned in a thread (to avoid pulling history for general channel chat)
        if (isMention && threadTs) {
            const historyTimer = startTimer();
            historyText = await fetchConversationHistory({ channel: channelId, threadTs, originalTs, isDM, slackWebClient });
            endTimer(historyTimer, 'fetchConversationHistory', { ...logContext, historyFound: !!historyText });
            logger.debug({ ...logContext, historyFound: !!historyText }, 'Fetched conversation history');
        }

        // --- 6. Construct LLM Input ---
        // Use the potentially modified effectiveQuery here
        let llmInputText = effectiveQuery;
        if (historyText) {
            llmInputText = `${historyText}\n\nLatest question: ${effectiveQuery}`;
        }
        // Add instruction to avoid context tags
        const instruction = '\n\nIMPORTANT: Please do not include context references (like "CONTEXT 0", "CONTEXT 1", etc.) in your response. Provide a clean, professional answer without these annotations.';
        llmInputText += instruction;
        logger.debug({ ...logContext, workspaceSlug: workspaceSlugForQuery, threadSlug: anythingLLMThreadSlug }, 'Constructed LLM input');

        // --- 7. Query LLM ---
        const llmTimer = startTimer();
        const rawReply = await queryLlm(workspaceSlugForQuery, anythingLLMThreadSlug, llmInputText);
        endTimer(llmTimer, 'queryLlm', { ...logContext, workspaceSlug: workspaceSlugForQuery, threadSlug: anythingLLMThreadSlug });
        if (!rawReply) {
            throw new Error('LLM returned an empty or null response.');
        }
        logger.debug({ ...logContext, replyLength: rawReply.length }, 'Received raw reply from LLM');

        // --- 8. Process and Send Response ---
        const processTimer = startTimer();

        // 8a. Check for Substantive Response
        let isSubstantiveResponse = true;
        const lowerRawReplyTrimmed = rawReply.toLowerCase().trim();
        if (lowerRawReplyTrimmed.length < MIN_SUBSTANTIVE_RESPONSE_LENGTH) {
            isSubstantiveResponse = false;
        } else {
            const exactNonSubstantive = ['ok', 'done', 'hello', 'hi', 'hey', 'thanks', 'thank you'];
            if (exactNonSubstantive.includes(lowerRawReplyTrimmed)) {
                isSubstantiveResponse = false;
            }
        }
        // Add more checks if needed (e.g., startsWith patterns)
        logger.debug({ ...logContext, isSubstantive: isSubstantiveResponse }, 'Checked response substantiveness');

        // 8b. Extract Segments (Text/Code)
        const segments = extractTextAndCode(rawReply);
        logger.debug({ ...logContext, segmentCount: segments.length }, 'Extracted response segments');

        // 8c. Process and Send Each Segment
        let mainMessageTs = null;
        let accumulatedFallbackText = ''; // Accumulate text for feedback block ID

        for (let i = 0; i < segments.length; i++) {
            const segment = segments[i];
            const blocksToSend = [];
            let segmentFallbackText = '';

            if (segment.type === 'text' && segment.content?.trim()) {
                const richTextBlock = markdownToRichTextBlock(segment.content, `msg_${Date.now()}_${i}`);
                if (richTextBlock) {
                    blocksToSend.push(richTextBlock);
                    segmentFallbackText = segment.content.replace(/\*\*|_|_|`|\[.*?\]\(.*?\)/g, '').substring(0, 200);
                }
            } else if (segment.type === 'code' && segment.content?.trim()) {
                const language = segment.language || 'text';
                const inlineCodeContent = `\`\`\`${language}\n${segment.content}\`\`\``;
                const richTextBlock = markdownToRichTextBlock(inlineCodeContent, `code_${Date.now()}_${i}`);
                if (richTextBlock) {
                    blocksToSend.push(richTextBlock);
                    segmentFallbackText = `Code Snippet (${language})`;
                }
            }

            if (blocksToSend.length > 0) {
                accumulatedFallbackText += segmentFallbackText + ' ';
                try {
                    const postResult = await slackWebClient.chat.postMessage({
                        channel: channelId,
                        thread_ts: replyTarget,
                        text: segmentFallbackText,
                        blocks: blocksToSend
                    });
                    if (!mainMessageTs) mainMessageTs = postResult?.ts; // Store TS of the first successful message
                    logger.debug({ ...logContext, segment: i + 1, ts: postResult?.ts }, 'Posted response segment');
                } catch (postError) {
                    logger.error({ ...logContext, segment: i + 1, error: postError }, 'Failed to post response segment');
                    // Attempt to post simplified error for this segment
                    try {
                        await slackWebClient.chat.postMessage({ channel: channelId, thread_ts: replyTarget, text: `_(Error displaying part ${i + 1} of the response)_` });
                    } catch { /* Ignore */ }
                }
                 // Add delay between messages if needed
                if (segments.length > 1 && i < segments.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            }
        } // End segment loop

        // 8d. Post Feedback Buttons (if applicable)
        if (feedbackEnabled && isSubstantiveResponse && mainMessageTs) {
            try {
                 const feedbackButtonElements = [
                    { "type": "button", "text": { "type": "plain_text", "text": "👎", "emoji": true }, "style": "danger", "value": "-1", "action_id": "feedback_bad" },
                    // { "type": "button", "text": { "type": "plain_text", "text": "👌", "emoji": true }, "value": "0", "action_id": "feedback_ok" }, // Optional neutral
                    { "type": "button", "text": { "type": "plain_text", "text": "👍", "emoji": true }, "style": "primary", "value": "1", "action_id": "feedback_good" }
                ];
                // Block ID format: feedback_originalUserMessageTs_workspaceSlug_botMessageTs_encodedText
                const safeFallbackText = accumulatedFallbackText.trim().substring(0, 100); // Limit text for block ID
                const encodedFallback = encodeURIComponent(safeFallbackText);
                const feedbackBlockId = `feedback_${originalTs}_${workspaceSlugForQuery}_${mainMessageTs}_${encodedFallback}`.substring(0, 255); // Ensure total length <= 255

                const finalFeedbackBlock = [
                    { "type": "divider" },
                    { "type": "actions", "block_id": feedbackBlockId, "elements": feedbackButtonElements }
                ];
                const feedbackPostResult = await slackWebClient.chat.postMessage({
                    channel: channelId,
                    thread_ts: replyTarget,
                    text: "Was this helpful?", // Fallback text
                    blocks: finalFeedbackBlock
                });
                 logger.debug({ ...logContext, ts: feedbackPostResult?.ts }, 'Posted feedback buttons');
            } catch (feedbackError) {
                logger.error({ ...logContext, error: feedbackError }, 'Failed to post feedback buttons');
            }
        }
        endTimer(processTimer, 'processAndSendResponse', logContext);

    } catch (error) {
        logger.error({ ...logContext, error }, 'Error during LLM query handling pipeline');
        // Attempt to send error message back to user
        try {
            await slackWebClient.chat.postMessage({
                channel: channelId,
                thread_ts: replyTarget,
                text: `⚠️ Oops! I encountered an error processing your request.${workspaceSlugForQuery ? ` (Workspace: ${workspaceSlugForQuery})` : ''}`
            });
        } catch (slackError) {
            logger.error({ ...logContext, error: slackError }, 'Failed to post error message to Slack');
        }
    } finally {
        // --- Cleanup Thinking Message --- (ensure promise is resolved)
        if (thinkingMessagePromise) {
            thinkingMessageTs = await thinkingMessagePromise;
        }
        if (thinkingMessageTs) {
            try {
                await slackWebClient.chat.delete({ channel: channelId, ts: thinkingMessageTs });
                logger.debug({ ...logContext, ts: thinkingMessageTs }, 'Deleted thinking message');
            } catch (delErr) {
                // Ignore error if message was already deleted or couldn't be found
                if (delErr.data?.error !== 'message_not_found') {
                     logger.warn({ ...logContext, ts: thinkingMessageTs, error: delErr }, 'Failed to delete thinking message');
                }
            }
        }
        endTimer(llmHandlerStartTime, 'handleLlmQuery (total)', logContext);
    }
} 