
// src/handlers/messageHandler.js
// Handles core message processing, command pattern matching (`gh>`), and interaction with LLMs/GitHub.

import {
    botUserId,
    githubWorkspaceSlug,
    formatterWorkspaceSlug,
    MIN_SUBSTANTIVE_RESPONSE_LENGTH,
    GITHUB_OWNER, // Import default owner
    githubToken, // Import to check if GH features are enabled
    enableUserWorkspaces, // Import for workspace logic
    userWorkspaceMapping, // Import for workspace logic
    workspaceMapping, // Import for workspace logic
    fallbackWorkspace, // Import for workspace logic
    WORKSPACE_OVERRIDE_COMMAND_PREFIX, // Import '#'
} from '../config.js';
import {
    getAnythingLLMThreadMapping,
    storeAnythingLLMThreadMapping,
    // dbPool, // Import if needed for feedback/other DB ops within this file
    // storeFeedback // Import if needed
} from '../services.js';
import {
    getWorkspaces,
    createNewAnythingLLMThread,
    queryLlm
} from '../llm.js';
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
} from './commandHandler.js';

// --- Command Patterns using 'gh>' prefix ---
const GH_COMMAND_PREFIX = "gh>"; // Define the prefix
const RELEASE_REGEX = new RegExp(`^${GH_COMMAND_PREFIX}\\s+release\\s+(?<repo_id>[\\w.-]+(?:\\/[\\w.-]+)?)\\s*$`, 'i');
const PR_REVIEW_REGEX = new RegExp(`^${GH_COMMAND_PREFIX}\\s+review\\s+pr\\s+(?<owner>[\\w.-]+)\\/(?<repo>[\\w.-]+)#(?<pr_number>\\d+)\\s+#(?<workspace_slug>[\\w-]+)\\s*$`, 'i');
const ISSUE_ANALYSIS_REGEX = new RegExp(`^${GH_COMMAND_PREFIX}\\s+(?:analyze|summarize|explain)\\s+issue\\s+(?:(?<owner>[\\w.-]+)\\/(?<repo>[\\w.-]+))?#(?<issue_number>\\d+)(?:\\s+(?<user_prompt>.+))?\\s*$`, 'i');
const GENERIC_API_REGEX = new RegExp(`^${GH_COMMAND_PREFIX}\\s+api\\s+(?<api_query>.+)\\s*$`, 'i');
const WORKSPACE_OVERRIDE_REGEX = new RegExp(`\\${WORKSPACE_OVERRIDE_COMMAND_PREFIX}(\\S+)`);


// --- Helper Function: Determine Initial Workspace ---
/**
 * Determines the appropriate AnythingLLM workspace slug based on config priority
 * for creating a *new* thread.
 * Priority: User Mapping > Channel Mapping > Fallback Workspace
 * @param {string} userId - Slack User ID
 * @param {string} channelId - Slack Channel ID
 * @returns {string | null} The determined workspace slug or null if none found/configured.
 */
