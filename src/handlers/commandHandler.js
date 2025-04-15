// src/handlers/commandHandler.js
// Contains handlers for specific commands identified by the routing service.

import { getLatestRelease, getPrDetailsForReview, getGithubIssueDetails, callGithubApi } from '../githubService.js';
import { markdownToRichTextBlock, extractTextAndCode, splitMessageIntoChunks } from '../formattingService.js';
import { queryLlm } from '../llm.js';
import { githubToken } from '../config.js'; // Needed for checks and API calls

/**
 * Handles the '#delete_last_message' command (does not use intent classification).
 * Attempts to find and delete the bot's last message in the thread.
 *
 * @param {string} channel - The channel ID.
 * @param {string} replyTarget - The timestamp of the message to reply to (thread TS or original message TS).
 * @param {string} botUserId - The user ID of the bot.
 * @param {import('@slack/web-api').WebClient} slack - The Slack WebClient instance.
 * @returns {Promise<boolean>} - True if the command was handled (message deleted or error posted), False otherwise.
 */
async function handleDeleteLastMessageCommand(channel, replyTarget, botUserId, slack) {
    console.log(`[Command Handler] Handling #delete_last_message in channel ${channel}`);
    try {
        // Fetch thread history to find bot's last message
        const historyResult = await slack.conversations.replies({
            channel: channel,
            ts: replyTarget, // Use replyTarget which is thread_ts or original_ts
            limit: 20 // Fetch enough messages to find recent bot messages
        });

        if (historyResult.ok && historyResult.messages) {
            // Find the last message from the bot that isn't a confirmation
            const lastBotMessage = historyResult.messages
                .slice() // Create a shallow copy before reversing to avoid modifying original
                .reverse() // Start from most recent
                .find(msg => msg.user === botUserId && !msg.text?.includes('✅') && !msg.text?.includes('❌'));

            if (lastBotMessage) {
                try {
                    // Try to delete the message
                    await slack.chat.delete({
                        channel: channel,
                        ts: lastBotMessage.ts
                    });
                    console.log(`[Command Handler] Successfully deleted last message (ts: ${lastBotMessage.ts})`);

                    // Send confirmation and delete it after 5 seconds
                    const confirmMsg = await slack.chat.postMessage({
                        channel: channel,
                        thread_ts: replyTarget,
                        text: "✅ Last message deleted."
                    });

                    // Delete confirmation message after 5 seconds
                    setTimeout(async () => {
                        try {
                            await slack.chat.delete({
                                channel: channel,
                                ts: confirmMsg.ts
                            });
                        } catch (deleteError) {
                            console.warn('[Command Handler] Error deleting confirmation:', deleteError.data?.error || deleteError.message);
                        }
                    }, 5000);

                } catch (deleteError) {
                    console.error('[Command Handler] Error deleting message:', deleteError.data?.error || deleteError.message);
                    await slack.chat.postMessage({
                        channel: channel,
                        thread_ts: replyTarget,
                        text: "❌ Sorry, I couldn't delete the message. It might be too old or I might not have permission."
                    }).catch(() => {}); // Ignore errors posting error message
                }
            } else {
                await slack.chat.postMessage({
                    channel: channel,
                    thread_ts: replyTarget,
                    text: "❌ I couldn't find my last message in this thread to delete."
                }).catch(() => {});
            }
        } else {
            throw new Error(`Failed to fetch thread history: ${historyResult.error}`);
        }
    } catch (error) {
        console.error('[Command Handler] Error handling delete_last_message:', error);
        await slack.chat.postMessage({
            channel: channel,
            thread_ts: replyTarget,
            text: "❌ An error occurred while trying to delete the message."
        }).catch(() => {});
    }
    return true; // Command was handled (even if an error occurred and was reported)
}


/**
 * Handles the 'fetch_release' intent.
 * Fetches latest release info from GitHub based on parameters from the router.
 *
 * @param {object} params - Parameters extracted by the intent classifier/router.
 * @param {string} params.repo - The target repository name.
 * @param {string} [params.owner='gravityforms'] - The repository owner.
 * @param {string} replyTarget - The timestamp of the message to reply to.
 * @param {import('@slack/web-api').WebClient} slack - The Slack WebClient instance.
 * @param {object} appOctokitInstance - The initialized Octokit instance (or null).
 * @param {Promise<string | null>} thinkingMessagePromise - Promise resolving to the thinking message timestamp.
 * @param {string} channel - The channel ID.
 * @returns {Promise<boolean>} - True if the command was handled (response posted or error reported).
 */
