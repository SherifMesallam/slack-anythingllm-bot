// Handlers for specific commands (slash commands, prefixed text commands)
import logger from '../logger.js';
import {
    botUserId,
    githubFeaturesEnabled,
    conversationExportEnabled,
    GITHUB_OWNER, // Import default owner if needed
    // Specific config variables needed by handlers:
    githubWorkspaceSlug,
    formatterWorkspaceSlug,
    githubIssueAnalysisWorkspaceSlug,
    githubPrReviewWorkspaceSlug
} from '../config.js'; // Need botUserId, feature flags, specific workspace slugs
import { getLatestRelease, getPrDetails } from '../services.js'; // Import the migrated function and getPrDetails
import { markdownToRichTextBlock, getGithubIssueDetails } from '../utils.js'; // Import formatting utility and getGithubIssueDetails
import { exportConversationToMarkdown } from '../conversation-export.js'; // Import the export function
import { callGithubApi } from '../utils.js'; // Import callGithubApi
import { queryLlm } from '../llm.js'; // Import LLM query function for API handler
// Import services and utils as needed later

// Example placeholder
// export async function handleDeleteLastMessage({ channel, threadTs, user, replyTarget }) {
//   logger.info({ channel, threadTs, user }, 'Handling delete last message command');
//   // Implementation...
// }

/**
 * Handles the '#delete_last_message' command.
 * Finds the last message sent by the bot in the thread (excluding confirmations) and deletes it.
 * Posts ephemeral success or error messages.
 * @param {object} params
 * @param {string} params.channel - The channel ID.
 * @param {string} params.originalTs - The timestamp of the user's command message.
 * @param {string|null} params.threadTs - The thread timestamp (if applicable).
 * @param {string} params.replyTarget - The TS to reply in thread (threadTs or originalTs).
 * @param {object} params.slackWebClient - The initialized Slack WebClient.
 * @param {string} params.userId - The ID of the user invoking the command.
 */
export async function handleDeleteLastMessage({ channel, originalTs, threadTs, replyTarget, slackWebClient, userId }) {
  logger.info({ channel, userId, replyTarget }, 'Handling #delete_last_message command');
  try {
    // Fetch thread history to find bot's last message
    // Use threadTs or originalTs to correctly fetch replies even if command is outside thread
    const historyResult = await slackWebClient.conversations.replies({
      channel: channel,
      ts: threadTs || originalTs,
      limit: 20 // Fetch enough messages to find recent bot messages
    });

    if (historyResult.ok && historyResult.messages) {
      // Find the last message from the bot in the fetched messages
      const lastBotMessage = historyResult.messages
        .slice() // Create a shallow copy before reversing to avoid mutating the original array
        .reverse() // Start from most recent
        .find(msg =>
          msg.user === botUserId &&
          msg.ts !== originalTs && // Don't delete the command message itself if it was somehow the bot's
          !msg.text?.includes('✅') && // Exclude confirmation messages
          !msg.text?.includes('❌')   // Exclude error messages
        );

      if (lastBotMessage) {
        try {
          // Try to delete the message
          await slackWebClient.chat.delete({
            channel: channel,
            ts: lastBotMessage.ts
          });
          logger.info({ channel, ts: lastBotMessage.ts }, 'Successfully deleted last bot message');

          // Send confirmation and delete it after 5 seconds
          const confirmMsg = await slackWebClient.chat.postMessage({
            channel: channel,
            thread_ts: replyTarget,
            text: "✅ Last message deleted."
          });

          // Delete confirmation message after 5 seconds
          setTimeout(async () => {
            try {
              await slackWebClient.chat.delete({
                channel: channel,
                ts: confirmMsg.ts
              });
            } catch (deleteError) {
              logger.error({ error: deleteError, channel, ts: confirmMsg.ts }, 'Error deleting confirmation message');
            }
          }, 5000);

        } catch (deleteError) {
          logger.error({ error: deleteError, channel, ts: lastBotMessage.ts }, 'Error deleting bot message');
          await slackWebClient.chat.postMessage({
            channel: channel,
            thread_ts: replyTarget,
            text: "❌ Sorry, I couldn't delete the message. It might be too old or I might not have permission."
          });
        }
      } else {
        logger.warn({ channel, replyTarget }, 'Could not find a recent deletable message from the bot in this thread');
        await slackWebClient.chat.postMessage({
          channel: channel,
          thread_ts: replyTarget,
          text: "❌ I couldn't find my last message in this thread to delete."
        });
      }
    } else {
      logger.error({ channel, replyTarget, error: historyResult.error }, 'Failed to fetch thread history for deletion');
      // Throw an error to be caught by the outer try/catch
      throw new Error(`Failed to fetch thread history: ${historyResult.error}`);
    }
  } catch (error) {
    logger.error({ error, channel, userId, replyTarget }, 'Error handling delete_last_message command');
    // Send a generic error message back to the user
    try {
      await slackWebClient.chat.postMessage({
        channel: channel,
        thread_ts: replyTarget,
        text: "❌ An error occurred while trying to delete the message."
      });
    } catch (postError) {
      logger.error({ error: postError, channel, userId }, 'Failed to post error message during delete_last_message handling');
    }
  }
}

/**
 * Handles requests for the latest GitHub release information based on a product name.
 * @param {object} params
 * @param {string} params.channel - The channel ID.
 * @param {string} params.replyTarget - The TS to reply in thread.
 * @param {object} params.slackWebClient - The initialized Slack WebClient.
 * @param {string} params.productNameInput - The product name extracted from the user query.
 * @param {string} params.userId - The user ID invoking the command.
 */