function determineInitialWorkspace(userId, channelId) {
    let targetWorkspace = null; // Start with null

    // 1. User Mapping (Only if enabled)
    if (enableUserWorkspaces && userWorkspaceMapping && typeof userWorkspaceMapping === 'object') {
        const userMappedWorkspace = userWorkspaceMapping[userId];
        if (typeof userMappedWorkspace === 'string' && userMappedWorkspace.trim()) {
            targetWorkspace = userMappedWorkspace.trim();
            console.log(`[Workspace Logic] User mapping found for ${userId}: ${targetWorkspace}`);
        } else if (userMappedWorkspace) {
             console.warn(`[Workspace Logic] Invalid workspace value found in user mapping for ${userId}: "${userMappedWorkspace}". Ignoring.`);
        }
    }

    // 2. Channel Mapping (only if user mapping didn't apply or was invalid)
    if (!targetWorkspace && workspaceMapping && typeof workspaceMapping === 'object') {
        const channelMappedWorkspace = workspaceMapping[channelId];
         if (typeof channelMappedWorkspace === 'string' && channelMappedWorkspace.trim()) {
            targetWorkspace = channelMappedWorkspace.trim();
            console.log(`[Workspace Logic] Channel mapping found for ${channelId}: ${targetWorkspace}`);
        } else if (channelMappedWorkspace){
             console.warn(`[Workspace Logic] Invalid workspace value found in channel mapping for ${channelId}: "${channelMappedWorkspace}". Ignoring.`);
        }
    }

    // 3. Fallback Workspace (only if neither user nor channel mapping applied)
    if (!targetWorkspace) {
        if (typeof fallbackWorkspace === 'string' && fallbackWorkspace.trim()) {
            targetWorkspace = fallbackWorkspace.trim();
            console.log(`[Workspace Logic] Using fallback workspace: ${targetWorkspace}`);
        } else {
             console.warn(`[Workspace Logic] No user/channel mapping found and fallback workspace is not configured or invalid.`);
             // targetWorkspace remains null
        }
    }

    // 4. Return the result (could be null)
    console.log(`[Workspace Logic] Final determined initial workspace: ${targetWorkspace}`);
    return targetWorkspace;
}
// --- End Helper Function ---


/**
 * Handles the core logic for processing an incoming Slack message event.
 * Uses pattern matching for 'gh>' commands, interacts with LLMs and GitHub, and sends responses.
 */