async function handleReleaseInfoCommand(params, replyTarget, slack, appOctokitInstance, thinkingMessagePromise, channel) {
    const { repo, owner = 'gravityforms' } = params; // Get repo/owner from params

    if (!repo) {
        console.warn("[Command Handler - Release] Intent classified, but repo parameter missing.");
        await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: "Which repository's release are you asking about?" });
        const ts = await thinkingMessagePromise; // Wait for promise resolution
        if (ts) await slack.chat.delete({ channel: channel, ts: ts }).catch(() => {}); // Attempt cleanup
        return true; // Handled (clarification requested)
    }

    console.log(`[Command Handler] Handling 'fetch_release' intent for ${owner}/${repo}`);

    if (!githubToken || !appOctokitInstance) {
        console.error("[Command Handler - Release] GITHUB_TOKEN or Octokit instance missing.");
        await slack.chat.postMessage({
            channel,
            thread_ts: replyTarget,
            text: `Sorry, I can't check GitHub releases because the integration is not configured correctly.`
        }).catch(() => {});
        const ts = await thinkingMessagePromise;
        if (ts) await slack.chat.delete({ channel: channel, ts: ts }).catch(() => {});
        return true; // Handled (config error reported)
    }

    try {
        const releaseInfo = await getLatestRelease(appOctokitInstance, owner, repo);

        if (releaseInfo) {
            const publishedDate = new Date(releaseInfo.publishedAt).toLocaleDateString();
            const messageText = `The latest release for *${owner}/${repo}* is <${releaseInfo.url}|*${releaseInfo.tagName}*>. Published on ${publishedDate}.`;
            const richTextBlock = markdownToRichTextBlock(messageText, `release_${owner}_${repo}`);

            if (richTextBlock) {
                await slack.chat.postMessage({
                    channel, thread_ts: replyTarget,
                    text: `Latest release for ${owner}/${repo}: ${releaseInfo.tagName} (Published ${publishedDate})`, // Fallback text
                    blocks: [richTextBlock]
                });
                console.log("[Command Handler - Release] Responded with GitHub release info.");
            } else {
                 await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: messageText }); // Send plain text if block fails
            }
        } else {
            await slack.chat.postMessage({
                channel,
                thread_ts: replyTarget,
                text: `I couldn't find any releases for ${owner}/${repo}. Double-check the repository name.`
            });
             console.log(`[Command Handler - Release] No release found for ${owner}/${repo}.`);
        }
        // Cleanup thinking message on success/not found
        const ts = await thinkingMessagePromise;
        if (ts) await slack.chat.delete({ channel: channel, ts: ts }).catch(() => {});
        return true; // Handled

    } catch (githubError) {
        console.error(`[Command Handler - Release] Error during GitHub release check for ${owner}/${repo}:`, githubError);
        await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: `Sorry, I encountered an error fetching the release for ${owner}/${repo}: ${githubError.message}` }).catch(()=>{});
        const ts = await thinkingMessagePromise;
        if (ts) await slack.chat.delete({ channel: channel, ts: ts }).catch(() => {});
        return true; // Handled (error reported)
    }
}


/**
 * Handles the 'review_pr' intent.
 * Fetches PR details, constructs a prompt, queries LLM, and posts the review.
 *
 * @param {object} params - Parameters extracted by the intent classifier/router.
 * @param {string} params.repo - The target repository name.
 * @param {number} params.pr_number - The PR number.
 * @param {string} params.target_workspace - Workspace slug specified by user for the review LLM.
 * @param {string} [params.owner='gravityforms'] - The repository owner.
 * @param {string} replyTarget - Timestamp to reply to.
 * @param {string} channel - Channel ID.
 * @param {import('@slack/web-api').WebClient} slack - Slack WebClient.
 * @param {object} appOctokitInstance - Octokit instance.
 * @param {Promise<string | null>} thinkingMessagePromise - Promise resolving to the thinking message timestamp.
 * @returns {Promise<boolean>} - True if handled successfully or error reported.
 */