export async function handleGithubReleaseCheck({ channel, replyTarget, slackWebClient, productNameInput, userId }) {
    const logContext = { channel, userId, replyTarget, productNameInput };
    logger.info(logContext, 'Handling GitHub latest release check command');

    if (!githubFeaturesEnabled) {
        logger.warn(logContext, 'GitHub features disabled, skipping release check.');
        // Optionally send a message back
        // await slackWebClient.chat.postMessage({ channel, thread_ts: replyTarget, text: "GitHub features are currently disabled." });
        return;
    }

    let owner = 'gravityforms'; // Default owner
    let repo = null;
    let productName = productNameInput.toLowerCase().trim();

    // --- Product Name to Repo Mapping Logic (from original file) ---
    const abbreviations = {
        'gf': 'gravityforms',
        'ppcp': 'gravityformsppcp',
        'paypal checkout': 'gravityformsppcp',
        'paypal': 'gravityformsppcp',
        'stripe': 'gravityformsstripe',
        'authorize.net': 'gravityformsauthorizenet',
        'user registration': 'gravityformsuserregistration',
        'core': 'gravityforms'
    };
    if (productName === 'gravityflow') {
        repo = 'gravityflow';
    } else if (abbreviations[productName]) {
        repo = abbreviations[productName];
    } else {
        // Clean up common suffixes and prefixes
        productName = productName.replace(/\s+addon$/, '').replace(/\s+checkout$/, '');
        repo = productName.startsWith('gravityforms') ? productName : `gravityforms${productName}`;
    }
    // --- End Mapping Logic ---

    if (!repo) {
        logger.warn({ ...logContext, productName }, 'Could not determine a valid repository for the product name.');
        try {
            await slackWebClient.chat.postMessage({
                channel,
                thread_ts: replyTarget,
                text: `Sorry, I couldn't figure out the repository for "${productNameInput}".`
            });
        } catch (e) { logger.error({ ...logContext, error: e }, 'Failed to post repo determination error'); }
        return;
    }

    logger.debug({ ...logContext, owner, repo }, 'Determined GitHub target for release check');

    try {
        const releaseInfo = await getLatestRelease(owner, repo); // Call the service function

        if (releaseInfo) {
            const publishedDate = new Date(releaseInfo.publishedAt).toLocaleDateString();
            const messageText = `The latest release for *${owner}/${repo}* is <${releaseInfo.url}|*${releaseInfo.tagName}*>. Published on ${publishedDate}.`;
            const richTextBlock = markdownToRichTextBlock(messageText, `release_${owner}_${repo}`);

            if (richTextBlock) {
                await slackWebClient.chat.postMessage({
                    channel,
                    thread_ts: replyTarget,
                    text: `Latest release for ${owner}/${repo}: ${releaseInfo.tagName} (${publishedDate})`, // Fallback text
                    blocks: [richTextBlock]
                });
                logger.info({ ...logContext, owner, repo, tag: releaseInfo.tagName }, 'Successfully posted GitHub release info');
            } else {
                // Fallback to plain text if block creation fails
                logger.warn({ ...logContext, owner, repo }, 'Failed to generate rich text block for release info, sending plain text.');
                await slackWebClient.chat.postMessage({
                    channel,
                    thread_ts: replyTarget,
                    text: messageText // Send the slightly richer text version
                });
            }
        } else {
            // Handle case where getLatestRelease returned null (no release found or error occurred)
            logger.info({ ...logContext, owner, repo }, 'No release information found for repository.');
            await slackWebClient.chat.postMessage({
                channel,
                thread_ts: replyTarget,
                text: `I couldn't find any releases for ${owner}/${repo}. It might not exist or hasn't had a release yet.`
            });
        }
    } catch (error) {
        logger.error({ ...logContext, owner, repo, error }, 'Error during GitHub release check processing');
        try {
            await slackWebClient.chat.postMessage({
                channel,
                thread_ts: replyTarget,
                text: `Sorry, I encountered an error checking for the latest release of ${owner}/${repo}.`
            });
        } catch (e) { logger.error({ ...logContext, error: e }, 'Failed to post release check error message'); }
    }
}

/**
 * Handles requests to export a Slack conversation thread to a Markdown file.
 * @param {object} params
 * @param {string} params.channelId - The channel ID.
 * @param {string} params.threadTs - The timestamp of the thread to export.
 * @param {string} params.userId - The user ID invoking the command.
 * @param {object} params.slackWebClient - The initialized Slack WebClient.
 */
