
// src/handlers/commandHandler.js
// Contains handlers for specific 'gh>' commands identified by pattern matching.

import { getLatestRelease, getPrDetailsForReview, getGithubIssueDetails, callGithubApi } from '../githubService.js';
import { markdownToRichTextBlock, extractTextAndCode, splitMessageIntoChunks } from '../formattingService.js';
import { queryLlm } from '../llm.js';
import { githubToken, GITHUB_OWNER } from '../config.js'; // Import needed config

/**
 * Helper function to safely update or delete the thinking message.
 * @param {Promise<string | null>} thinkingMessagePromise - Promise resolving to the message TS.
 * @param {object} slack - Slack WebClient instance.
 * @param {string} channel - Channel ID.
 * @param {object | null} updateArgs - Arguments for chat.update (text, blocks), or null/undefined to delete.
 */
async function updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, updateArgs = null) {
    // Await the promise to get the timestamp *within* this function
    const ts = await thinkingMessagePromise;
    if (!ts) {
        // This might happen if the initial post failed. Log it but don't throw.
        console.warn("[Command Handler Util] No thinking message TS resolved to update/delete.");
        return;
    }
    try {
        if (updateArgs) {
            await slack.chat.update({ channel, ts, ...updateArgs });
            console.log(`[Command Handler Util] Updated thinking message ${ts}.`);
        } else {
            await slack.chat.delete({ channel, ts });
            console.log(`[Command Handler Util] Deleted thinking message ${ts}.`);
        }
    } catch (error) {
        // Log specific errors for update vs delete if needed
        console.warn(`[Command Handler Util] Failed to ${updateArgs ? 'update' : 'delete'} thinking message ${ts}:`, error.data?.error || error.message);
        // If delete fails, it might be because it was already deleted or permissions changed. Usually not critical.
    }
}


/**
 * Handles the '#delete_last_message' command (simple prefix check, no thinking message needed).
 */
async function handleDeleteLastMessageCommand(channel, replyTarget, botUserId, slack) {
    console.log(`[Command Handler] Handling #delete_last_message in channel ${channel}`);
    try {
        const historyResult = await slack.conversations.replies({ channel, ts: replyTarget, limit: 20 });
         if (historyResult.ok && historyResult.messages) {
             const lastBotMessage = historyResult.messages.slice().reverse().find(msg => msg.user === botUserId && !msg.text?.includes('✅') && !msg.text?.includes('❌'));
             if (lastBotMessage) {
                 try {
                     await slack.chat.delete({ channel, ts: lastBotMessage.ts });
                     console.log(`[CH - Delete] Deleted message ${lastBotMessage.ts}`);
                     const confirmMsg = await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: "✅ Last message deleted." });
                     setTimeout(async () => { try { await slack.chat.delete({ channel, ts: confirmMsg.ts }); } catch (e) {} }, 5000);
                 } catch (deleteError) { console.error('[CH - Delete] Error deleting:', deleteError.data?.error); await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: "❌ Couldn't delete message." }).catch(() => {}); }
             } else { await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: "❌ Couldn't find my last message." }).catch(() => {}); }
         } else { throw new Error(`Failed fetch history: ${historyResult.error}`); }
    } catch (error) { console.error('[CH - Delete] Error:', error); await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: "❌ Error during delete." }).catch(() => {}); }
    return true;
}

/**
 * Handles the 'gh> release' command.
 */