async function handlePrReviewCommand(params, replyTarget, channel, slack, appOctokitInstance, thinkingMessagePromise) {
    const { repo: subRepo, pr_number: prNumber, target_workspace: workspaceSlug, owner = 'gravityforms' } = params;

    if (!subRepo || !prNumber || !workspaceSlug) {
        console.warn("[Command Handler - PR Review] Intent classified, but repo, PR number, or target workspace parameter missing.");
        await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: "For PR reviews, please specify like this: `review pr owner/repo#number #workspace-slug`" });
        const ts = await thinkingMessagePromise;
        if (ts) await slack.chat.delete({ channel: channel, ts: ts }).catch(() => {});
        return true; // Handled (clarification requested)
    }

    console.log(`[Command Handler] Handling 'review_pr' intent for PR ${owner}/${subRepo}#${prNumber} in workspace ${workspaceSlug}`);

    if (!githubToken || !appOctokitInstance) {
        console.error("[Command Handler - PR Review] GITHUB_TOKEN or Octokit instance missing.");
        await slack.chat.postMessage({
            channel,
            thread_ts: replyTarget,
            text: `Sorry, I can't review PRs because the GitHub integration is not configured correctly.`
        }).catch(() => {});
        const ts = await thinkingMessagePromise;
        if (ts) await slack.chat.delete({ channel: channel, ts: ts }).catch(() => {});
        return true; // Handled (config error reported)
    }

    try {
        // Ensure thinking message exists before proceeding
        const initialTs = await thinkingMessagePromise;
        if (!initialTs) { // If posting initial message failed, we can't update/delete it.
             console.warn("[Command Handler - PR Review] Initial thinking message failed to post. Cannot proceed with review.");
             return true; // Or throw? For now, just exit.
        }

        // Optionally update thinking message
         await slack.chat.update({ channel, ts: initialTs, text: `:robot_face: Fetching PR details for ${owner}/${subRepo}#${prNumber}...` }).catch(()=>{});


        const prDetails = await getPrDetailsForReview(appOctokitInstance, owner, subRepo, prNumber);

        if (!prDetails) {
            await slack.chat.postMessage({
                channel,
                thread_ts: replyTarget,
                text: `Sorry, I couldn't fetch details for PR ${owner}/${subRepo}#${prNumber}. It might not exist, or there was an API issue.`
            });
            if (initialTs) await slack.chat.delete({ channel: channel, ts: initialTs }).catch(() => {}); // Cleanup
            return true; // Indicate command was handled (PR not found/error)
        }

        // Construct PR context (limit size)
        let prContext = `**Pull Request:** ${owner}/${subRepo}#${prNumber}\n`;
        prContext += `**Title:** ${prDetails.title}\n`;
        prContext += `**Description:**\n${(prDetails.body || '(No description)').substring(0, 1000)}\n\n`; // Limit body length
        prContext += `**Changes:**\n`;

        const MAX_DIFF_SIZE = 3000; // Characters per file diff
        const MAX_TOTAL_DIFF_SIZE = 20000; // Limit total diff characters sent to LLM
        let currentTotalDiffSize = 0;
        let diffTruncatedOverall = false;

        (prDetails.files || []).forEach(file => {
            if (currentTotalDiffSize >= MAX_TOTAL_DIFF_SIZE) {
                diffTruncatedOverall = true;
                return; // Stop adding more file diffs
            }
            prContext += `\n**File:** ${file.filename} (${file.status})\n`;
            //prContext += `**Status:** ${file.status} (${file.additions}+, ${file.deletions}-)\n`;
            if (file.patch) {
                let diffContent = file.patch;
                let diffTruncatedFile = false;
                if (diffContent.length > MAX_DIFF_SIZE) {
                     diffContent = diffContent.substring(0, MAX_DIFF_SIZE);
                     diffTruncatedFile = true;
                }
                 if (currentTotalDiffSize + diffContent.length > MAX_TOTAL_DIFF_SIZE) {
                     const remainingSpace = MAX_TOTAL_DIFF_SIZE - currentTotalDiffSize;
                     diffContent = diffContent.substring(0, remainingSpace);
                     diffTruncatedOverall = true; // Mark that we truncated due to overall limit
                 }

                prContext += `\`\`\`diff\n${diffContent}\n\`\`\`\n`;
                if (diffTruncatedFile && !diffTruncatedOverall) prContext += `\n... (diff truncated for this file)\n`;
                currentTotalDiffSize += diffContent.length;

            } else {
                prContext += `(No diff available)\n`;
            }

        });
        if (diffTruncatedOverall) prContext += `\n... (Overall diff content truncated due to length limits)\n`;


        // Limit comments
        const MAX_COMMENTS = 5;
        if (prDetails.comments && prDetails.comments.length > 0) {
            prContext += `\n**Recent Comments (${Math.min(prDetails.comments.length, MAX_COMMENTS)} shown):**\n`;
            prDetails.comments.slice(-MAX_COMMENTS).forEach(comment => {
                prContext += `*${comment.user?.login || 'unknown'}:* ${(comment.body || '').substring(0, 300)}${comment.body.length > 300 ? '...' : ''}\n---\n`;
            });
        }

        // Create detailed review prompt
        const reviewPrompt = `You are performing a code review for Pull Request ${owner}/${subRepo}#${prNumber}.
Focus on code quality, potential bugs, adherence to best practices, security concerns, and clarity. Provide specific, actionable feedback. If the code looks good, say so.

Here's the PR context (diffs/descriptions might be truncated):
${prContext}`;

        // Update thinking message again
         await slack.chat.update({ channel, ts: initialTs, text: `:brain: Asking LLM in workspace \`${workspaceSlug}\` to review PR ${prNumber}...` }).catch(()=>{});


        // Query LLM with the workspace from the command
        console.log(`[Command Handler - PR Review] Requesting LLM analysis for PR #${prNumber} in workspace ${workspaceSlug}`);
        const analysisResponse = await queryLlm(workspaceSlug, null, reviewPrompt, 'chat'); // Use workspace from params, mode 'chat'

        if (!analysisResponse) throw new Error('LLM failed to provide analysis.');

        // Process and send the response in chunks/blocks
        const responseChunks = splitMessageIntoChunks(analysisResponse); // Use smart splitting
        console.log(`[Command Handler - PR Review] Split review into ${responseChunks.length} chunks.`);
        for (let i = 0; i < responseChunks.length; i++) {
            const chunk = responseChunks[i];
            const block = markdownToRichTextBlock(chunk);
             await slack.chat.postMessage({
                 channel,
                 thread_ts: replyTarget,
                 text: `PR Review Part ${i + 1}/${responseChunks.length}`, // Fallback text
                 ...(block ? { blocks: [block] } : { text: chunk }) // Send block if possible, else raw text
             });
            console.log(`[Command Handler - PR Review] Posted review segment ${i + 1}/${responseChunks.length}`);
             if (responseChunks.length > 1 && i < responseChunks.length - 1) {
                 await new Promise(resolve => setTimeout(resolve, 500)); // Small delay between chunks
             }
        }

        // Cleanup thinking message on success
        if (initialTs) await slack.chat.delete({ channel: channel, ts: initialTs }).catch(() => {});
        return true; // Handled

    } catch (error) {
        console.error(`[Command Handler - PR Review] Error during PR review for ${owner}/${subRepo}#${prNumber}:`, error);
        await slack.chat.postMessage({
            channel,
            thread_ts: replyTarget,
            text: `Sorry, I encountered an error trying to review PR ${owner}/${subRepo}#${prNumber}. Details: ${error.message}`
        }).catch(() => {});
        // Attempt cleanup thinking message on error too
        const ts = await thinkingMessagePromise; // Need to await the promise again here
        if (ts) await slack.chat.delete({ channel: channel, ts: ts }).catch(() => {});
        return true; // Indicate command was handled (error reported)
    }
}