export async function handleExportCommand({ channelId, threadTs, userId, slackWebClient }) {
    const logContext = { channelId, threadTs, userId };
    logger.info(logContext, 'Handling export command');

    if (!conversationExportEnabled) {
        logger.warn(logContext, 'Conversation export feature is disabled.');
        try {
            await slackWebClient.chat.postMessage({
                channel: channelId,
                thread_ts: threadTs, // Reply in thread
                text: 'Sorry, the conversation export feature is currently disabled.'
            });
        } catch (e) { logger.error({ ...logContext, error: e }, 'Failed to post export disabled message'); }
        return;
    }

    if (!threadTs) {
        logger.warn(logContext, 'Export command called without a thread timestamp.');
        try {
             await slackWebClient.chat.postMessage({
                channel: channelId,
                // No thread_ts here, post in channel
                text: 'Please use the export command within the thread you want to export, or ensure it is triggered correctly.'
            });
        } catch (e) { logger.error({ ...logContext, error: e }, 'Failed to post export no thread message'); }
        return;
    }

    let statusMessage = null;
    try {
        // Send initial status message
        statusMessage = await slackWebClient.chat.postMessage({
            channel: channelId,
            thread_ts: threadTs,
            text: ':hourglass_flowing_sand: Exporting conversation...',
        });
        logger.debug({ ...logContext, statusTs: statusMessage?.ts }, 'Posted initial export status message');

        // Export the conversation
        // Pass the slackWebClient instance
        const exportResult = await exportConversationToMarkdown(channelId, threadTs, slackWebClient);
        const { content, metadata, llmResponse, llmError } = exportResult;

        if (!content) {
            throw new Error('Export function returned empty content.');
        }

        // Upload as a file in Slack using uploadV2
        logger.debug({ ...logContext, fileName: `conversation-${metadata?.channelName}-${threadTs}.md` }, 'Uploading exported file to Slack');
        await slackWebClient.files.uploadV2({
            channel_id: channelId,
            thread_ts: threadTs,
            content: content,
            filename: `conversation-${metadata?.channelName || 'channel'}-${threadTs}.md`,
            title: `Conversation Export - #${metadata?.channelName || 'thread'}`,
            initial_comment: 'Here\'s your conversation export! :file_folder:'
        });

        // Prepare final status message based on export and potential LLM upload result
        let statusText = ':white_check_mark: Conversation exported successfully!';
        // Append LLM status if available (this part might need adjustment based on exportConversationToMarkdown details)
        if (llmResponse?.success) {
            statusText += '\n:brain: Also added to AnythingLLM conversations workspace!';
        } else if (llmError) {
            statusText += `\n:warning: Note: Could not add to AnythingLLM (${llmError})`;
        }

        // Update status message
        if (statusMessage?.ts) {
            await slackWebClient.chat.update({
                channel: channelId,
                ts: statusMessage.ts,
                text: statusText,
                blocks: [] // Clear blocks from initial message
            });
            logger.info(logContext, 'Export successful, updated status message.');
        } else {
             // If initial status failed, post final status as new message
             await slackWebClient.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: statusText });
             logger.info(logContext, 'Export successful, posted new status message (initial failed).');
        }

    } catch (error) {
        logger.error({ ...logContext, error }, 'Error handling export command');
        const errorText = ':x: Sorry, there was an error exporting the conversation. Please try again.';
        // Try to update status message or post a new one
        try {
             if (statusMessage?.ts) {
                 await slackWebClient.chat.update({ channel: channelId, ts: statusMessage.ts, text: errorText, blocks: [] });
             } else {
                 await slackWebClient.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: errorText });
             }
        } catch (postError) {
             logger.error({ ...logContext, error: postError }, 'Failed to post export error status message');
        }
    }
}

/**
 * Handles GitHub-related commands prefixed with 'gh-'.
 * Parses arguments to determine the specific action (issue, release, pr, etc.).
 * @param {string} commandArgs - The arguments following the 'gh-' prefix.
 * @param {object} context
 * @param {string} context.channelId - The channel ID.
 * @param {string} context.replyTarget - The TS to reply in thread.
 * @param {object} context.slackWebClient - The initialized Slack WebClient.
 * @param {string} context.userId - The user ID invoking the command.
 */