async function handleReleaseInfoCommand(repoIdentifier, replyTarget, slack, appOctokitInstance, thinkingMessagePromise, channel) {
    console.log(`[Command Handler] Handling 'gh> release' for identifier: ${repoIdentifier}`);

    // --- Resolve Repo Name ---
    let owner = GITHUB_OWNER; let repo = null; const lowerIdentifier = repoIdentifier.toLowerCase();
    const abbreviations = { 'gf':'gravityforms', 'core':'gravityforms', 'ppcp':'gravityformsppcp', 'paypal':'gravityformsppcp', 'paypalcheckout':'gravityformsppcp', 'stripe':'gravityformsstripe', 'authorize.net':'gravityformsauthorizenet', 'authnet':'gravityformsauthorizenet', 'user registration':'gravityformsuserregistration', 'ur':'gravityformsuserregistration', 'gravityflow':'gravityflow', 'flow':'gravityflow' };
    if (abbreviations[lowerIdentifier]) { repo = abbreviations[lowerIdentifier]; if (repo === 'gravityflow') owner = 'gravityflow'; else owner = GITHUB_OWNER; }
    else if (lowerIdentifier.includes('/')) { const parts = lowerIdentifier.split('/'); if (parts.length === 2 && parts[0] && parts[1]) { owner = parts[0]; repo = parts[1]; } }
    else { repo = lowerIdentifier.startsWith('gravityforms') ? lowerIdentifier : `gravityforms${lowerIdentifier}`; owner = GITHUB_OWNER; }
    // --- End Resolve Repo Name ---

    if (!repo) {
        await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, { text: `❌ Couldn't determine repository for '${repoIdentifier}'.` });
        return true;
    }
    console.log(`[CH - Release] Resolved to: ${owner}/${repo}`);

    if (!githubToken || !appOctokitInstance) {
        await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, { text: `❌ GitHub integration not configured.` });
        return true;
    }

    try {
        await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, { text: `:satellite: Fetching release for ${owner}/${repo}...` });
        const releaseInfo = await getLatestRelease(appOctokitInstance, owner, repo);
        await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, null); // Delete thinking message

        if (releaseInfo) {
            const publishedDate = new Date(releaseInfo.publishedAt).toLocaleDateString();
            const messageText = `Latest release for *${owner}/${repo}*: <${releaseInfo.url}|*${releaseInfo.tagName}*> (Published ${publishedDate}).`;
            const block = markdownToRichTextBlock(messageText);
            await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: `Release ${owner}/${repo}: ${releaseInfo.tagName}`, blocks: block ? [block] : undefined });
        } else {
            await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: `No releases found for ${owner}/${repo}.` });
        }
        return true;

    } catch (githubError) {
        console.error(`[CH - Release] Error for ${owner}/${repo}:`, githubError);
        await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, { text: `❌ Error fetching release for ${owner}/${repo}: ${githubError.message}` });
        return true; // Handled (error reported)
    }
}

/**
 * Handles the 'gh> review pr' command.
 */
async function handlePrReviewCommand(owner, repo, prNumber, workspaceSlug, replyTarget, channel, slack, appOctokitInstance, thinkingMessagePromise) {
    console.log(`[Command Handler] Handling 'gh> review pr' for PR ${owner}/${repo}#${prNumber} in workspace ${workspaceSlug}`);

    if (!githubToken || !appOctokitInstance) {
         await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, { text: `❌ GitHub integration not configured.` });
        return true;
    }

    try {
        await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, { text: `:robot_face: Fetching PR ${owner}/${repo}#${prNumber}...` });
        const prDetails = await getPrDetailsForReview(appOctokitInstance, owner, repo, prNumber);

        if (!prDetails) {
             await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, { text: `❌ Couldn't fetch PR ${owner}/${repo}#${prNumber}.` });
            return true;
        }

        // --- Construct PR context (limited size) ---
        let prContext = `**PR:** ${owner}/${repo}#${prNumber}\n**Title:** ${prDetails.title}\n**Desc:**\n${(prDetails.body || '').substring(0, 1000)}\n\n**Changes:**\n`;
        const MAX_DIFF_SIZE = 3000; const MAX_TOTAL_DIFF_SIZE = 20000; let currentTotalDiffSize = 0; let diffTruncatedOverall = false;
        (prDetails.files || []).forEach(file => {
            if (currentTotalDiffSize >= MAX_TOTAL_DIFF_SIZE) { diffTruncatedOverall = true; return; }
            prContext += `\n**File:** ${file.filename} (${file.status})\n`;
            if (file.patch) {
                let diffContent = file.patch; let diffTruncatedFile = false;
                if (diffContent.length > MAX_DIFF_SIZE) { diffContent = diffContent.substring(0, MAX_DIFF_SIZE); diffTruncatedFile = true; }
                if (currentTotalDiffSize + diffContent.length > MAX_TOTAL_DIFF_SIZE) { const remainingSpace = MAX_TOTAL_DIFF_SIZE - currentTotalDiffSize; diffContent = diffContent.substring(0, remainingSpace); diffTruncatedOverall = true; }
                prContext += `\`\`\`diff\n${diffContent}\n\`\`\`\n`; if (diffTruncatedFile && !diffTruncatedOverall) prContext += `... (diff truncated)\n`; currentTotalDiffSize += diffContent.length;
            } else { prContext += `(No diff)\n`; }
        });
        if (diffTruncatedOverall) prContext += `\n... (Overall diff truncated)\n`;
        const MAX_COMMENTS = 5; if (prDetails.comments && prDetails.comments.length > 0) {
            prContext += `\n**Recent Comments (${Math.min(prDetails.comments.length, MAX_COMMENTS)}):**\n`;
            prDetails.comments.slice(-MAX_COMMENTS).forEach(c => { prContext += `*${c.user?.login}:* ${(c.body || '').substring(0, 300)}\n---\n`; });
        }
        // --- End Context Construction ---

        const reviewPrompt = `Review PR ${owner}/${repo}#${prNumber}. Focus: quality, bugs, security, best practices. Context (may be truncated):\n${prContext}`;
        await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, { text: `:brain: Asking LLM in \`${workspaceSlug}\` to review PR ${prNumber}...` });

        const analysisResponse = await queryLlm(workspaceSlug, null, reviewPrompt, 'chat');
        if (!analysisResponse) throw new Error('LLM failed to provide analysis.');

        await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, null); // Delete thinking message

        const responseChunks = splitMessageIntoChunks(analysisResponse);
        console.log(`[CH - PR Review] Split into ${responseChunks.length} chunks.`);
        for (let i = 0; i < responseChunks.length; i++) {
             const chunk = responseChunks[i]; const block = markdownToRichTextBlock(chunk);
             await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: `PR Review ${i + 1}`, ...(block ? { blocks: [block] } : { text: chunk }) });
             if (responseChunks.length > 1 && i < responseChunks.length - 1) await new Promise(r => setTimeout(r, 500));
        }
        return true;

    } catch (error) {
        console.error(`[CH - PR Review] Error for ${owner}/${repo}#${prNumber}:`, error);
        await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, { text: `❌ Error reviewing PR ${prNumber}: ${error.message}` });
        return true; // Handled (error reported)
    }
}

