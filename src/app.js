import express from 'express';
import axios from 'axios'; // Needed for response_url with Slash Commands
import { WebClient } from '@slack/web-api'; // Import WebClient

// Import configuration
import {
    port,
    signingSecret,
    botToken,
    botUserId,
    githubToken, // Need to check if GH features are enabled
    githubWorkspaceSlug,
    formatterWorkspaceSlug,
    GITHUB_OWNER, // Default owner
    databaseUrl, // Needed for feedback storage check
} from './config.js';
import { validateConfig } from './config.js'; // Ensure validation is imported

// Validate configuration first
validateConfig();

// Import Services & Shutdown Logic
import { shutdownServices, dbPool, storeFeedback } from './services.js'; // Import storeFeedback

// Import Slack Clients & Handlers
import { slackEvents, handleSlackEvent } from './slack.js'; // handleInteraction moved here
import { slack } from './slack.js'; // Import the initialized WebClient

// Import Command Handlers to be called by Slash Command endpoint
import {
    handleReleaseInfoCommand,
    handlePrReviewCommand,
    handleIssueAnalysisCommand,
    handleGithubApiCommand,
} from './handlers/commandHandler.js';
import {
     getAnythingLLMThreadMapping, // Needed for issue analysis context
     storeAnythingLLMThreadMapping, // Needed for issue analysis context
 } from './services.js';
 import {
     createNewAnythingLLMThread, // Needed for issue analysis context
     determineInitialWorkspace // Import the helper from messageHandler
 } from './llm.js'; // Assuming determineInitialWorkspace moved or copied to llm.js
// If determineInitialWorkspace is still in messageHandler.js, adjust import:
// import { determineInitialWorkspace } from './handlers/messageHandler.js';


// --- Express App Setup ---
const app = express();

// --- Middleware ---
// Health Check
app.get('/', (req, res) => {
    res.send(`DeepOrbit (Modular) is live 🛰️`);
});

// Slack Events API Listener (SDK handles verification)
app.use('/slack/events', slackEvents.requestListener());