/**
 * Handles the 'analyze_issue' intent.
 * Fetches issue details, constructs prompts, queries LLM for summary and analysis, and posts results.
 *
 * @param {object} params - Parameters extracted by the intent classifier/router.
 * @param {number} params.issue_number - The issue number.
 * @param {string} [params.user_prompt] - Specific question user asked about the issue.
 * @param {string} [params.repo='backlog'] - Repo name.
 * @param {string} [params.owner='gravityforms'] - Owner.
 * @param {string} replyTarget - Timestamp to reply to.
 * @param {string} channel - Channel ID.
 * @param {import('@slack/web-api').WebClient} slack - Slack WebClient.
 * @param {object} appOctokitInstance - Octokit instance.
 * @param {Promise<string | null>} thinkingMessagePromise - Promise resolving to the thinking message timestamp.
 * @param {string} workspaceSlugForThread - Workspace slug for the *current* Slack thread (used for LLM calls).
 * @param {string} anythingLLMThreadSlug - AnythingLLM thread slug for the *current* Slack thread.
 * @returns {Promise<boolean>} - True if handled successfully or error reported.
 */
async function handleIssueAnalysisCommand(params, replyTarget, channel, slack, appOctokitInstance, thinkingMessagePromise, workspaceSlugForThread, anythingLLMThreadSlug) {
    const { issue_number: issueNumber, user_prompt: userPrompt, repo: ghRepo = 'backlog', owner: ghOwner = 'gravityforms' } = params;

    if (!issueNumber) {
        console.warn("[Command Handler - Issue Analysis] Intent classified, but issue number parameter missing.");
        await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: "Which issue number should I analyze? (e.g., `analyze issue #123`)" });
        const ts = await thinkingMessagePromise;
        if (ts) await slack.chat.delete({ channel: channel, ts: ts }).catch(() => {});
        return true; // Handled (clarification requested)
    }

    console.log(`[Command Handler] Handling 'analyze_issue' intent for ${ghOwner}/${ghRepo}#${issueNumber}. User prompt: "${userPrompt}"`);

    if (!githubToken || !appOctokitInstance) {
        console.error("[Command Handler - Issue Analysis] GITHUB_TOKEN or Octokit instance missing.");
        await slack.chat.postMessage({
             channel,
             thread_ts: replyTarget,
             text: `Sorry, I can't analyze GitHub issues because the GitHub integration is not configured correctly.`
         }).catch(() => {});
        const ts = await thinkingMessagePromise;
        if (ts) await slack.chat.delete({ channel: channel, ts: ts }).catch(() => {});
        return true; // Handled (config error reported)
    }

    let initialTs = null; // To store thinking message TS
    try {
        initialTs = await thinkingMessagePromise; // Wait for the initial message
        if (!initialTs) {
            console.warn("[Command Handler - Issue Analysis] Initial thinking message failed to post. Proceeding without updates.");
        } else {
             // Update thinking message
             await slack.chat.update({ channel, ts: initialTs, text: `:robot_face: Fetching details for issue ${ghOwner}/${ghRepo}#${issueNumber}...` }).catch(()=>{});
        }

        const issueDetails = await getGithubIssueDetails(appOctokitInstance, issueNumber, ghOwner, ghRepo); // Use extracted owner/repo

        if (issueDetails) {
            // Construct context (Limit sizes)
            let issueContext = `**GitHub Issue:** ${ghOwner}/${ghRepo}#${issueNumber}\n`;
            issueContext += `**Title:** ${issueDetails.title}\n`;
            issueContext += `**URL:** <${issueDetails.url}|View on GitHub>\n`;
            issueContext += `**Body:**\n${(issueDetails.body || '(No body)').substring(0, 2000)}\n\n`; // Limit body
            const MAX_COMMENTS_ISSUE = 5;
            const MAX_COMMENT_LENGTH = 300;
            if (issueDetails.comments && issueDetails.comments.length > 0) {
                issueContext += `**Recent Comments (${Math.min(issueDetails.comments.length, MAX_COMMENTS_ISSUE)} shown):**\n`;
                issueDetails.comments.slice(-MAX_COMMENTS_ISSUE).forEach(comment => {
                    issueContext += `*${comment.user}:* ${(comment.body || '').substring(0, MAX_COMMENT_LENGTH)}${comment.body.length > MAX_COMMENT_LENGTH ? '...' : ''}\n---\n`;
                });
            }

            // Update thinking message
             if(initialTs) await slack.chat.update({ channel, ts: initialTs, text: `:mag: Summarizing issue #${issueNumber}...` }).catch(()=>{});


            // Get summary using the thread's workspace/thread
            console.log(`[Command Handler - Issue Analysis] Requesting LLM summary for issue #${issueNumber}`);
            const summarizePrompt = `Summarize the core problem described in the following GitHub issue details from ${ghOwner}/${ghRepo}#${issueNumber}:\n\n${issueContext}`;
            console.log(`[Command Handler DEBUG] Calling queryLlm (Summary). Workspace: ${workspaceSlugForThread}, Thread: ${anythingLLMThreadSlug}`);
            const summaryResponse = await queryLlm(workspaceSlugForThread, anythingLLMThreadSlug, summarizePrompt);
            if (!summaryResponse) throw new Error('LLM failed to provide a summary.');

            // Post summary
            console.log(`[Command Handler - Issue Analysis] Posting LLM summary for issue #${issueNumber}`);
            const summaryBlock = markdownToRichTextBlock(`*Summary for issue #${issueNumber}:*\n${summaryResponse}`);
            if (summaryBlock) {
                await slack.chat.postMessage({
                    channel,
                    thread_ts: replyTarget,
                    text: `Summary for issue #${issueNumber}: ${summaryResponse.substring(0,200)}...`,
                    blocks: [summaryBlock]
                });
            } else {
                 await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: `*Summary for issue #${issueNumber}:*\n${summaryResponse}` });
            }

            // Update thinking message
             if(initialTs) await slack.chat.update({ channel, ts: initialTs, text: `:brain: Analyzing issue #${issueNumber} based on summary and prompt...` }).catch(()=>{});

            // Get analysis using the thread's workspace/thread
            console.log(`[Command Handler - Issue Analysis] Requesting LLM analysis for issue #${issueNumber}`);
            let analyzePrompt = `Based on the summary ("${summaryResponse.substring(0, 300)}...") and the full context below, analyze issue ${ghOwner}/${ghRepo}#${issueNumber}`;
            if (userPrompt) {
                analyzePrompt += ` specifically addressing this: "${userPrompt}"`;
            } else {
                analyzePrompt += `. What are the key points, potential causes, or next steps?`;
            }
            analyzePrompt += `\n\n**Full Context:**\n${issueContext}`; // Provide full context again
            console.log(`[Command Handler DEBUG] Calling queryLlm (Analysis). Workspace: ${workspaceSlugForThread}, Thread: ${anythingLLMThreadSlug}`);
            const analysisResponse = await queryLlm(workspaceSlugForThread, anythingLLMThreadSlug, analyzePrompt);
            if (!analysisResponse) throw new Error('LLM failed to provide analysis.');

            // Post analysis in chunks
            console.log(`[Command Handler - Issue Analysis] Processing and sending LLM analysis for issue #${issueNumber}`);
            const analysisChunks = splitMessageIntoChunks(analysisResponse);
            for (let i = 0; i < analysisChunks.length; i++) {
                const chunk = analysisChunks[i];
                const block = markdownToRichTextBlock(chunk);
                 await slack.chat.postMessage({
                     channel,
                     thread_ts: replyTarget,
                     text: `Analysis Part ${i + 1}/${analysisChunks.length}`,
                     ...(block ? { blocks: [block] } : { text: chunk })
                 });
                console.log(`[Command Handler - Issue Analysis] Posted analysis segment ${i + 1}/${analysisChunks.length}`);
                 if (analysisChunks.length > 1 && i < analysisChunks.length - 1) {
                     await new Promise(resolve => setTimeout(resolve, 500));
                 }
            }

            // Cleanup and return success
            if (initialTs) await slack.chat.delete({ channel: channel, ts: initialTs }).catch(() => {});
            return true; // Handled

        } else {
            // Handle case where issue details couldn't be fetched
            await slack.chat.postMessage({
                channel,
                thread_ts: replyTarget,
                text: `I couldn't fetch details for ${ghOwner}/${ghRepo} issue #${issueNumber}. Please check if the number and repository are correct.`
            });
            if (initialTs) await slack.chat.delete({ channel: channel, ts: initialTs }).catch(() => {}); // Cleanup
            return true; // Handled (issue not found)
        }
    } catch (error) {
        console.error(`[Command Handler - Issue Analysis] Error during GitHub issue analysis for ${ghOwner}/${ghRepo}#${issueNumber}:`, error);
        await slack.chat.postMessage({
            channel,
            thread_ts: replyTarget,
            text: `Sorry, I encountered an error trying to analyze issue #${issueNumber}: ${error.message}`
        }).catch(() => {});
        // Attempt cleanup thinking message on error too
        if (initialTs) await slack.chat.delete({ channel: channel, ts: initialTs }).catch(() => {});
        return true; // Handled (error reported)
    }
}