export async function handleGithubPrefixedCommand(commandArgs, { channelId, replyTarget, slackWebClient, userId }) {
    const logContext = { channelId, userId, replyTarget, commandArgs };
    logger.info(logContext, 'Handling gh- prefixed command');

    if (!githubFeaturesEnabled) {
        logger.warn(logContext, 'GitHub features disabled, ignoring gh- command.');
        return;
    }

    const args = commandArgs.split(/\s+/);
    const subCommand = args[0]?.toLowerCase();

    try {
        switch (subCommand) {
            case 'release': { // Example: gh-release gravityforms/gravityforms
                const repoArg = args[1]; // Expects owner/repo format
                if (!repoArg || !repoArg.includes('/')) {
                    await slackWebClient.chat.postMessage({ channel: channelId, thread_ts: replyTarget, text: 'Usage: `gh-release owner/repo`' });
                    return;
                }
                const [owner, repo] = repoArg.split('/');
                logger.debug({ ...logContext, owner, repo }, 'Calling getLatestRelease for gh- command');
                const releaseInfo = await getLatestRelease(owner, repo);
                if (releaseInfo) {
                    const publishedDate = new Date(releaseInfo.publishedAt).toLocaleDateString();
                    const messageText = `The latest release for *${owner}/${repo}* is <${releaseInfo.url}|*${releaseInfo.tagName}*>. Published on ${publishedDate}.`;
                    const richTextBlock = markdownToRichTextBlock(messageText, `release_${owner}_${repo}`);
                    if (richTextBlock) {
                        await slackWebClient.chat.postMessage({ channel: channelId, thread_ts: replyTarget, text: `Latest release for ${owner}/${repo}: ${releaseInfo.tagName} (${publishedDate})`, blocks: [richTextBlock] });
                    } else {
                        await slackWebClient.chat.postMessage({ channel: channelId, thread_ts: replyTarget, text: messageText });
                    }
                } else {
                    await slackWebClient.chat.postMessage({ channel: channelId, thread_ts: replyTarget, text: `I couldn't find any releases for ${owner}/${repo}.` });
                }
                break;
            }

            case 'issue': { // Example: gh-issue gravityforms/backlog#123 or gh-issue 123 (uses default owner/repo)
                const issueArg = args[1];
                if (!issueArg) {
                    await slackWebClient.chat.postMessage({ channel: channelId, thread_ts: replyTarget, text: 'Usage: `gh-issue [owner/repo]#<number>` or `gh-issue <number>` (uses default repo)' });
                    return;
                }

                let owner = GITHUB_OWNER; // Use default owner
                let repo = 'backlog'; // Default repo for issues for now
                let issueNumberStr;

                if (issueArg.includes('#')) {
                    const parts = issueArg.split('#');
                    if (parts[0].includes('/')) {
                        [owner, repo] = parts[0].split('/');
                    }
                    issueNumberStr = parts[1];
                } else {
                    issueNumberStr = issueArg;
                }

                const issueNumber = parseInt(issueNumberStr, 10);
                if (isNaN(issueNumber)) {
                     await slackWebClient.chat.postMessage({ channel: channelId, thread_ts: replyTarget, text: 'Invalid issue number provided.' });
                    return;
                }

                logger.debug({ ...logContext, owner, repo, issueNumber }, 'Calling getGithubIssueDetails for gh- command');
                const issueDetails = await getGithubIssueDetails(issueNumber, owner, repo); // Assuming function takes owner/repo

                if (issueDetails) {
                    let messageText = `*Issue:* <${issueDetails.url}|${owner}/${repo}#${issueNumber}>n*Title:* ${issueDetails.title}n`;
                    if (issueDetails.state) messageText += `*State:* ${issueDetails.state}n`;
                    // Truncate body for preview
                    const bodyPreview = issueDetails.body?.substring(0, 500) + (issueDetails.body?.length > 500 ? '...' : '');
                    messageText += `*Body:*n${bodyPreview || '(No body)'}`;

                    const richTextBlock = markdownToRichTextBlock(messageText, `issue_${owner}_${repo}_${issueNumber}`);
                     if (richTextBlock) {
                        await slackWebClient.chat.postMessage({ channel: channelId, thread_ts: replyTarget, text: `Details for ${owner}/${repo}#${issueNumber}: ${issueDetails.title}`, blocks: [richTextBlock] });
                    } else {
                        await slackWebClient.chat.postMessage({ channel: channelId, thread_ts: replyTarget, text: messageText });
                    }
                } else {
                     await slackWebClient.chat.postMessage({ channel: channelId, thread_ts: replyTarget, text: `I couldn't fetch details for issue ${owner}/${repo}#${issueNumber}. Please check the details.` });
                }
                break;
            }

            case 'pr': { // Example: gh-pr gravityforms/gravityforms#1234 or gh-pr 1234 (uses default owner/repo)
                const prArg = args[1];
                if (!prArg) {
                    await slackWebClient.chat.postMessage({ channel: channelId, thread_ts: replyTarget, text: 'Usage: `gh-pr [owner/repo]#<number>` or `gh-pr <number>` (uses default repo)' });
                    return;
                }

                let owner = GITHUB_OWNER; // Use default owner
                let repo = null; // Default repo for PRs? Need to decide. Let's assume it's specified or error.
                let prNumberStr;

                if (prArg.includes('#')) {
                    const parts = prArg.split('#');
                    if (parts[0].includes('/')) {
                        [owner, repo] = parts[0].split('/');
                    }
                    prNumberStr = parts[1];
                } else {
                    // If only number, need a default repo or error
                    // For now, let's assume repo must be specified in format owner/repo#number
                     await slackWebClient.chat.postMessage({ channel: channelId, thread_ts: replyTarget, text: 'Usage: `gh-pr owner/repo#<number>`' });
                     return;
                    // Alternatively, uncomment below and set a default PR repo if desired
                    // repo = 'your_default_pr_repo';
                    // prNumberStr = prArg;
                }

                 if (!repo) { // Ensure repo was set
                     await slackWebClient.chat.postMessage({ channel: channelId, thread_ts: replyTarget, text: 'Please specify the repository in `owner/repo#<number>` format.' });
                     return;
                 }

                const prNumber = parseInt(prNumberStr, 10);
                if (isNaN(prNumber)) {
                     await slackWebClient.chat.postMessage({ channel: channelId, thread_ts: replyTarget, text: 'Invalid PR number provided.' });
                    return;
                }

                logger.debug({ ...logContext, owner, repo, prNumber }, 'Calling getPrDetails for gh- command');
                const prDetails = await getPrDetails(owner, repo, prNumber); // Call the service

                if (prDetails) {
                    let messageText = `*PR:* <${prDetails.url}|${owner}/${repo}#${prNumber}>\n*Title:* ${prDetails.title}\n`;
                    messageText += `*Author:* ${prDetails.user} | *State:* ${prDetails.state}\n`;
                    const bodyPreview = prDetails.body?.substring(0, 500) + (prDetails.body?.length > 500 ? '...' : '');
                    messageText += `*Description:*\n${bodyPreview || '(No description)'}`;

                    const richTextBlock = markdownToRichTextBlock(messageText, `pr_${owner}_${repo}_${prNumber}`);
                     if (richTextBlock) {
                        await slackWebClient.chat.postMessage({ channel: channelId, thread_ts: replyTarget, text: `Details for PR ${owner}/${repo}#${prNumber}: ${prDetails.title}`, blocks: [richTextBlock] });
                    } else {
                        await slackWebClient.chat.postMessage({ channel: channelId, thread_ts: replyTarget, text: messageText });
                    }
                } else {
                     await slackWebClient.chat.postMessage({ channel: channelId, thread_ts: replyTarget, text: `I couldn't fetch details for PR ${owner}/${repo}#${prNumber}. Please check the details.` });
                }
                break;
            }

            case 'api': // Handle gh-api
                handleGithubApiCommand(commandArgs, { channelId, replyTarget, slackWebClient, userId })
                    .catch(err => logger.error({ ...logContext, command: subCommand, error: err }, 'Error executing GitHub API command handler via prefix'));
                break;

            case 'review-pr':
                handleGithubPrReview(commandArgs, { channelId, replyTarget, slackWebClient, userId })
                    .catch(err => logger.error({ ...logContext, command: subCommand, error: err }, 'Error executing GitHub PR review handler via prefix'));
                break;

            case 'analyze-issue':
                 handleGithubIssueAnalysis(commandArgs, { channelId, replyTarget, slackWebClient, userId })
                    .catch(err => logger.error({ ...logContext, command: subCommand, error: err }, 'Error executing GitHub issue analysis handler via prefix'));
                break;

            default:
                logger.warn({ ...logContext, subCommand }, 'Unknown gh- sub-command received.');
                await slackWebClient.chat.postMessage({ channel: channelId, thread_ts: replyTarget, text: `Sorry, I don't recognize the command \`gh-${subCommand}\`. Try \`gh-release\`, \`gh-issue\`, etc.` });
        }
    } catch (error) {
        logger.error({ ...logContext, subCommand, error }, 'Error processing gh- command');
        await slackWebClient.chat.postMessage({ channel: channelId, thread_ts: replyTarget, text: `Sorry, an error occurred while processing your \`gh-${subCommand}\` command.` });
    }
}

