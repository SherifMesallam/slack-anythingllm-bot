// src/handlers/messageHandler.js
// Handles core message processing, routing via Gemini, and interaction with LLMs/GitHub.

import {
    botUserId,
    githubWorkspaceSlug,
    formatterWorkspaceSlug,
    MIN_SUBSTANTIVE_RESPONSE_LENGTH,
    routingLlmApiKey, // Import the key to check if routing is enabled
} from '../config.js';
import {
    getAnythingLLMThreadMapping,
    storeAnythingLLMThreadMapping
} from '../services.js';
import {
    getWorkspaces,
    createNewAnythingLLMThread,
    queryLlm
} from '../llm.js';
import { classifyIntentWithGemini } from '../routingService.js'; // Import the new Gemini routing service
import {
    markdownToRichTextBlock,
    extractTextAndCode,
} from '../formattingService.js';
// Import ALL command handlers
import {
    handleDeleteLastMessageCommand,
    handleReleaseInfoCommand,
    handlePrReviewCommand,
    handleIssueAnalysisCommand,
    handleGithubApiCommand
} from './commandHandler.js'; // Ensure commandHandler is in the same directory

/**
 * Handles the core logic for processing an incoming Slack message event.
 * Determines context, routes via Gemini, handles commands, interacts with LLMs and GitHub, and sends responses.
 *
 * @param {object} event - The Slack message event object.
 * @param {import('@slack/web-api').WebClient} slack - The initialized Slack WebClient.
 * @param {object} appOctokitInstance - The initialized Octokit instance (or null).
 */
