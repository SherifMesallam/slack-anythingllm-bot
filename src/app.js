
// index.js - Main Application Entry Point

import express from 'express';
import axios from 'axios'; // Needed for response_url with Slash Commands
import { WebClient } from '@slack/web-api'; // Import WebClient

// Import configuration
import {
    port, signingSecret, botToken, botUserId, githubToken,
    githubWorkspaceSlug, formatterWorkspaceSlug, GITHUB_OWNER, databaseUrl,
} from './config.js';
import { validateConfig } from './config.js';

// Validate configuration first
validateConfig();

// Import Services & Shutdown Logic
import { shutdownServices, dbPool, getAnythingLLMThreadMapping, storeAnythingLLMThreadMapping } from './services.js'; // Import DB helpers

// Import Slack Clients & Handlers
import { slackEvents, handleSlackEvent } from './slack.js'; // handleInteraction moved here
import { slack } from './slack.js'; // Import the initialized WebClient

// Import Command Handlers
import {
    handleReleaseInfoCommand, handlePrReviewCommand, handleIssueAnalysisCommand, handleGithubApiCommand,
} from './handlers/commandHandler.js';

// Import LLM helpers (including workspace logic)
import { createNewAnythingLLMThread, determineInitialWorkspace } from './llm.js'; // Import workspace helper

// --- Express App Setup ---
const app = express();

// --- Middleware ---
app.get('/', (req, res) => res.send(`DeepOrbit (Modular) is live 🛰️`)); // Health Check
app.use('/slack/events', slackEvents.requestListener()); // Events API Listener