/**
 * Handles generic GitHub API commands triggered by a specific prefix (e.g., `gh-api`).
 * Uses an LLM to determine the API call details, executes it via `callGithubApi`,
 * and optionally formats the response using another LLM.
 * @param {string} commandArgs - The user's natural language request for the API call.
 * @param {object} context - Context object.
 * @param {string} context.channelId - Slack channel ID.
 * @param {string} context.replyTarget - Slack message timestamp to reply to.
 * @param {object} context.slackWebClient - The initialized Slack WebClient.
 * @param {string} context.userId - Slack user ID.
 * @returns {Promise<void>}
 */
export async function handleGithubApiCommand(commandArgs, { channelId, replyTarget, slackWebClient, userId }) {
    const logContext = { channelId, replyTarget, userId, commandArgs };
    logger.info({ ...logContext }, 'Handling GitHub API command request');

    if (!githubFeaturesEnabled) {
        logger.warn(logContext, 'GitHub features disabled, ignoring gh-api command.');
        await slackWebClient.chat.postMessage({
            channel: channelId,
            thread_ts: replyTarget,
            text: 'GitHub features are currently disabled.'
        });
        return;
    }

    let thinkingMsg = null; // Define thinkingMsg outside try block to access in finally
    try {
        // 1. Post thinking message
        thinkingMsg = await slackWebClient.chat.postMessage({
            channel: channelId,
            thread_ts: replyTarget,
            text: ':brain: Asking the AI overlords how to call the GitHub API for you...'
        });

        // 2. Validate config (use direct variable)
        if (!githubWorkspaceSlug) {
            throw new Error('GitHub API generation workspace (githubWorkspaceSlug) is not configured.');
        }

        // 3. Call LLM (githubWorkspaceSlug) (use direct variable)
        logger.debug({ ...logContext }, 'Calling LLM to generate GitHub API details...');
        const apiGenPrompt = `You are an AI assistant that translates natural language requests into GitHub API call details. Given the user request below, generate a JSON object containing the necessary details to call the GitHub REST API. The JSON object should have the following keys: "endpoint" (required, the full API URL like "https://api.github.com/repos/owner/repo/issues"), "method" (optional, defaults to GET, e.g., "POST", "PATCH"), "parameters" (optional, an object containing URL query parameters for GET or the request body for POST/PATCH/PUT), and "headers" (optional, an object for any custom headers needed beyond standard auth/accept provided by the caller).\\n\\nUser Request: "${commandArgs}"\\n\\nOutput ONLY the JSON object:\\n`;

        // NOTE: queryLlm typically needs a threadSlug. We might need a dedicated utility thread 
        // or adapt queryLlm/llm.js if it can handle direct workspace queries without a persistent thread.
        // For now, assuming queryLlm can work with just workspace slug and prompt, or handle thread implicitly.
        const llmApiDetailsResponse = await queryLlm(githubWorkspaceSlug, null, apiGenPrompt); // Pass null for threadSlug for now

        if (!llmApiDetailsResponse) {
            throw new Error('LLM did not provide a response for API details generation.');
        }

        let apiDetails;
        try {
            // Attempt to parse the LLM response as JSON
            // Trim the response first in case of leading/trailing whitespace or markdown code fences
            const cleanedLlmResponse = llmApiDetailsResponse.trim().replace(/^```json\n?|```$/g, '').trim();
            apiDetails = JSON.parse(cleanedLlmResponse);
            logger.debug({ ...logContext, parsedApiDetails: apiDetails }, 'Successfully parsed API details from LLM response');
        } catch (parseError) {
            logger.error({ ...logContext, llmResponse: llmApiDetailsResponse, error: parseError }, 'Failed to parse API details JSON from LLM response.');
            throw new Error(`I received an invalid format from the AI trying to generate the API call details. Response: ${llmApiDetailsResponse}`);
        }

        // Basic validation
        if (!apiDetails || typeof apiDetails !== 'object' || !apiDetails.endpoint || typeof apiDetails.endpoint !== 'string') {
            logger.error({ ...logContext, invalidApiDetails: apiDetails }, 'LLM generated invalid or incomplete API details object.');
            throw new Error('LLM generated invalid or incomplete API call details.');
        }

        // 4. Call the utility function
        logger.debug({ ...logContext, apiDetails }, 'Calling callGithubApi utility...');
        const apiResponse = await callGithubApi(apiDetails); // Pass the parsed details

        // 5. Optionally format response (use direct variable)
        let formattedResponseText = null;
        let responseAsFile = false;
        const MAX_MESSAGE_LENGTH = 3800; // Slack message limit is ~4000, leave some buffer

        if (formatterWorkspaceSlug && typeof apiResponse === 'object' && apiResponse !== null) {
            logger.debug({ ...logContext }, 'Calling LLM to format API response...');
            const formatPrompt = `You are an AI assistant that summarizes GitHub API JSON responses into user-friendly text suitable for Slack. Format the following JSON response concisely:\\n\\n${JSON.stringify(apiResponse, null, 2)}\\n\\nSummary:`;
            // Assuming queryLlm can handle this scenario (might need adaptation)
            formattedResponseText = await queryLlm(formatterWorkspaceSlug, null, formatPrompt);

            if (!formattedResponseText) {
                logger.warn({ ...logContext }, 'Formatting LLM failed to provide a response. Falling back to raw JSON.');
                // Fall through to raw JSON formatting
            } else {
                 logger.debug({ ...logContext }, 'Received formatted response from LLM.');
            }
        }

        // If formatting wasn't attempted, wasn't successful, or wasn't applicable
        if (!formattedResponseText) {
            const rawJsonString = JSON.stringify(apiResponse, null, 2);
            if (rawJsonString.length > MAX_MESSAGE_LENGTH) {
                responseAsFile = true;
                formattedResponseText = rawJsonString; // Store raw JSON for file upload
                logger.info({ ...logContext, length: rawJsonString.length }, 'API response too large, will upload as file.');
            } else {
                // Construct the string without nested backticks for clarity
                formattedResponseText = '*Raw API Response:*\n```json\n' + rawJsonString + '\n```';
            }
        }

        // 6. Post final response (either as message or file)
        if (responseAsFile) {
            await slackWebClient.files.uploadV2({
                channel_id: channelId,
                thread_ts: replyTarget,
                content: formattedResponseText, // The raw JSON string
                filename: `github-api-response-${Date.now()}.json`,
                filetype: 'json',
                initial_comment: `GitHub API response for your request (\`gh-api: ${commandArgs}\`):`
            });
             logger.info({ ...logContext }, 'Posted API response as file upload.');
        } else {
            const richTextBlock = markdownToRichTextBlock(formattedResponseText);
            await slackWebClient.chat.postMessage({
                channel: channelId,
                thread_ts: replyTarget,
                text: formattedResponseText.substring(0, 300), // Fallback text snippet
                blocks: richTextBlock ? [richTextBlock] : undefined // Use blocks if available
            });
            logger.info({ ...logContext }, 'Posted API response as message.');
        }

        // 7. Delete thinking message (moved to finally block)

    } catch (error) {
        logger.error({ ...logContext, error }, 'Error handling GitHub API command');
        try {
            await slackWebClient.chat.postMessage({
                channel: channelId,
                thread_ts: replyTarget,
                text: `⚠️ Error processing your GitHub API request: ${error.message}`
            });
        } catch (postError) {
            logger.error({ ...logContext, error: postError }, 'Failed to post error message for API command');
        }
    } finally {
        // Ensure thinking message is deleted regardless of success or failure
        if (thinkingMsg?.ts) { // Check if thinkingMsg was successfully created and has a ts
            try {
                await slackWebClient.chat.delete({ channel: channelId, ts: thinkingMsg.ts });
                logger.debug({ ...logContext, ts: thinkingMsg.ts }, 'Deleted thinking message for API command.');
            } catch (delErr) {
                if (delErr.data?.error !== 'message_not_found') {
                     logger.warn({ ...logContext, ts: thinkingMsg.ts, error: delErr }, 'Failed to delete thinking message for API command.');
                }
            }
        }
    }
}