// --- Interaction Endpoint (Buttons AND Slash Commands) ---
// Needs urlencoded parser
app.post('/slack/interactions', express.urlencoded({ extended: true }), async (req, res) => {

    // TODO: Implement request signature verification here for security!
    // const isValid = verifySlackSignature(req); if (!isValid) return res.status(403).send("Invalid signature");

    // --- Differentiate between Slash Command and Button Click ---
    if (req.body.command) {
        // == Handle Slash Command ==
        const { command, text, user_id, user_name, channel_id, channel_name, response_url, trigger_id } = req.body;
        console.log(`[Slash Command] Received: ${command} ${text} from ${user_name} in ${channel_name}`);

        // 1. Acknowledge Slack within 3 seconds
        res.send(); // Empty 200 OK

        // 2. Process Asynchronously
        let thinkingMessageTs = null;
        let thinkingPromise = null;
        try {
            const initialMsg = await slack.chat.postMessage({ channel: channel_id, text: `:hourglass_flowing_sand: Processing ${command}...` });
            thinkingMessageTs = initialMsg.ts;
            thinkingPromise = Promise.resolve(thinkingMessageTs);

            if (!githubToken) {
                 console.warn("[Slash Command] GitHub command received, but GITHUB_TOKEN is not configured.");
                 await updateOrDeleteThinkingMessage(thinkingPromise, slack, channel_id, { text: `❌ GitHub commands are disabled.` });
                 return;
            }

            let commandHandled = false;
            switch (command) {
                case '/gh-release': { /* ... handle /gh-release ... */
                    const repoIdentifier = text.trim();
                    if (repoIdentifier) { commandHandled = await handleReleaseInfoCommand(repoIdentifier, channel_id, slack, appOctokitInstance, thinkingPromise, channel_id); }
                    else { await updateOrDeleteThinkingMessage(thinkingPromise, slack, channel_id, { text: `❌ Usage: \`/gh-release <repo>\`` }); commandHandled = true; }
                    break;
                }
                case '/gh-review': { /* ... handle /gh-review ... */
                    const reviewPattern = /([\w.-]+)\/([\w.-]+)#(\d+)\s+#([\w-]+)/i; const match = text.trim().match(reviewPattern);
                    if (match) { const [_, owner, repo, pr_number, workspace_slug] = match; commandHandled = await handlePrReviewCommand(owner, repo, parseInt(pr_number), workspace_slug, channel_id, channel_id, slack, appOctokitInstance, thinkingPromise); }
                    else { await updateOrDeleteThinkingMessage(thinkingPromise, slack, channel_id, { text: `❌ Usage: \`/gh-review owner/repo#number #workspace\`` }); commandHandled = true; }
                    break;
                }
                case '/gh-analyze': { /* ... handle /gh-analyze ... */
                    // Pattern: [owner/repo]#num #workspace [prompt]
                    const issuePattern = /(?:([\w.-]+)\/([\w.-]+))?#(\d+)\s+#([\w-]+)(?:\s+(.+))?/i; const match = text.trim().match(issuePattern);
                    if (match) {
                        const [_, owner = GITHUB_OWNER, repo = 'backlog', issue_number, workspace_slug, user_prompt] = match;
                        // Slash commands don't have inherent thread context. Use the provided workspace slug for the LLM.
                        // Pass null for thread slugs to the handler.
                        console.log(`[Slash Command - Analyze] Using workspace '${workspace_slug}' for analysis.`);
                        commandHandled = await handleIssueAnalysisCommand( owner, repo, parseInt(issue_number), user_prompt || null, channel_id, channel_id, slack, appOctokitInstance, thinkingPromise, workspace_slug, null // Use explicit workspace, no thread slug
                        );
                    } else { await updateOrDeleteThinkingMessage(thinkingPromise, slack, channel_id, { text: `❌ Usage: \`/gh-analyze [owner/repo]#number #workspace [prompt]\`` }); commandHandled = true; }
                    break;
                }
                 case '/gh-api': { /* ... handle /gh-api ... */
                    const apiQuery = text.trim();
                    if (apiQuery) { commandHandled = await handleGithubApiCommand(apiQuery, channel_id, channel_id, slack, thinkingPromise, githubWorkspaceSlug, formatterWorkspaceSlug); }
                    else { await updateOrDeleteThinkingMessage(thinkingPromise, slack, channel_id, { text: `❌ Usage: \`/gh-api <your query>\`` }); commandHandled = true; }
                    break;
                }
                default: /* ... handle unknown command ... */
                    console.warn(`[Slash Command] Unknown command: ${command}`);
                    await updateOrDeleteThinkingMessage(thinkingPromise, slack, channel_id, { text: `❓ Unknown command: \`${command}\`.` });
                    commandHandled = true;
            }
            // Fallback cleanup if handler didn't complete as expected
            if (!commandHandled) { await updateOrDeleteThinkingMessage(thinkingPromise, slack, channel_id, null); }

        } catch (error) { /* ... handle unexpected errors, use response_url ... */
             console.error(`[Slash Command] Uncaught error processing ${command}:`, error);
             try { await axios.post(response_url, { replace_original: "false", text: `❌ Error processing ${command}.` }); }
             catch (responseError) { console.error('[Slash Command] Error sending error via response_url:', responseError); await slack.chat.postMessage({ channel: channel_id, text: `❌ Error processing ${command}.` }).catch(()=>{}); }
             if(thinkingPromise) await updateOrDeleteThinkingMessage(thinkingPromise, slack, channel_id, null); // Cleanup thinking message on error
        }

    } else if (req.body.payload) {
        // == Handle Interaction Payload (e.g., button clicks) ==
        console.log("[Interactions] Received interaction payload.");
        try {
            const payload = JSON.parse(req.body.payload);
             if (payload.type === 'block_actions') {
                // Acknowledge interaction quickly
                res.send();
                 console.log("[Interactions] Processing block action asynchronously:", payload.actions[0]?.action_id);
                 // Process feedback button clicks (async)
                 processBlockAction(payload, slack).catch(err => {
                    console.error("[Interactions] Error processing block action:", err);
                 });
             } else if (payload.type === 'view_submission') {
                 // Handle modal submissions if you add them later
                 console.log("[Interactions] Received view submission.");
                 res.send(); // Acknowledge
                 // Process view submission...
             } else {
                 console.log("[Interactions] Received unhandled interaction payload type:", payload.type);
                 res.send(); // Acknowledge other types too
             }
        } catch (e) {
             console.error("[Interactions] Failed to parse interaction payload:", e);
             res.status(400).send('Invalid payload');
        }

    } else {
        console.warn("[Interactions] Received unknown POST to /slack/interactions");
        res.status(400).send("Unknown request type");
    }
});


// --- Helper for Slash Commands & Interactions ---
/**
 * Helper function to safely update or delete the thinking message.
 */
async function updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, updateArgs = null) {
    if (!thinkingMessagePromise) return;
    try {
        const ts = await thinkingMessagePromise;
        if (!ts) { console.warn("[Util] No thinking message TS resolved."); return; }
        if (updateArgs) { await slack.chat.update({ channel, ts, ...updateArgs }); }
        else { await slack.chat.delete({ channel, ts }); }
    } catch (error) { console.warn(`[Util] Failed to ${updateArgs ? 'update' : 'delete'} thinking message:`, error.data?.error || error.message); }
}