async function handleSlackMessageEventInternal(event, slack, appOctokitInstance) {
    const handlerStartTime = Date.now();
    const {
        user: userId,
        text: originalText = '',
        channel: channelId, // Renamed for clarity
        ts: originalTs,
        thread_ts: threadTs
    } = event;

    // 1. Initial Processing & Context Setup
    let rawQuery = originalText.trim();
    const mentionString = `<@${botUserId}>`;
    let isMentioned = rawQuery.includes(mentionString);
    const isDM = channelId.startsWith('D');
    const replyTarget = threadTs || originalTs;
    console.log(`[Message Handler] Start. User: ${userId}, Chan: ${channelId}, TS: ${originalTs}, Thread: ${threadTs}, ReplyTarget: ${replyTarget}, RawQuery: "${rawQuery}"`);

    let cleanedQuery = rawQuery;
    if (isMentioned) {
        cleanedQuery = rawQuery.replace(mentionString, '').trim();
    }

    // 2. Handle #delete_last_message command
    if (cleanedQuery.toLowerCase().startsWith('#delete_last_message')) {
        console.log("[Message Handler] Delete command detected, calling command handler...");
        await handleDeleteLastMessageCommand(channelId, replyTarget, botUserId, slack);
        console.log(`[Message Handler] Delete command handled. Duration: ${Date.now() - handlerStartTime}ms`);
        return;
    }

    // 3. Check for potential gh> command BEFORE posting thinking message
    const isPotentialGhCommand = cleanedQuery.toLowerCase().startsWith(GH_COMMAND_PREFIX);
    let commandHandled = false;
    let thinkingMessagePromise = null;

    thinkingMessagePromise = slack.chat.postMessage({
        channel: channelId,
        thread_ts: replyTarget,
        text: ":hourglass_flowing_sand: Processing..."
    }).then(initialMsg => initialMsg.ts).catch(slackError => {
        console.error("[Message Error] Failed post initial thinking message:", slackError.data?.error || slackError.message);
        return null;
    });

    // 4. --- Try Matching Specific 'gh>' Commands ---
    if (isPotentialGhCommand) {
        if (!githubToken) {
             console.warn("[Message Handler] GitHub command detected, but GITHUB_TOKEN is not configured.");
             thinkingMessagePromise.then(ts => { if(ts) slack.chat.update({ channel: channelId, ts, text: `❌ GitHub commands are disabled (missing configuration).` }).catch(()=>{}); });
             return; // Stop processing this command
        }

        let match; // Reuse variable for matches

        // Check Release Command
        match = cleanedQuery.match(RELEASE_REGEX);
        if (match?.groups?.repo_id) {
            console.log("[Message Handler] Matched 'gh> release' pattern.");
            commandHandled = await handleReleaseInfoCommand( match.groups.repo_id, replyTarget, slack, appOctokitInstance, thinkingMessagePromise, channelId );
        }

        // Check PR Review Command
        if (!commandHandled) {
            match = cleanedQuery.match(PR_REVIEW_REGEX);
            if (match?.groups) { /* ... Handle PR Review ... */
                console.log("[Message Handler] Matched 'gh> review pr' pattern.");
                const { owner, repo, pr_number, workspace_slug } = match.groups;
                const prNum = parseInt(pr_number, 10);
                if (owner && repo && !isNaN(prNum) && workspace_slug) { commandHandled = await handlePrReviewCommand( owner, repo, prNum, workspace_slug, replyTarget, channelId, slack, appOctokitInstance, thinkingMessagePromise );
                } else { console.warn("[Message Handler] Invalid PR Review params:", match.groups); thinkingMessagePromise.then(ts => { if(ts) slack.chat.update({ channel: channelId, ts, text: `❌ Invalid format. Use: \`gh> review pr owner/repo#number #workspace\`` }).catch(()=>{}); }); commandHandled = true; }
            }
        }

        // Check Issue Analysis Command
        if (!commandHandled) {
            match = cleanedQuery.match(ISSUE_ANALYSIS_REGEX);
            if (match?.groups) { /* ... Handle Issue Analysis ... */
                 console.log("[Message Handler] Matched 'gh> analyze issue' pattern.");
                 const { owner = GITHUB_OWNER, repo = 'backlog', issue_number, user_prompt } = match.groups;
                 const issueNum = parseInt(issue_number, 10);
                 if (!isNaN(issueNum)) {
                    let anythingLLMThreadSlug = null; let workspaceSlugForThread = null;
                    try {
                        // Determine thread context (needed for LLM calls within the handler)
                        const mapping = await getAnythingLLMThreadMapping(channelId, replyTarget);
                        if (mapping) {
                            [anythingLLMThreadSlug, workspaceSlugForThread] = [mapping.anythingllm_thread_slug, mapping.anythingllm_workspace_slug];
                        } else {
                            workspaceSlugForThread = determineInitialWorkspace(userId, channelId); // Use HELPER
                            if (!workspaceSlugForThread) throw new Error("No workspace found for new thread (check config).");
                            anythingLLMThreadSlug = await createNewAnythingLLMThread(workspaceSlugForThread);
                            if (!anythingLLMThreadSlug) throw new Error(`Failed create thread in ${workspaceSlugForThread}.`);
                            await storeAnythingLLMThreadMapping(channelId, replyTarget, workspaceSlugForThread, anythingLLMThreadSlug);
                        }
                        console.log(`[Message Handler - Issue Cmd] Using thread: ${workspaceSlugForThread}:${anythingLLMThreadSlug}`);
                        commandHandled = await handleIssueAnalysisCommand( owner, repo, issueNum, user_prompt || null, replyTarget, channelId, slack, appOctokitInstance, thinkingMessagePromise, workspaceSlugForThread, anythingLLMThreadSlug );
                     } catch (threadError) { console.error("[MH-IssueCmd] Error getting/creating thread:", threadError); thinkingMessagePromise.then(ts => { if(ts) slack.chat.update({ channel: channelId, ts, text: `❌ Error setting up context: ${threadError.message}` }).catch(()=>{}); }); commandHandled = true; }
                 } else { console.warn("[MH] Invalid Issue Analysis number:", match.groups); thinkingMessagePromise.then(ts => { if(ts) slack.chat.update({ channel: channelId, ts, text: `❌ Invalid format. Use: \`gh> analyze issue [#123 | owner/repo#123]\`` }).catch(()=>{}); }); commandHandled = true; }
            }
        }

        // Check Generic API Command (Fallback)
        if (!commandHandled) {
            match = cleanedQuery.match(GENERIC_API_REGEX);
            if (match?.groups?.api_query) { /* ... Handle Generic API ... */
                console.log("[Message Handler] Matched generic 'gh> api' pattern.");
                commandHandled = await handleGithubApiCommand( match.groups.api_query, replyTarget, channelId, slack, thinkingMessagePromise, githubWorkspaceSlug, formatterWorkspaceSlug );
            }
        }

        // Handle unknown gh> command
        if (isPotentialGhCommand && !commandHandled) { /* ... Handle unknown command ... */
             console.warn(`[MH] Query started with '${GH_COMMAND_PREFIX}' but didn't match.`);
             thinkingMessagePromise.then(ts => { if(ts) slack.chat.update({ channel: channelId, ts, text: `❓ Unknown \`${GH_COMMAND_PREFIX}\` command.` }).catch(()=>{}); });
             commandHandled = true;
        }
    } // End of `if (isPotentialGhCommand)`


    // 5. --- Main Processing Logic (Fallback if no 'gh>' command handled) ---
    if (!commandHandled) {
        console.log("[Message Handler] No 'gh>' command matched. Proceeding with default AnythingLLM query.");

        // --- Determine AnythingLLM Thread and Workspace ---
        let anythingLLMThreadSlug = null;
        let workspaceSlugForThread = null;
         try {
             const existingMapping = await getAnythingLLMThreadMapping(channelId, replyTarget);
             if (existingMapping) { // Existing Thread Found
                 anythingLLMThreadSlug = existingMapping.anythingllm_thread_slug;
                 workspaceSlugForThread = existingMapping.anythingllm_workspace_slug;
                 console.log(`[Message Handler - Fallback] Found existing thread: ${workspaceSlugForThread}:${anythingLLMThreadSlug}`);

                 // Check for manual workspace override (#workspace-slug) on existing threads
                 const overrideMatch = cleanedQuery.match(WORKSPACE_OVERRIDE_REGEX);
                 if (overrideMatch && overrideMatch[1]) {
                     const potentialWorkspace = overrideMatch[1];
                     const availableWorkspaces = await getWorkspaces(); // Needs cache
                     if (availableWorkspaces.includes(potentialWorkspace)) {
                         workspaceSlugForThread = potentialWorkspace; // Override workspace for THIS CALL ONLY
                         console.log(`[Message Handler - Fallback] Manual workspace override on existing thread: "${workspaceSlugForThread}".`);
                     } else {
                         console.warn(`[Message Handler - Fallback] Override '#${potentialWorkspace}' not available. Using mapped: '${workspaceSlugForThread}'.`);
                     }
                 }

             } else { // No Existing Thread Found
                 console.log(`[Message Handler - Fallback] No existing thread. Determining initial sphere...`);
                 let initialSphere = determineInitialWorkspace(userId, channelId); // Use the HELPER function

                 // Check for manual workspace override (#workspace-slug) for NEW threads
                 const overrideMatch = cleanedQuery.match(WORKSPACE_OVERRIDE_REGEX);
                 if (overrideMatch && overrideMatch[1]) {
                      const potentialWorkspace = overrideMatch[1];
                      const availableWorkspaces = await getWorkspaces(); // Needs cache
                      if (availableWorkspaces.includes(potentialWorkspace)) {
                          initialSphere = potentialWorkspace; // Override the determined default
                          console.log(`[Message Handler - Fallback] Manual workspace override for NEW thread: "${initialSphere}".`);
                      } else {
                          console.warn(`[Message Handler - Fallback] Override '#${potentialWorkspace}' not available. Using determined default: '${initialSphere}'.`);
                      }
                 }

                 if (!initialSphere) {
                     // Handle case where no workspace could be determined at all
                     throw new Error("Could not determine a target workspace (check config: fallback, channel/user mappings).");
                 }

                 workspaceSlugForThread = initialSphere;
                 anythingLLMThreadSlug = await createNewAnythingLLMThread(workspaceSlugForThread);
                 if (!anythingLLMThreadSlug) throw new Error(`Failed create thread in ${workspaceSlugForThread}.`);
                 await storeAnythingLLMThreadMapping(channelId, replyTarget, workspaceSlugForThread, anythingLLMThreadSlug);
                 console.log(`[Message Handler - Fallback] Created new mapping: Slack ${channelId}:${replyTarget} -> AnythingLLM ${workspaceSlugForThread}:${anythingLLMThreadSlug}`);
             }
         } catch (threadError) {
             console.error("[Message Handler - Fallback] Error determining/creating thread:", threadError);
             thinkingMessagePromise.then(ts => { if (ts) slack.chat.update({ channel: channelId, ts, text: `⚠️ Oops! Error connecting to knowledge base: ${threadError.message}` }).catch(() => {}); });
             return; // Cannot proceed
         }
        // --- End Thread/Workspace Determination ---

        // --- Proceed with standard LLM query ---
        try {
            // Update Thinking Message
            const messageTs = await thinkingMessagePromise;
            let currentThinkingTs = messageTs;
            if (currentThinkingTs) { /* ... Update thinking message randomly ... */
                try {
                    const thinkingMessages = [":brain: Thinking...", ":gear: Processing...", ":mag: Analyzing...", ":nerd_face: Consulting...", ":robot_face: Compiling...", ":zap: Working..."];
                    await slack.chat.update({ channel: channelId, ts: currentThinkingTs, text: thinkingMessages[Math.floor(Math.random() * thinkingMessages.length)] });
                } catch (updateError) { console.warn(`[MH-Fallback] Failed update thinking msg:`, updateError.data?.error); currentThinkingTs = null; }
            }

            // Construct LLM Input (using cleanedQuery)
            let llmInputText = cleanedQuery;
            // Remove override command from text sent to LLM if present
            llmInputText = llmInputText.replace(WORKSPACE_OVERRIDE_REGEX, '').trim();
            const instruction = '\n\nIMPORTANT: Please do not include context references (like "CONTEXT 0", "CONTEXT 1", etc.) in your response. Provide a clean, professional answer without these annotations, Please do not confirm that you understand my request, just understand it.';
            llmInputText += instruction;

            console.log(`[Message Handler - Fallback] Sending query to AnythingLLM Thread ${workspaceSlugForThread}:${anythingLLMThreadSlug}...`);
            const llmStartTime = Date.now();
            const rawReply = await queryLlm(workspaceSlugForThread, anythingLLMThreadSlug, llmInputText);
            console.log(`[Message Handler - Fallback] LLM call duration: ${Date.now() - llmStartTime}ms`);
            if (!rawReply) throw new Error('LLM returned empty response.');

            // --- Process rawReply, check substance, post segments, post feedback buttons ---
            let isSubstantiveResponse = rawReply.trim().length >= MIN_SUBSTANTIVE_RESPONSE_LENGTH;
            const lowerRawReplyTrimmed = rawReply.toLowerCase().trim();
            if (lowerRawReplyTrimmed.includes("i cannot provide assistance") || lowerRawReplyTrimmed.includes("i cannot answer")) { isSubstantiveResponse = false; }
            console.log(`[Message Handler - Fallback] Response substantive check: ${isSubstantiveResponse}`);

            const segments = extractTextAndCode(rawReply);
            if (segments.length === 0) {
                console.warn("[MH-Fallback] No text/code segments extracted. Posting raw.");
                await slack.chat.postMessage({ channel: channelId, thread_ts: replyTarget, text: rawReply || "(Received empty response)" });
            }

            let lastMessageTs = null;
            for (let i = 0; i < segments.length; i++) {
                const segment = segments[i];
                let blocksToSend = [];
                let fallbackText = '...';

                if (segment.type === 'text' && segment.content?.trim()) {
                    const richTextBlock = markdownToRichTextBlock(segment.content, `msg_${Date.now()}_${i}`);
                    if (richTextBlock) { blocksToSend.push(richTextBlock); fallbackText = segment.content.substring(0, 200); } else { continue; }
                } else if (segment.type === 'code' && segment.content?.trim()) {
                    const language = segment.language || 'text'; const inlineCodeContent = `\`\`\`${language}\n${segment.content}\`\`\``; const richTextBlock = markdownToRichTextBlock(inlineCodeContent, `code_${Date.now()}_${i}`);
                    if (richTextBlock) { blocksToSend.push(richTextBlock); fallbackText = `Code Snippet (${language})`; } else { continue; }
                } else { continue; } // Skip empty

                if (blocksToSend.length === 0) continue;

                try {
                    const postResult = await slack.chat.postMessage({ channel: channelId, thread_ts: replyTarget, text: fallbackText, blocks: blocksToSend });
                    lastMessageTs = postResult?.ts;
                    console.log(`[MH-Fallback] Posted segment ${i + 1}/${segments.length} (ts: ${lastMessageTs}).`);
                } catch (postError) { console.error(`[MH-Fallback] Error posting segment ${i + 1}:`, postError.data?.error); await slack.chat.postMessage({ channel: channelId, thread_ts: replyTarget, text: `⚠️ Error displaying part of response.`}).catch(() => {}); }
                if (segments.length > 1 && i < segments.length - 1) await new Promise(r => setTimeout(r, 500));
            } // End segment loop

            // Post feedback buttons if applicable
            if (lastMessageTs && isSubstantiveResponse) {
                try {
                    const feedbackButtonElements = [ { type: "button", text: { type: "plain_text", text: "👎", emoji: true }, style: "danger", value: "bad", action_id: "feedback_bad" }, { type: "button", text: { type: "plain_text", text: "👌", emoji: true }, value: "ok", action_id: "feedback_ok" }, { type: "button", text: { type: "plain_text", text: "👍", emoji: true }, style: "primary", value: "great", action_id: "feedback_great" }];
                    const finalFeedbackBlock = [ { type: "divider" }, { type: "actions", block_id: `feedback_${originalTs}_${workspaceSlugForThread}`, elements: feedbackButtonElements }];
                    await slack.chat.postMessage({ channel: channelId, thread_ts: replyTarget, text: "Feedback:", blocks: finalFeedbackBlock });
                    console.log(`[MH-Fallback] Posted feedback buttons.`);
                } catch (feedbackPostError) { console.warn("[MH-Fallback] Failed post feedback buttons:", feedbackPostError.data?.error); }
            }
            // --- End response processing ---

            // Cleanup Thinking Message on success
            if (currentThinkingTs) {
                await slack.chat.delete({ channel: channelId, ts: currentThinkingTs }).catch(delErr => { console.warn("[MH-Fallback] Failed delete thinking msg on success:", delErr.data?.error); });
            }

        } catch (error) { // Catch errors during LLM query or response posting
            console.error('[Message Handler Error - Fallback Path]', error);
            thinkingMessagePromise.then(ts => {
                if(ts) { slack.chat.update({ channel: channelId, ts, text: `⚠️ Oops! Error: ${error.message}` }).catch(() => { slack.chat.postMessage({ channel: channelId, thread_ts: replyTarget, text: `⚠️ Oops! Error: ${error.message}` }).catch(() => {}); }); }
                else { slack.chat.postMessage({ channel: channelId, thread_ts: replyTarget, text: `⚠️ Oops! Error: ${error.message}` }).catch(() => {}); }
            }); // Don't delete thinking message showing error
        } finally {
            console.log(`[Message Handler - Fallback] Finished. Duration: ${Date.now() - handlerStartTime}ms`);
        }
    } else { // This branch executes if a 'gh>' command was handled
        console.log(`[Message Handler] 'gh>' command handled. Duration: ${Date.now() - handlerStartTime}ms`);
        // Thinking message cleanup is done within the command handlers.
    }
}

export { handleSlackMessageEventInternal };