async function handleSlackMessageEventInternal(event, slack, appOctokitInstance) {
    const handlerStartTime = Date.now();
    const {
        user: userId,
        text: originalText = '',
        channel,
        ts: originalTs,
        thread_ts: threadTs
    } = event;

    // 1. Initial Processing & Context Setup
    let cleanedQuery = originalText.trim();
    const mentionString = `<@${botUserId}>`;
    if (cleanedQuery.includes(mentionString)) {
        cleanedQuery = cleanedQuery.replace(mentionString, '').trim();
    }
    const isDM = channel.startsWith('D');
    const replyTarget = threadTs || originalTs; // Always reply in thread if it exists
    console.log(`[Message Handler] Start. User: ${userId}, Chan: ${channel}, OrigTS: ${originalTs}, ThreadTS: ${threadTs}, ReplyTargetTS: ${replyTarget}, Query: "${cleanedQuery}"`);

    // 2. Handle #delete_last_message command (Bypass routing)
    if (cleanedQuery.toLowerCase().startsWith('#delete_last_message')) {
        console.log("[Message Handler] Delete command detected, calling command handler...");
        await handleDeleteLastMessageCommand(channel, replyTarget, botUserId, slack);
        console.log(`[Message Handler] Delete command handled. Duration: ${Date.now() - handlerStartTime}ms`);
        return; // Exit after handling delete command
    }

    // 3. Post Initial Processing Message (Asynchronously)
    let thinkingMessageTs = null;
    const thinkingMessagePromise = slack.chat.postMessage({
        channel,
        thread_ts: replyTarget,
        text: ":hourglass_flowing_sand: Processing..."
    }).then(initialMsg => {
        thinkingMessageTs = initialMsg.ts;
        console.log(`[Message Handler] Posted initial thinking message (ts: ${thinkingMessageTs}).`);
        return thinkingMessageTs;
    }).catch(slackError => {
        console.error("[Message Error] Failed post initial thinking message:", slackError.data?.error || slackError.message);
        return null; // Ensure promise resolves even on error
    });

    // 4. Determine AnythingLLM Thread and Workspace
    let anythingLLMThreadSlug = null;
    let workspaceSlugForThread = null;
    try {
        const existingMapping = await getAnythingLLMThreadMapping(channel, replyTarget);
        if (existingMapping) {
            anythingLLMThreadSlug = existingMapping.anythingllm_thread_slug;
            workspaceSlugForThread = existingMapping.anythingllm_workspace_slug;
            console.log(`[Message Handler] Found existing AnythingLLM thread: ${workspaceSlugForThread}:${anythingLLMThreadSlug} for Slack thread ${replyTarget}`);
        } else {
            console.log(`[Message Handler] No existing AnythingLLM thread found for Slack thread ${replyTarget}. Determining initial sphere...`);
            // TODO: Implement logic to determine initial workspace based on config (fallback, channel mapping, user mapping)
            // For now, defaulting to 'all' - REPLACE THIS WITH YOUR ACTUAL LOGIC
            let initialSphere = 'all'; // Example: Replace with proper logic
            const overrideRegex = /#(\S+)/;
            const match = cleanedQuery.match(overrideRegex);
            if (match && match[1]) {
                const potentialWorkspace = match[1];
                const availableWorkspaces = await getWorkspaces();
                if (availableWorkspaces.includes(potentialWorkspace)) {
                    initialSphere = potentialWorkspace;
                    console.log(`[Message Handler] Manual workspace override confirmed for NEW thread: "${initialSphere}".`);
                } else {
                    console.warn(`[Message Handler] Potential override "${potentialWorkspace}" not available. Using default: '${initialSphere}'.`);
                }
            } else {
                 console.log(`[Message Handler] No manual override found. Using default workspace for NEW thread: '${initialSphere}'.`);
            }

            workspaceSlugForThread = initialSphere; // Assign determined sphere
            anythingLLMThreadSlug = await createNewAnythingLLMThread(workspaceSlugForThread);
            if (!anythingLLMThreadSlug) {
                throw new Error(`Failed to create a new AnythingLLM thread in workspace ${workspaceSlugForThread}.`);
            }
            await storeAnythingLLMThreadMapping(channel, replyTarget, workspaceSlugForThread, anythingLLMThreadSlug);
            console.log(`[Message Handler] Created and stored new mapping: Slack ${channel}:${replyTarget} -> AnythingLLM ${workspaceSlugForThread}:${anythingLLMThreadSlug}`);
        }
    } catch (threadError) {
        console.error("[Message Handler] Error determining/creating AnythingLLM thread:", threadError);
        // Attempt to inform user, ignore error if it fails
        slack.chat.postMessage({
            channel,
            thread_ts: replyTarget,
            text: `⚠️ Oops! I had trouble connecting to the knowledge base thread. (${threadError.message})`
        }).catch(() => {});
        // Attempt to clean up thinking message
        thinkingMessagePromise.then(ts => {
            if (ts) slack.chat.delete({ channel: channel, ts: ts }).catch(() => {});
        });
        return; // Critical error, cannot proceed without a thread
    }

    // 5. --- Gemini Intent Classification Step ---
    let intentResult = { intent: 'routing_disabled', parameters: {} }; // Default if routing is off
    if (routingLlmApiKey) { // Only call if API key exists
        try {
            console.log("[Message Handler] Routing enabled. Calling Gemini for intent classification...");
            intentResult = await classifyIntentWithGemini(cleanedQuery);
        } catch (routingError) { // Catch potential unexpected errors in the Gemini service call itself
            console.error("[Message Handler] Critical error during Gemini routing call:", routingError);
            intentResult = { intent: 'routing_error', parameters: {} };
        }
    } else {
        console.log("[Message Handler] Gemini routing disabled via config. Skipping classification, assuming 'no_github_action'.");
        intentResult = { intent: 'no_github_action', parameters: {} }; // Treat as normal chat if routing is off
    }

    // 6. --- Route based on Intent Classification ---
    let commandHandled = false;
    switch (intentResult.intent) {
        case 'fetch_release':
            console.log("[Message Handler] Intent classified by Gemini as 'fetch_release'. Routing...");
            commandHandled = await handleReleaseInfoCommand(intentResult.parameters, replyTarget, slack, appOctokitInstance, thinkingMessagePromise, channel);
            break;
        case 'review_pr':
            console.log("[Message Handler] Intent classified by Gemini as 'review_pr'. Routing...");
            commandHandled = await handlePrReviewCommand(intentResult.parameters, replyTarget, channel, slack, appOctokitInstance, thinkingMessagePromise);
            break;
        case 'analyze_issue':
            console.log("[Message Handler] Intent classified by Gemini as 'analyze_issue'. Routing...");
            commandHandled = await handleIssueAnalysisCommand(intentResult.parameters, replyTarget, channel, slack, appOctokitInstance, thinkingMessagePromise, workspaceSlugForThread, anythingLLMThreadSlug);
            break;
        case 'generic_github_api':
            console.log("[Message Handler] Intent classified by Gemini as 'generic_github_api'. Routing...");
            commandHandled = await handleGithubApiCommand(intentResult.parameters, replyTarget, channel, slack, thinkingMessagePromise, githubWorkspaceSlug, formatterWorkspaceSlug);
            break;

        case 'no_github_action':
            console.log("[Message Handler] Intent classified by Gemini as 'no_github_action'. Proceeding to main LLM.");
            commandHandled = false; // Explicitly ensure fallback
            break;
        case 'routing_disabled':
            console.log("[Message Handler] Gemini routing was disabled. Proceeding to main LLM.");
            commandHandled = false; // Fallback
            break;
        case 'routing_error':
            console.warn("[Message Handler] Error during Gemini routing. Falling back to main LLM.");
            // Optionally post a subtle error message or just log it and proceed
            slack.chat.postMessage({ channel, thread_ts: replyTarget, text: "⚠️ Hmm, I had a little trouble understanding the request type. I'll try processing it normally." }).catch(()=>{});
            commandHandled = false; // Fallback
            break;
        default:
            console.warn(`[Message Handler] Unknown intent '${intentResult.intent}' from Gemini. Falling back to main LLM.`);
            commandHandled = false; // Fallback
            break;
    }

    // 7. --- Main Processing Logic (Fallback if no command handled) ---
    if (!commandHandled) {
        console.log("[Message Handler] No specific GitHub command handled by Gemini routing. Proceeding with default AnythingLLM query.");

        try {
            // Update Thinking Message (wait for it to be posted first)
            const messageTs = await thinkingMessagePromise;
            if (messageTs) {
                thinkingMessageTs = messageTs; // Ensure we have the TS if it succeeded
                try {
                    const thinkingMessages = [
                         ":brain: Thinking...",
                         ":gear: Processing...",
                         ":mag: Analyzing...",
                         ":nerd_face: Consulting knowledge base...",
                         ":robot_face: Compiling response...",
                         ":zap: Working on it...",
                    ];
                    const thinkingText = thinkingMessages[Math.floor(Math.random() * thinkingMessages.length)];
                    await slack.chat.update({
                        channel,
                        ts: thinkingMessageTs,
                        text: thinkingText
                    });
                    console.log(`[Message Handler] Updated thinking message (ts: ${thinkingMessageTs}) to: "${thinkingText}"`);
                } catch (updateError) {
                    // Non-fatal if update fails, log and continue
                    console.warn(`[Message Handler] Failed update thinking message:`, updateError.data?.error || updateError.message);
                }
            }

            // Construct LLM Input
            // TODO: Consider adding conversation history fetching here if desired for non-command flows
            let llmInputText = cleanedQuery;
            const instruction = '\n\nIMPORTANT: Please do not include context references (like "CONTEXT 0", "CONTEXT 1", etc.) in your response. Provide a clean, professional answer without these annotations, Please do not confirm that you understand my request, just understand it.';
            llmInputText += instruction;

            console.log(`[Message Handler] Sending query to AnythingLLM Thread ${workspaceSlugForThread}:${anythingLLMThreadSlug}...`);

            // Query LLM using thread endpoint
            const llmStartTime = Date.now();
            const rawReply = await queryLlm(workspaceSlugForThread, anythingLLMThreadSlug, llmInputText);
            console.log(`[Message Handler] LLM call duration: ${Date.now() - llmStartTime}ms`);
            if (!rawReply) throw new Error('LLM returned empty response.');
            console.log("[Message Handler Debug] Raw LLM Reply Received (length):", rawReply.length);

            // Process and Send Response
            let isSubstantiveResponse = rawReply.trim().length >= MIN_SUBSTANTIVE_RESPONSE_LENGTH;
            // Add more checks for canned responses if needed
            const lowerRawReplyTrimmed = rawReply.toLowerCase().trim();
            if (lowerRawReplyTrimmed.includes("i cannot provide assistance") || lowerRawReplyTrimmed.includes("i cannot answer")) {
                isSubstantiveResponse = false;
            }
            console.log(`[Message Handler] Response substantive check: ${isSubstantiveResponse}`);

            // Extract Segments (Text and Code)
            const segments = extractTextAndCode(rawReply);
            if (segments.length === 0) {
                 console.warn("[Message Handler] No text/code segments extracted from LLM response. Raw:", rawReply);
                 // Post raw reply if nothing else worked
                  await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: rawReply || "(Received empty response)" });
            }
            console.log(`[Message Handler] Extracted ${segments.length} segments (text/code).`);

            // Process and Send Each Segment
            let lastMessageTs = null;
            for (let i = 0; i < segments.length; i++) {
                const segment = segments[i];
                const isLastSegment = i === segments.length - 1;
                let blocksToSend = [];
                let fallbackText = '';

                if (segment.type === 'text') {
                    if (!segment.content || segment.content.trim().length === 0) continue;
                    const richTextBlock = markdownToRichTextBlock(segment.content, `msg_${Date.now()}_${i}`);
                    if (richTextBlock) {
                        blocksToSend.push(richTextBlock);
                        fallbackText = segment.content.replace(/\*\*|_|`|\[.*?\]\(.*?\)/g, '').substring(0, 200); // Basic fallback
                    } else {
                         console.warn("[Message Handler] Failed to create rich text block for text segment:", segment.content.substring(0, 100));
                         continue; // Skip empty/failed blocks
                    }
                } else if (segment.type === 'code') {
                    const language = segment.language || 'text';
                    if (!segment.content || segment.content.trim().length === 0) continue;
                    const inlineCodeContent = `\`\`\`${language}\n${segment.content}\`\`\``;
                    const richTextBlock = markdownToRichTextBlock(inlineCodeContent, `code_${Date.now()}_${i}`);
                     if (richTextBlock) {
                        blocksToSend.push(richTextBlock);
                        fallbackText = `Code Snippet (${language})`;
                    } else {
                         console.warn("[Message Handler] Failed to create rich text block for code segment.");
                         continue; // Skip empty/failed blocks
                    }
                }

                if (blocksToSend.length === 0) continue; // Skip if no block was generated

                // Post the message for the current segment
                try {
                    const postResult = await slack.chat.postMessage({
                        channel,
                        thread_ts: replyTarget,
                        text: fallbackText || "...", // Provide a fallback text
                        blocks: blocksToSend
                    });
                    lastMessageTs = postResult?.ts; // Store the TS of the last successfully posted message
                    console.log(`[Message Handler] Posted segment ${i + 1}/${segments.length} (ts: ${lastMessageTs}).`);
                } catch (postError) {
                    console.error(`[Message Handler] Error posting segment ${i + 1}:`, postError.data?.error || postError.message);
                    // Decide how to handle partial failures (e.g., try sending raw text? stop?)
                    await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: `⚠️ Error displaying part of the response. Raw segment: \`\`\`${segment.content}\`\`\``}).catch(() => {});
                }
            } // End segment loop

            // Post feedback buttons separately AFTER the last message segment
            if (lastMessageTs && isSubstantiveResponse) {
                try {
                    console.log(`[Message Handler DEBUG] Posting feedback buttons separately after final segment ${lastMessageTs}.`);
                    // Encode *only* a short preview or a placeholder, not the full message text
                    const feedbackContext = `origTS=${originalTs}_sphere=${workspaceSlugForThread}`;
                    const encodedContext = encodeURIComponent(feedbackContext); // Safer than encoding long text

                    const feedbackButtonElements = [
                        { "type": "button", "text": { "type": "plain_text", "text": "👎", "emoji": true }, "style": "danger", "value": "bad", "action_id": "feedback_bad" },
                        { "type": "button", "text": { "type": "plain_text", "text": "👌", "emoji": true }, "value": "ok", "action_id": "feedback_ok" },
                        { "type": "button", "text": { "type": "plain_text", "text": "👍", "emoji": true }, "style": "primary", "value": "great", "action_id": "feedback_great" }
                    ];
                    const finalFeedbackBlock = [
                        { "type": "divider" },
                        {
                            "type": "actions",
                            // Include original user message TS and sphere slug in block_id for context during interaction
                            "block_id": `feedback_${originalTs}_${workspaceSlugForThread}`, // Keep simple: origTS_sphere
                            "elements": feedbackButtonElements
                        }
                    ];
                    const feedbackPostResult = await slack.chat.postMessage({
                        channel,
                        thread_ts: replyTarget, // Post in the same thread
                        text: "Feedback:", // Fallback text
                        blocks: finalFeedbackBlock
                    });
                    console.log(`[Message Handler] Posted feedback buttons separately (ts: ${feedbackPostResult?.ts}).`);
                } catch (feedbackPostError) {
                    console.warn("[Message Handler] Failed to post feedback buttons:", feedbackPostError.data?.error || feedbackPostError.message);
                }
            } else if (!lastMessageTs) {
                 console.warn("[Message Handler] Could not post feedback buttons because last message TS was not available.");
            }

        } catch (error) {
            // Handle Errors during main processing
            console.error('[Message Handler Error - Main Path]', error);
            try {
                await slack.chat.postMessage({
                    channel,
                    thread_ts: replyTarget,
                    text: `⚠️ Oops! I encountered an error processing your request. (Workspace: ${workspaceSlugForThread || 'unknown'}, Error: ${error.message})`
                });
            } catch (slackError) {
                 console.error('[Message Handler Error] Failed to post error message to Slack:', slackError.data?.error || slackError.message);
            }
        } finally {
            // Cleanup Thinking Message (only if it was successfully posted)
            if (thinkingMessageTs) {
                try {
                    await slack.chat.delete({ channel: channel, ts: thinkingMessageTs });
                    console.log(`[Message Handler] Deleted thinking message (ts: ${thinkingMessageTs}).`);
                } catch (delErr) { console.warn("[Message Handler] Failed delete thinking message:", delErr.data?.error || delErr.message); }
            }
            const handlerEndTime = Date.now();
            console.log(`[Message Handler] Finished processing event (Main Path). Total duration: ${handlerEndTime - handlerStartTime}ms`);
        }
    } else {
        // This branch executes if a command was handled by the Gemini routing
        const handlerEndTime = Date.now();
        console.log(`[Message Handler] Command handled via Gemini routing. Skipping default LLM query. Duration: ${handlerEndTime - handlerStartTime}ms`);
        // Thinking message cleanup is handled *within* the command handlers in this case
    }
}