// --- Interaction Endpoint (Buttons AND Slash Commands) ---
app.post('/slack/interactions', express.urlencoded({ extended: true }), async (req, res) => {
    // TODO: Implement request signature verification
    // if (!verifySlackSignature(req)) return res.status(403).send("Invalid signature");

    if (req.body.command) { // == Handle Slash Command ==
        const { command, text, user_id, user_name, channel_id, response_url } = req.body;
        console.log(`[Slash Command] Received: ${command} ${text} from ${user_name}`);
        res.send(); // Acknowledge immediately

        let thinkingMessageTs = null;
        let thinkingPromise = null;
        try {
            const initialMsg = await slack.chat.postMessage({ channel: channel_id, text: `:hourglass_flowing_sand: Processing ${command}...` });
            thinkingMessageTs = initialMsg.ts;
            thinkingPromise = Promise.resolve(thinkingMessageTs);

            if (!githubToken) { await updateOrDeleteThinkingMessage(thinkingPromise, slack, channel_id, { text: `❌ GitHub commands disabled.` }); return; }

            let commandHandled = false;
            switch (command) {
                case '/gh-release': { /* ... handle /gh-release ... */
                    const repoIdentifier = text.trim();
                    if (repoIdentifier) { commandHandled = await handleReleaseInfoCommand(repoIdentifier, channel_id, slack, appOctokitInstance, thinkingPromise, channel_id); }
                    else { await updateOrDeleteThinkingMessage(thinkingPromise, slack, channel_id, { text: `❌ Usage: \`/gh-release <repo>\`` }); commandHandled = true; }
                    break;
                }
                case '/gh-review': { /* ... handle /gh-review ... */
                    const match = text.trim().match(/([\w.-]+)\/([\w.-]+)#(\d+)\s+#([\w-]+)/i);
                    if (match) { const [_, owner, repo, pr_number, workspace_slug] = match; commandHandled = await handlePrReviewCommand(owner, repo, parseInt(pr_number), workspace_slug, channel_id, channel_id, slack, appOctokitInstance, thinkingPromise); }
                    else { await updateOrDeleteThinkingMessage(thinkingPromise, slack, channel_id, { text: `❌ Usage: \`/gh-review owner/repo#number #workspace\`` }); commandHandled = true; }
                    break;
                }
                case '/gh-analyze': { /* ... handle /gh-analyze ... */
                    const match = text.trim().match(/(?:([\w.-]+)\/([\w.-]+))?#(\d+)\s+#([\w-]+)(?:\s+(.+))?/i);
                    if (match) { const [_, owner = GITHUB_OWNER, repo = 'backlog', issue_number, workspace_slug, user_prompt] = match; console.log(`[Slash Command - Analyze] Using workspace '${workspace_slug}' for analysis.`); commandHandled = await handleIssueAnalysisCommand( owner, repo, parseInt(issue_number), user_prompt || null, channel_id, channel_id, slack, appOctokitInstance, thinkingPromise, workspace_slug, null ); } // Pass workspace_slug, null thread
                    else { await updateOrDeleteThinkingMessage(thinkingPromise, slack, channel_id, { text: `❌ Usage: \`/gh-analyze [owner/repo]#number #workspace [prompt]\`` }); commandHandled = true; }
                    break;
                }
                 case '/gh-api': { /* ... handle /gh-api ... */
                    const apiQuery = text.trim();
                    if (apiQuery) { commandHandled = await handleGithubApiCommand(apiQuery, channel_id, channel_id, slack, thinkingPromise, githubWorkspaceSlug, formatterWorkspaceSlug); }
                    else { await updateOrDeleteThinkingMessage(thinkingPromise, slack, channel_id, { text: `❌ Usage: \`/gh-api <your query>\`` }); commandHandled = true; }
                    break;
                }
                default: /* ... handle unknown command ... */
                    console.warn(`[Slash Command] Unknown command: ${command}`); await updateOrDeleteThinkingMessage(thinkingPromise, slack, channel_id, { text: `❓ Unknown command: \`${command}\`.` }); commandHandled = true;
            }
            if (!commandHandled) { await updateOrDeleteThinkingMessage(thinkingPromise, slack, channel_id, null); } // Fallback cleanup

        } catch (error) { /* ... handle errors, use response_url ... */
             console.error(`[Slash Command] Uncaught error processing ${command}:`, error);
             try { await axios.post(response_url, { replace_original: "false", text: `❌ Error processing ${command}.` }); }
             catch (responseError) { console.error('[Slash Command] Error sending error via response_url:', responseError); await slack.chat.postMessage({ channel: channel_id, text: `❌ Error processing ${command}.` }).catch(()=>{}); }
             if(thinkingPromise) await updateOrDeleteThinkingMessage(thinkingPromise, slack, channel_id, null);
        }

    } else if (req.body.payload) { // == Handle Interaction Payload ==
        console.log("[Interactions] Received interaction payload.");
        try {
            const payload = JSON.parse(req.body.payload);
             if (payload.type === 'block_actions') { res.send(); console.log("[Interactions] Processing block action async:", payload.actions[0]?.action_id); processBlockAction(payload, slack).catch(err => { console.error("[Interactions] Error processing block action:", err); }); }
             else if (payload.type === 'view_submission') { console.log("[Interactions] Received view submission."); res.send(); /* Process view */ }
             else { console.log("[Interactions] Unhandled interaction type:", payload.type); res.send(); }
        } catch (e) { console.error("[Interactions] Failed parse payload:", e); res.status(400).send('Invalid payload'); }
    } else { console.warn("[Interactions] Unknown POST"); res.status(400).send("Unknown request"); }
});

// --- Helper: Update/Delete Thinking Message ---
async function updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, updateArgs = null) { /* ... Same as in commandHandler ... */
    if (!thinkingMessagePromise) return; try { const ts = await thinkingMessagePromise; if (!ts) { console.warn("[Util] No thinking TS."); return; } if (updateArgs) { await slack.chat.update({ channel, ts, ...updateArgs }); } else { await slack.chat.delete({ channel, ts }); } } catch (error) { console.warn(`[Util] Failed ${updateArgs ? 'update' : 'delete'} thinking msg:`, error.data?.error); }
}

// --- Helper: Process Block Actions (Feedback Buttons) ---
async function processBlockAction(payload, slack) { /* ... Same full implementation as previous response ... */
    if (!payload.actions?.[0]) return; const action = payload.actions[0]; const { action_id: actionId, block_id: blockId } = action; const { id: userId } = payload.user; const { id: channelId } = payload.channel; const messageTs = payload.message?.ts; if (!messageTs) { console.warn("[Interactions] Missing message TS."); return; }
    if (actionId.startsWith('feedback_')) {
        const feedbackValue = action.value; let originalQuestionTs = null; let responseSphere = null; if (blockId?.startsWith('feedback_')) { const parts = blockId.substring(9).split('_'); originalQuestionTs = parts[0]; if (parts.length > 1) { responseSphere = parts.slice(1).join('_'); } } console.log(`[Interactions] Feedback: User ${userId}, Val ${feedbackValue}, OrigTS ${originalQuestionTs}, Sphere ${responseSphere}`);
        if (databaseUrl && dbPool) { let originalQuestionText = null; let actualBotMessageText = payload.message?.text || null; if (originalQuestionTs && channelId) { try { const h = await slack.conversations.history({ channel: channelId, latest: originalQuestionTs, oldest: originalQuestionTs, inclusive: true, limit: 1 }); if (h.ok && h.messages?.[0]?.text) { originalQuestionText = h.messages[0].text; } } catch (e) { console.error('[Interactions] Error fetch original msg text:', e.data?.error); } } try { await storeFeedback({ feedback_value: feedbackValue, user_id: userId, channel_id: channelId, bot_message_ts: messageTs, original_user_message_ts: originalQuestionTs || null, action_id: actionId, sphere_slug: responseSphere || null, bot_message_text: actualBotMessageText, original_user_message_text: originalQuestionText }); console.log(`[Interactions] Feedback stored in DB.`); } catch(dbError) { console.error(`[Interactions] Error storing feedback DB:`, dbError); } } else { console.log(`[Interactions] Feedback (DB Disabled): User:${userId}, Val:${feedbackValue}, Sphere:${responseSphere}, TS:${messageTs}`); }
        try { const originalBlocks = payload.message?.blocks; if (originalBlocks?.length > 0) { const idx = originalBlocks.findIndex(b => b.type === 'actions' && b.block_id === blockId); const thanks = `🙏 Thanks! (_${feedbackValue === 'bad' ? '👎' : feedbackValue === 'ok' ? '👌' : '👍'}_)`; const ctx = { type: "context", elements: [ { type: "mrkdwn", text: thanks } ] }; let updatedBlocks; if (idx !== -1) { updatedBlocks = [ ...originalBlocks.slice(0, idx), ctx, ...originalBlocks.slice(idx + 1) ]; } else { updatedBlocks = [...originalBlocks, ctx]; } await slack.chat.update({ channel: channelId, ts: messageTs, text: (payload.message.text || '') + `\n${thanks}`, blocks: updatedBlocks }); console.log(`[Interactions] Updated feedback msg ${messageTs}.`); } } catch (updateError) { console.warn("[Interactions] Failed update feedback msg:", updateError.data?.error); }
    }
}

// --- Start Server & Shutdown ---
const server = app.listen(port, () => { console.log(`🚀 DeepOrbit running on port ${port}`); });
async function gracefulShutdown(signal) { /* ... Same shutdown logic ... */
    console.log(`${signal} received. Shutting down...`); server.close(async () => { console.log('HTTP server closed.'); await shutdownServices(signal); console.log('Cleanup finished. Exiting.'); process.exit(0); }); setTimeout(() => { console.error('Timeout forcing shutdown.'); process.exit(1); }, 10000);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM')); process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// --- Attach Event Listeners ---
slackEvents.on('message', (event, body) => handleSlackEvent(event, body, slack, appOctokitInstance));
slackEvents.on('app_mention', (event, body) => handleSlackEvent(event, body, slack, appOctokitInstance));
slackEvents.on('error', (error) => { console.error('[SlackEvents Error]', error.name, error.code || '', error.message); });

// --- Global Octokit Instance ---
let appOctokitInstance = null;
if (githubToken) { try { const { Octokit } = await import('@octokit/rest'); appOctokitInstance = new Octokit({ auth: githubToken }); console.log("[App] Octokit initialized."); } catch (error) { console.error("[App] Failed init Octokit:", error); } } else { console.warn("[App] Octokit not initialized (GITHUB_TOKEN missing)."); }

console.log("Event listeners and interaction endpoint configured.");
async function storeFeedback(feedbackData) {
    if (!databaseUrl || !dbPool) {
        console.warn("DATABASE_URL not configured, logging feedback to console only.");
        console.log("--- FEEDBACK (Console Log) ---", JSON.stringify(feedbackData, null, 2));
        return;
    }
    const insertQuery = `
        INSERT INTO feedback (feedback_value, user_id, channel_id, bot_message_ts, original_user_message_ts, action_id, sphere_slug, bot_message_text, original_user_message_text)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id;`;
    const values = [
        feedbackData.feedback_value || null, feedbackData.user_id || null,
        feedbackData.channel_id || null, feedbackData.bot_message_ts || null,
        feedbackData.original_user_message_ts || null, feedbackData.action_id || null,
        feedbackData.sphere_slug || null, feedbackData.bot_message_text || null,
        feedbackData.original_user_message_text || null
    ];
    let client;
    try {
        client = await dbPool.connect();
        console.log(`[Slack Service/Feedback] Inserting: User=${values[1]}, Val=${values[0]}, Sphere=${values[6]}`);
        const result = await client.query(insertQuery, values);
        if (result.rows?.[0]?.id) {
             console.log(`[Slack Service/Feedback] Saved ID: ${result.rows[0].id}`);
        } else {
             console.warn('[Slack Service/Feedback] Insert OK, no ID.');
        }
    } catch (err) {
        console.error('[Slack Service/Feedback DB Error]', err);
    } finally {
        if (client) client.release();
    }
}