/**
 * Handles the 'gh> analyze issue' command.
 */
async function handleIssueAnalysisCommand(owner, repo, issueNumber, userPrompt, replyTarget, channel, slack, appOctokitInstance, thinkingMessagePromise, workspaceSlugForThread, anythingLLMThreadSlug) {
    console.log(`[Command Handler] Handling 'gh> analyze issue' for ${owner}/${repo}#${issueNumber}. User prompt: "${userPrompt}"`);

     if (!workspaceSlugForThread || !anythingLLMThreadSlug) {
         console.error("[CH - Issue Analysis] Missing thread context (workspace/thread slug).");
          await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, { text: `❌ Internal error: Missing context.` });
         return true;
     }
    if (!githubToken || !appOctokitInstance) {
        await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, { text: `❌ GitHub integration not configured.` });
        return true;
    }

    try {
        await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, { text: `:robot_face: Fetching issue ${owner}/${repo}#${issueNumber}...` });
        const issueDetails = await getGithubIssueDetails(appOctokitInstance, issueNumber, owner, repo);

        if (!issueDetails) {
             await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, { text: `❌ Couldn't fetch issue ${owner}/${repo}#${issueNumber}.` });
            return true;
        }

        // --- Construct Context ---
        let issueContext = `**Issue:** ${owner}/${repo}#${issueNumber}\n**Title:** ${issueDetails.title}\n**URL:** <${issueDetails.url}|View>\n**Body:**\n${(issueDetails.body || '').substring(0, 2000)}\n\n`;
        const MAX_COMMENTS_ISSUE = 5; const MAX_COMMENT_LENGTH = 300;
        if (issueDetails.comments && issueDetails.comments.length > 0) {
             issueContext += `**Recent Comments (${Math.min(issueDetails.comments.length, MAX_COMMENTS_ISSUE)}):**\n`;
             issueDetails.comments.slice(-MAX_COMMENTS_ISSUE).forEach(c => { issueContext += `*${c.user}:* ${(c.body || '').substring(0, MAX_COMMENT_LENGTH)}\n---\n`; });
        }
        // --- End Context ---

        await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, { text: `:mag: Summarizing issue #${issueNumber}...` });
        const summarizePrompt = `Summarize GitHub issue ${owner}/${repo}#${issueNumber}:\n\n${issueContext}`;
        const summaryResponse = await queryLlm(workspaceSlugForThread, anythingLLMThreadSlug, summarizePrompt); // Use thread context
        if (!summaryResponse) throw new Error('LLM failed summary.');

        const summaryBlock = markdownToRichTextBlock(`*Summary for issue #${issueNumber}:*\n${summaryResponse}`);
        await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: `Summary issue #${issueNumber}:`, blocks: summaryBlock ? [summaryBlock] : undefined });

        await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, { text: `:brain: Analyzing issue #${issueNumber} ${userPrompt ? 'with prompt...' : ''}` });
        let analyzePrompt = `Based on summary ("${summaryResponse.substring(0, 300)}...") and context, analyze issue ${owner}/${repo}#${issueNumber}`;
        if (userPrompt) { analyzePrompt += ` addressing: "${userPrompt}"`; } else { analyzePrompt += `. Key points, causes, next steps?`; }
        analyzePrompt += `\n\n**Full Context:**\n${issueContext}`;
        const analysisResponse = await queryLlm(workspaceSlugForThread, anythingLLMThreadSlug, analyzePrompt); // Use thread context
        if (!analysisResponse) throw new Error('LLM failed analysis.');

        await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, null); // Delete thinking message

        const analysisChunks = splitMessageIntoChunks(analysisResponse);
        for (let i = 0; i < analysisChunks.length; i++) { /* ... post chunks ... */
            const chunk = analysisChunks[i]; const block = markdownToRichTextBlock(chunk);
            await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: `Analysis ${i + 1}`, ...(block ? { blocks: [block] } : { text: chunk }) });
            if (analysisChunks.length > 1 && i < analysisChunks.length - 1) await new Promise(r => setTimeout(r, 500));
        }
        return true;

    } catch (error) {
        console.error(`[CH - Issue Analysis] Error for ${owner}/${repo}#${issueNumber}:`, error);
        await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, { text: `❌ Error analyzing issue #${issueNumber}: ${error.message}` });
        return true; // Handled (error reported)
    }
}