/**
 * Handles the 'generic_github_api' intent.
 * Queries the GitHub LLM workspace, parses the response as API details, executes the API call,
 * optionally formats the result, and posts it back.
 *
 * @param {object} params - Parameters extracted by the intent classifier/router.
 * @param {string} params.user_prompt - The core user request to be translated into an API call.
 * @param {string} replyTarget - Timestamp to reply to.
 * @param {string} channel - Channel ID.
 * @param {import('@slack/web-api').WebClient} slack - Slack WebClient.
 * @param {Promise<string | null>} thinkingMessagePromise - Promise resolving to the thinking message timestamp.
 * @param {string|null} githubWorkspaceSlug - Slug for the GitHub LLM workspace (to generate API calls).
 * @param {string|null} formatterWorkspaceSlug - Slug for the Formatter LLM workspace.
 * @returns {Promise<boolean>} - True if handled successfully or error reported.
 */
async function handleGithubApiCommand(params, replyTarget, channel, slack, thinkingMessagePromise, githubWorkspaceSlug, formatterWorkspaceSlug) {
    const { user_prompt: githubQuery } = params;

    if (!githubQuery) {
        console.warn("[Command Handler - Generic API] Intent classified, but user_prompt parameter missing.");
        await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: "What GitHub action or information are you looking for?" });
        const ts = await thinkingMessagePromise;
        if (ts) await slack.chat.delete({ channel: channel, ts: ts }).catch(() => {});
        return true; // Handled (clarification requested)
    }
     if (!githubWorkspaceSlug) {
         console.error("[Command Handler - Generic API] githubWorkspaceSlug is not configured.");
          await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: "Sorry, the generic GitHub command workspace is not configured." });
         const ts = await thinkingMessagePromise;
         if (ts) await slack.chat.delete({ channel: channel, ts: ts }).catch(() => {});
         return true; // Handled (config error reported)
     }
      if (!githubToken) {
          console.error("[Command Handler - Generic API] GITHUB_TOKEN is not configured.");
          await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: "Sorry, the GitHub token is not configured, so I cannot make API calls." });
          const ts = await thinkingMessagePromise;
          if (ts) await slack.chat.delete({ channel: channel, ts: ts }).catch(() => {});
          return true; // Handled (config error reported)
      }


    console.log(`[Command Handler] Handling 'generic_github_api' intent with query: "${githubQuery}"`);

    let initialTs = null; // Store thinking message TS
    try {
        initialTs = await thinkingMessagePromise;
         if (!initialTs) {
             console.warn("[Command Handler - Generic API] Initial thinking message failed to post. Proceeding without updates.");
         } else {
             await slack.chat.update({ channel, ts: initialTs, text: `:nerd_face: Figuring out the right GitHub API call for your request...` }).catch(()=>{});
         }

        // Query the GitHub workspace LLM to get API call details
        console.log(`[Command Handler - Generic API] Querying GitHub workspace (${githubWorkspaceSlug}) with: "${githubQuery}"`);
        const llmResponse = await queryLlm(githubWorkspaceSlug, null, githubQuery, 'chat'); // Use the specific GitHub workspace

        if (!llmResponse) throw new Error('Received null response from GitHub workspace LLM.');

        // Clean and parse the LLM response to get API details
        let cleanedJsonString = llmResponse.trim();
        const jsonMatch = cleanedJsonString.match(/```json\s*([\s\S]*?)\s*```/);
        if (jsonMatch && jsonMatch[1]) {
            cleanedJsonString = jsonMatch[1].trim();
        } else if (cleanedJsonString.startsWith('{') && cleanedJsonString.endsWith('}')) {
             cleanedJsonString = cleanedJsonString; // Assume it's just JSON
        } else {
             throw new Error(`LLM response doesn't contain expected JSON block. Response: ${llmResponse}`);
        }

        let apiDetails;
        try {
            apiDetails = JSON.parse(cleanedJsonString);
            if (!apiDetails.endpoint) {
                throw new Error("Parsed API details object is missing the required 'endpoint' field.");
            }
        } catch (parseError) {
            console.error('[Command Handler - Generic API] Failed to parse LLM response as JSON or missing endpoint:', parseError);
            console.error('[Command Handler - Generic API] Original response text:', llmResponse);
            console.error('[Command Handler - Generic API] Cleaned string before parse attempt:', cleanedJsonString);
            await slack.chat.postMessage({
                channel: channel,
                thread_ts: replyTarget,
                text: `⚠️ Sorry, I couldn't translate your request into a valid GitHub API call.\n\nLLM Output: \`\`\`${llmResponse}\`\`\``
            });
            if (initialTs) await slack.chat.delete({ channel: channel, ts: initialTs }).catch(() => {});
            return true; // Handled (parse error reported)
        }

        // Update thinking message before making the call
         if(initialTs) await slack.chat.update({ channel, ts: initialTs, text: `:satellite: Calling GitHub API: ${apiDetails.method || 'GET'} ${apiDetails.endpoint}` }).catch(()=>{});


        // Call the GitHub API using the service
        try {
            console.log("[Command Handler - Generic API] Calling GitHub API with details:", apiDetails);
            const githubResponse = await callGithubApi(apiDetails); // Uses fetch and GITHUB_TOKEN
            console.log("[Command Handler - Generic API] Received response from GitHub.");

            // --- Format or present the GitHub response ---
            let finalResponseText = '';
            const rawJsonString = JSON.stringify(githubResponse, null, 2);

            if (formatterWorkspaceSlug) {
                 // Update thinking message
                 if(initialTs) await slack.chat.update({ channel, ts: initialTs, text: `:art: Formatting GitHub response using LLM...` }).catch(()=>{});

                console.log(`[Command Handler - Generic API] Formatting response using workspace: ${formatterWorkspaceSlug}`);
                // Use the raw JSON string as the prompt for the formatter
                const formatPrompt = `Format the following GitHub API JSON response into human-readable Markdown:\n\n\`\`\`json\n${rawJsonString}\n\`\`\``;
                console.log(`[Command Handler - Generic API] Sending stringified JSON to formatter (length: ${rawJsonString.length})`);
                try {
                    const formattedLLMResponse = await queryLlm(formatterWorkspaceSlug, null, formatPrompt, 'chat');
                    const trimmedResponse = formattedLLMResponse ? formattedLLMResponse.trim() : '';
                    if (trimmedResponse.length > 0) {
                        // Clean potential markdown code blocks around the *entire* formatted response
                        let cleanedFormattedResponse = trimmedResponse;
                        if (cleanedFormattedResponse.startsWith('```markdown')) cleanedFormattedResponse = cleanedFormattedResponse.substring(11);
                        else if (cleanedFormattedResponse.startsWith('```')) cleanedFormattedResponse = cleanedFormattedResponse.substring(3);
                        if (cleanedFormattedResponse.endsWith('```')) cleanedFormattedResponse = cleanedFormattedResponse.substring(0, cleanedFormattedResponse.length - 3);

                        finalResponseText = cleanedFormattedResponse.trim();
                        console.log("[Command Handler - Generic API] Successfully received and cleaned formatted response.");
                    } else {
                        console.warn("[Command Handler - Generic API] Formatter LLM returned empty. Falling back to raw JSON.");
                        finalResponseText = `(Formatter failed or returned empty, showing raw data):\n\`\`\`json\n${rawJsonString}\n\`\`\``;
                    }
                } catch (formatError) {
                    console.error('[Command Handler - Generic API] Error calling formatter LLM:', formatError);
                    finalResponseText = `(Error during formatting: ${formatError.message})\n\nRaw data:\n\`\`\`json\n${rawJsonString}\n\`\`\``;
                }
            } else {
                console.log("[Command Handler - Generic API] No formatter workspace configured. Sending raw JSON.");
                finalResponseText = `Here is the raw response from the GitHub API:\n\`\`\`json\n${rawJsonString}\n\`\`\``;
            }

            // --- Send the final response (formatted or raw) ---
            console.log("[Command Handler - Generic API] Splitting final response for Slack.");
            const chunks = splitMessageIntoChunks(finalResponseText);
            console.log(`[Command Handler - Generic API] Split into ${chunks.length} chunk(s).`);
            for (let i = 0; i < chunks.length; i++) {
                const chunk = chunks[i];
                console.log(`[Command Handler - Generic API] Processing chunk ${i + 1}/${chunks.length}`);
                const responseBlock = markdownToRichTextBlock(chunk);
                await slack.chat.postMessage({
                    channel: channel,
                    thread_ts: replyTarget,
                    text: chunk.substring(0, 200) + (chunk.length > 200 ? '...' : ''), // Fallback text
                    ...(responseBlock ? { blocks: [responseBlock] } : { text: chunk }) // Prefer block
                });
                 if (chunks.length > 1 && i < chunks.length - 1) {
                     await new Promise(resolve => setTimeout(resolve, 500));
                 }
            }
            console.log("[Command Handler - Generic API] Finished posting all chunks.");

            // Cleanup handled below

        } catch (apiError) {
            console.error('[Command Handler - Generic API] Error calling GitHub API:', apiError);
            // Try to update the thinking message with the error before deleting? Or just post separately.
            await slack.chat.postMessage({
                channel: channel,
                thread_ts: replyTarget,
                text: `Sorry, I encountered an error while calling the GitHub API: ${apiError.message}`
            }).catch(() => {}); // Ignore error reporting failure
             // Cleanup handled below, still return true as we handled the command trigger
        }

    } catch (llmError) {
        console.error('[Command Handler - Generic API] Error querying GitHub workspace LLM:', llmError);
        await slack.chat.postMessage({
            channel: channel,
            thread_ts: replyTarget,
            text: `Sorry, I encountered an error trying to figure out the GitHub API call: ${llmError.message}`
        }).catch(() => {});
        // Cleanup handled below, still return true as we handled the command trigger
    }

    // Cleanup Thinking Message regardless of success/failure within this handler
    if (initialTs) {
        try {
            console.log(`[Command Handler - Generic API] Deleting thinking message (ts: ${initialTs}).`);
            await slack.chat.delete({ channel: channel, ts: initialTs });
        } catch (deleteError) {
            console.warn("[Command Handler - Generic API] Failed to delete thinking message:", deleteError.data?.error || deleteError.message);
        }
    }

    return true; // Command intent was handled (successfully or with reported error)
}


export {
    handleDeleteLastMessageCommand, // Unchanged signature
    handleReleaseInfoCommand,     // Accepts params object
    handlePrReviewCommand,        // Accepts params object
    handleIssueAnalysisCommand,   // Accepts params object
    handleGithubApiCommand        // Accepts params object
};