// --- History Fetching --- (Adapted from original handler)
async function fetchConversationHistory(channel, threadTs, originalTs, isDM) {
    const HISTORY_LIMIT = 10;
    let historyResult;
    try {
        if (!isDM && threadTs) {
            console.log(`[Slack Service/History] Fetching thread replies: Channel=${channel}, ThreadTS=${threadTs}`);
            historyResult = await slack.conversations.replies({
                channel: channel,
                ts: threadTs,
                limit: HISTORY_LIMIT + 1,
            });
        } else {
            console.log(`[Slack Service/History] Fetching channel/DM history: Channel=${channel}, Latest=${originalTs}, isDM=${isDM}`);
            historyResult = await slack.conversations.history({
                channel: channel,
                latest: originalTs,
                limit: HISTORY_LIMIT,
                inclusive: false
            });
        }

        if (historyResult.ok && historyResult.messages) {
            const relevantMessages = historyResult.messages
                .filter(msg => msg.user && msg.text && msg.user !== botUserId)
                .reverse();

            if (relevantMessages.length > 0) {
                let history = "Conversation History:\n";
                relevantMessages.forEach(msg => {
                    history += `User ${msg.user}: ${msg.text}\n`;
                });
                console.log(`[Slack Service/History] Fetched ${relevantMessages.length} relevant messages.`);
                return history;
            } else {
                console.log("[Slack Service/History] No relevant prior messages found.");
            }
        } else {
            console.warn("[Slack Service/History] Failed fetch history:", historyResult.error || "No messages found");
        }
    } catch (error) {
        console.error("[Slack Service/History Error]", error);
    }
    return ""; // Return empty string if no history or error
}
export { handleSlackMessageEventInternal };