// --- Button action processing logic ---
async function processBlockAction(payload, slack) {
     if (!payload.actions?.[0]) return; // No action found

     const action = payload.actions[0];
     const { action_id: actionId, block_id: blockId } = action;
     const { id: userId } = payload.user;
     const { id: channelId } = payload.channel;
     const messageTs = payload.message?.ts;

     if (!messageTs) { console.warn("[Interactions] Missing message TS for block action."); return; }

     // Handle Feedback Buttons
     if (actionId.startsWith('feedback_')) {
         const feedbackValue = action.value;
         let originalQuestionTs = null;
         let responseSphere = null;

         // Extract context from block_id (format: feedback_origTS_sphere)
         if (blockId?.startsWith('feedback_')) {
             const parts = blockId.substring(9).split('_'); // Remove "feedback_"
             originalQuestionTs = parts[0];
             if (parts.length > 1) { responseSphere = parts.slice(1).join('_'); } // Sphere might have underscores
         }
         console.log(`[Interactions] Feedback: User ${userId}, Val ${feedbackValue}, OrigTS ${originalQuestionTs}, Sphere ${responseSphere}`);

         // --- Store Feedback ---
         if (databaseUrl && dbPool) { // Check if DB is configured
             let originalQuestionText = null;
             let actualBotMessageText = payload.message?.text || null; // Use text from the button's message
             if (originalQuestionTs && channelId) { // Fetch original question text
                 try {
                     const historyResult = await slack.conversations.history({ channel: channelId, latest: originalQuestionTs, oldest: originalQuestionTs, inclusive: true, limit: 1 });
                     if (historyResult.ok && historyResult.messages?.[0]?.text) { originalQuestionText = historyResult.messages[0].text; }
                 } catch (e) { console.error('[Interactions] Error fetching original msg text:', e.data?.error); }
             }
             try {
                 await storeFeedback({
                     feedback_value: feedbackValue, user_id: userId, channel_id: channelId,
                     bot_message_ts: messageTs, original_user_message_ts: originalQuestionTs || null,
                     action_id: actionId, sphere_slug: responseSphere || null,
                     bot_message_text: actualBotMessageText,
                     original_user_message_text: originalQuestionText
                 });
                 console.log(`[Interactions] Feedback stored in DB.`);
             } catch(dbError) {
                  console.error(`[Interactions] Error storing feedback in DB:`, dbError);
             }
         } else {
              console.log(`[Interactions] Feedback (DB Disabled): User:${userId}, Val:${feedbackValue}, Sphere:${responseSphere}, OrigTS:${originalQuestionTs}, BotTS:${messageTs}`);
         }
         // --- End Store Feedback ---

         // --- Update UI ---
         try {
             const originalBlocks = payload.message?.blocks;
             if (originalBlocks?.length > 0) {
                 const actionBlockIndex = originalBlocks.findIndex(b => b.type === 'actions' && b.block_id === blockId);
                 const thanksText = `🙏 Thanks! (_${feedbackValue === 'bad' ? '👎' : feedbackValue === 'ok' ? '👌' : '👍'}_)`;
                 const contextBlock = { type: "context", elements: [ { type: "mrkdwn", text: thanksText } ] };
                 let updatedBlocks;
                 if (actionBlockIndex !== -1) { updatedBlocks = [ ...originalBlocks.slice(0, actionBlockIndex), contextBlock, ...originalBlocks.slice(actionBlockIndex + 1) ]; }
                 else { updatedBlocks = [...originalBlocks, contextBlock]; } // Append if action block not found
                 await slack.chat.update({ channel: channelId, ts: messageTs, text: (payload.message.text || '') + `\n${thanksText}`, blocks: updatedBlocks });
                 console.log(`[Interactions] Updated feedback message ${messageTs}.`);
             }
         } catch (updateError) { console.warn("[Interactions] Failed update feedback message:", updateError.data?.error); }
         // --- End Update UI ---
     }
     // Add handlers for other block actions if needed
}


// --- Start Server ---
const server = app.listen(port, () => {
    console.log(`🚀 DeepOrbit (Modular) running on port ${port}`);
});

// --- Graceful Shutdown Handler ---
async function gracefulShutdown(signal) { /* ... Same shutdown logic ... */
    console.log(`${signal} received. Shutting down gracefully...`);
    server.close(async () => {
        console.log('HTTP server closed.');
        await shutdownServices(signal);
        console.log('Cleanup finished. Exiting.');
        process.exit(0);
    });
    setTimeout(() => { console.error('Timeout forcing shutdown.'); process.exit(1); }, 10000);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// --- Attach Main Event Listener ---
// Pass slack and appOctokitInstance to the handler
slackEvents.on('message', (event, body) => handleSlackEvent(event, body, slack, appOctokitInstance));
slackEvents.on('app_mention', (event, body) => handleSlackEvent(event, body, slack, appOctokitInstance));
slackEvents.on('error', (error) => { console.error('[SlackEvents Adapter Error]', error.name, error.code || '', error.message); });

// --- Global Octokit Instance ---
let appOctokitInstance = null;
if (githubToken) {
    try {
        const { Octokit } = await import('@octokit/rest');
        appOctokitInstance = new Octokit({ auth: githubToken });
        console.log("[App] Octokit initialized.");
    } catch (error) { console.error("[App] Failed to initialize Octokit:", error); }
} else { console.warn("[App] Octokit not initialized (GITHUB_TOKEN not set)."); }

console.log("Event listeners and interaction endpoint configured.");