/**
 * Handles the generic 'gh> api' command.
 */
async function handleGithubApiCommand(apiQuery, replyTarget, channel, slack, thinkingMessagePromise, githubWorkspaceSlug, formatterWorkspaceSlug) {
    console.log(`[Command Handler] Handling 'gh> api' with query: "${apiQuery}"`);

    if (!githubToken) { await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, { text: "❌ GitHub token not configured." }); return true; }
    if (!githubWorkspaceSlug) { await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, { text: "❌ GitHub API workspace not configured." }); return true; }

    try {
        await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, { text: `:nerd_face: Figuring out API call for: "${apiQuery.substring(0, 50)}..."` });
        const llmPrompt = `Based on the user request, generate the JSON object needed to call the GitHub REST API using 'fetch'. ONLY output the JSON. User Request: ${apiQuery}`;
        const llmResponse = await queryLlm(githubWorkspaceSlug, null, llmPrompt, 'chat'); // Use GitHub workspace
        if (!llmResponse) throw new Error('GitHub workspace LLM returned empty.');

        let cleanedJsonString = llmResponse.trim();
        const jsonMatch = cleanedJsonString.match(/```json\s*([\s\S]*?)\s*```/); if (jsonMatch && jsonMatch[1]) cleanedJsonString = jsonMatch[1].trim(); else if (!cleanedJsonString.startsWith('{') || !cleanedJsonString.endsWith('}')) throw new Error(`LLM response not JSON: ${llmResponse}`);
        let apiDetails; try { apiDetails = JSON.parse(cleanedJsonString); if (!apiDetails.endpoint) throw new Error("Missing 'endpoint'."); } catch (e) { throw new Error(`Failed parse LLM JSON: ${e.message}. Raw: ${llmResponse}`); }

        await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, { text: `:satellite: Calling GitHub API: ${apiDetails.method || 'GET'} ${apiDetails.endpoint}` });
        const githubResponse = await callGithubApi(apiDetails); // Uses fetch + token
        console.log("[CH - API] Received response from GitHub.");

        let finalResponseText = ''; const rawJsonString = JSON.stringify(githubResponse, null, 2);
        if (formatterWorkspaceSlug) {
            await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, { text: `:art: Formatting response...` });
            const formatPrompt = `Format API JSON response into Markdown:\n\n\`\`\`json\n${rawJsonString}\n\`\`\``;
            try {
                const formatted = await queryLlm(formatterWorkspaceSlug, null, formatPrompt, 'chat');
                if (formatted?.trim()) { let cleaned = formatted.trim(); if (cleaned.startsWith('```markdown')) cleaned = cleaned.substring(11); else if (cleaned.startsWith('```')) cleaned = cleaned.substring(3); if (cleaned.endsWith('```')) cleaned = cleaned.substring(0, cleaned.length - 3); finalResponseText = cleaned.trim(); console.log("[CH - API] Formatted response."); }
                else { throw new Error("Formatter empty."); }
            } catch (formatError) { console.error('[CH - API] Formatter LLM Error:', formatError); finalResponseText = `(Formatting Error)\n\nRaw:\n\`\`\`json\n${rawJsonString}\n\`\`\``; }
        } else { finalResponseText = `Raw Response:\n\`\`\`json\n${rawJsonString}\n\`\`\``; }

        await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, null); // Delete thinking message

        const chunks = splitMessageIntoChunks(finalResponseText);
        for (let i = 0; i < chunks.length; i++) { /* ... post chunks ... */
             const chunk = chunks[i]; const block = markdownToRichTextBlock(chunk);
             await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: chunk.substring(0,200)+'...', ...(block ? { blocks: [block] } : { text: chunk }) });
             if (chunks.length > 1 && i < chunks.length - 1) await new Promise(r => setTimeout(r, 500));
        }
        return true;

    } catch (error) {
        console.error('[CH - API] Error:', error);
        await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, { text: `❌ Error processing \`gh> api\`: ${error.message}` });
        return true; // Handled (error reported)
    }
}

export {
    handleDeleteLastMessageCommand,
    handleReleaseInfoCommand,
    handlePrReviewCommand,
    handleIssueAnalysisCommand,
    handleGithubApiCommand
};