/**
 * Handles requests to analyze a GitHub issue using an LLM.
 * Fetches issue details and uses a specific workspace/prompt for analysis.
 * @param {string} commandArgs - Arguments containing the issue reference ([owner/repo]#number or number).
 * @param {object} context - Context object.
 * @param {string} context.channelId - Slack channel ID.
 * @param {string} context.replyTarget - Slack message timestamp to reply to.
 * @param {object} context.slackWebClient - The initialized Slack WebClient.
 * @param {string} context.userId - Slack user ID.
 * @returns {Promise<void>}
 */
export async function handleGithubIssueAnalysis(commandArgs, { channelId, replyTarget, slackWebClient, userId }) {
    const logContext = { channelId, replyTarget, userId, commandArgs };
    logger.info({ ...logContext }, 'Handling GitHub issue analysis command request');

    if (!githubFeaturesEnabled) {
        logger.warn(logContext, 'GitHub features disabled, ignoring gh-analyze-issue command.');
        await slackWebClient.chat.postMessage({ channel: channelId, thread_ts: replyTarget, text: 'GitHub features are currently disabled.' });
        return;
    }

    if (!githubIssueAnalysisWorkspaceSlug) {
        logger.warn(logContext, 'GitHub issue analysis workspace (githubIssueAnalysisWorkspaceSlug) is not configured.');
        await slackWebClient.chat.postMessage({ channel: channelId, thread_ts: replyTarget, text: 'GitHub issue analysis feature is not configured.' });
        return;
    }

    let thinkingMsg = null;
    try {
        // 1. Post thinking message
        thinkingMsg = await slackWebClient.chat.postMessage({
            channel: channelId,
            thread_ts: replyTarget,
            text: ':female-detective: Analyzing the GitHub issue... Give me a moment.'
        });

        // 2. Parse issue argument (owner/repo#number or number)
        // TODO: Add config for GITHUB_ISSUES_DEFAULT_REPO if allowing just number
        let owner = GITHUB_OWNER; // Default owner
        let repo = 'backlog'; // Default repo for now
        let issueNumberStr;
        const issueArg = commandArgs.trim();

        if (!issueArg) {
             throw new Error('Usage: `gh-analyze-issue [owner/repo]#<number>` or `gh-analyze-issue <number>`');
        }

        if (issueArg.includes('#')) {
            const parts = issueArg.split('#');
            if (parts[0].includes('/')) {
                [owner, repo] = parts[0].split('/');
            } else if (parts[0]) {
                // Allow specifying repo without owner, assuming default owner
                repo = parts[0];
            }
            issueNumberStr = parts[1];
        } else {
            issueNumberStr = issueArg;
            // If only number, should we use a default repo from config?
            // repo = config.GITHUB_ISSUES_DEFAULT_REPO || 'backlog'; 
        }

        const issueNumber = parseInt(issueNumberStr, 10);
        if (isNaN(issueNumber)) {
             throw new Error('Invalid issue number provided.');
        }
        logger.debug({ ...logContext, owner, repo, issueNumber }, 'Parsed issue details for analysis');

        // 3. Fetch issue details
        const issueDetails = await getGithubIssueDetails(issueNumber, owner, repo); // Assuming function takes owner/repo
        if (!issueDetails) {
            throw new Error(`Could not fetch details for issue ${owner}/${repo}#${issueNumber}.`);
        }

        // 4. Prepare prompt and call LLM (use direct variable)
        let issueContent = `Issue Title: ${issueDetails.title}\n\n`;
        if (issueDetails.body) {
            issueContent += `Issue Body:\n${issueDetails.body}\n\n`;
        }
        if (issueDetails.comments && issueDetails.comments.length > 0) {
            issueContent += `Recent Comments:\n`;
            issueDetails.comments.forEach(comment => {
                issueContent += `- ${comment.user}: ${comment.body}\n`;
            });
        }

        const analysisPrompt = `Analyze the following GitHub issue details and provide a concise summary. Identify the core problem or request, and suggest potential next steps or classifications if applicable.\n\nIssue URL: ${issueDetails.url}\n\n${issueContent}\n\nAnalysis:`;

        logger.debug({ ...logContext }, 'Calling LLM for issue analysis...');
        const analysisResult = await queryLlm(githubIssueAnalysisWorkspaceSlug, null, analysisPrompt);

        if (!analysisResult) {
            throw new Error('The AI assistant did not provide an analysis for the issue.');
        }

        // 5. Post the analysis result
        const responseText = `*Analysis for <${issueDetails.url}|${owner}/${repo}#${issueNumber}>:*

${analysisResult}`;
        const richTextBlock = markdownToRichTextBlock(responseText);

        await slackWebClient.chat.postMessage({
            channel: channelId,
            thread_ts: replyTarget,
            text: `AI Analysis for ${owner}/${repo}#${issueNumber}`, // Fallback
            blocks: richTextBlock ? [richTextBlock] : undefined
        });

    } catch (error) {
        logger.error({ ...logContext, error }, 'Error handling GitHub issue analysis command');
        try {
            await slackWebClient.chat.postMessage({
                channel: channelId,
                thread_ts: replyTarget,
                text: `⚠️ Error analyzing GitHub issue: ${error.message}`
            });
        } catch (postError) {
            logger.error({ ...logContext, error: postError }, 'Failed to post error message for issue analysis command');
        }
    } finally {
        // Delete thinking message
        if (thinkingMsg?.ts) {
            try {
                await slackWebClient.chat.delete({ channel: channelId, ts: thinkingMsg.ts });
            } catch (delErr) {
                if (delErr.data?.error !== 'message_not_found') {
                     logger.warn({ ...logContext, ts: thinkingMsg.ts, error: delErr }, 'Failed to delete thinking message for issue analysis.');
                }
            }
        }
    }
}

/**
 * Handles requests to review a GitHub PR using an LLM.
 * Fetches PR details, files, and diff, then uses a specific workspace/prompt for review.
 * @param {string} commandArgs - Arguments containing the PR reference (owner/repo#number).
 * @param {object} context - Context object.
 * @param {string} context.channelId - Slack channel ID.
 * @param {string} context.replyTarget - Slack message timestamp to reply to.
 * @param {object} context.slackWebClient - The initialized Slack WebClient.
 * @param {string} context.userId - Slack user ID.
 * @returns {Promise<void>}
 */
export async function handleGithubPrReview(commandArgs, { channelId, replyTarget, slackWebClient, userId }) {
    const logContext = { channelId, replyTarget, userId, commandArgs };
    logger.info({ ...logContext }, 'Handling GitHub PR review command request');

    if (!githubFeaturesEnabled) {
        logger.warn(logContext, 'GitHub features disabled, ignoring gh-review-pr command.');
        await slackWebClient.chat.postMessage({ channel: channelId, thread_ts: replyTarget, text: 'GitHub features are currently disabled.' });
        return;
    }

    if (!githubPrReviewWorkspaceSlug) {
        logger.warn(logContext, 'GitHub PR review workspace (githubPrReviewWorkspaceSlug) is not configured.');
        await slackWebClient.chat.postMessage({ channel: channelId, thread_ts: replyTarget, text: 'GitHub PR review feature is not configured.' });
        return;
    }

    let thinkingMsg = null;
    try {
        // 1. Post thinking message
        thinkingMsg = await slackWebClient.chat.postMessage({
            channel: channelId,
            thread_ts: replyTarget,
            text: ':robot_face: Initiating PR review protocols... Fetching data...'
        });

        // 2. Parse PR argument (owner/repo#number)
        const prArg = commandArgs.trim();
        // Escape the backslash for the forward slash separator in the regex
        const match = prArg.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
        if (!match) {
            throw new Error('Usage: `gh-review-pr owner/repo#<number>`');
        }
        const [, owner, repo, prNumberStr] = match;
        const prNumber = parseInt(prNumberStr, 10);
        logger.debug({ ...logContext, owner, repo, prNumber }, 'Parsed PR details for review');

        // 3. Fetch PR details (basic info, files, diff)
        const [prDetails, prFiles, prDiff] = await Promise.all([
            getPrDetails(owner, repo, prNumber),
            getPrFiles(owner, repo, prNumber),
            getPrDiff(owner, repo, prNumber)
        ]);

        if (!prDetails) {
            throw new Error(`Could not fetch basic details for PR ${owner}/${repo}#${prNumber}.`);
        }
        // Files and diff are potentially optional for the LLM if fetch fails
        if (!prFiles) logger.warn({ ...logContext }, 'Could not fetch PR file list.');
        if (!prDiff) logger.warn({ ...logContext }, 'Could not fetch PR diff.');

        // 4. Prepare prompt and call LLM (use direct variable)
        // Truncate diff to avoid excessive length/cost
        const MAX_DIFF_LENGTH = 5000; // Configurable?
        const truncatedDiff = prDiff ? (prDiff.length > MAX_DIFF_LENGTH ? prDiff.substring(0, MAX_DIFF_LENGTH) + '\n... (diff truncated) ...' : prDiff) : '(Diff not available)';
        const fileList = prFiles ? prFiles.map(f => `- ${f.filename} (${f.status})`).join('\n') : '(File list not available)';

        let prContent = `PR Title: ${prDetails.title}\n`;
        prContent += `Author: ${prDetails.user} | State: ${prDetails.state}\n`;
        if (prDetails.body) {
             prContent += `Description:\n${prDetails.body}\n\n`;
        }
        prContent += `Files Changed:\\n${fileList}\\n\\n`;
        // Construct diff string without nested template literals
        prContent += 'Diff (potentially truncated):\n```diff\n' + truncatedDiff + '\n```';

        const reviewPrompt = `Perform a brief code review of the following Pull Request based on the provided information. Focus on potential bugs, style issues, and areas for improvement. Provide a concise summary of your findings.\\n\\nPR URL: ${prDetails.url}\\n\\n${prContent}\\n\\nReview Summary:`;

        logger.debug({ ...logContext }, 'Calling LLM for PR review...');
        const reviewResult = await queryLlm(githubPrReviewWorkspaceSlug, null, reviewPrompt);

        if (!reviewResult) {
            throw new Error('The AI assistant did not provide a review for the PR.');
        }

        // 5. Post the review result
        const responseText = `*AI Review for <${prDetails.url}|${owner}/${repo}#${prNumber}>:*\n\n${reviewResult}`;
        const richTextBlock = markdownToRichTextBlock(responseText);

        await slackWebClient.chat.postMessage({
            channel: channelId,
            thread_ts: replyTarget,
            text: responseText,
            blocks: richTextBlock ? [richTextBlock] : undefined
        });

    } catch (error) {
        logger.error({ ...logContext, error }, 'Error handling GitHub PR review command');
        try {
            await slackWebClient.chat.postMessage({
                channel: channelId,
                thread_ts: replyTarget,
                text: `⚠️ Error reviewing GitHub PR: ${error.message}`
            });
        } catch (postError) {
            logger.error({ ...logContext, error: postError }, 'Failed to post error message for PR review command');
        }
    } finally {
        // Delete thinking message
        if (thinkingMsg?.ts) {
            try {
                await slackWebClient.chat.delete({ channel: channelId, ts: thinkingMsg.ts });
            } catch (delErr) {
                if (delErr.data?.error !== 'message_not_found') {
                     logger.warn({ ...logContext, ts: thinkingMsg.ts, error: delErr }, 'Failed to delete thinking message for PR review.');
                }
            }
        }
    }
}
