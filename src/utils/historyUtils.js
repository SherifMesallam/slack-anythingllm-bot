import logger from '../logger.js';
import { botUserId } from '../config.js';

const HISTORY_LIMIT = 10; // Max history messages to fetch (excluding bot's own messages)

/**
 * Fetches recent conversation history from Slack, either from a thread or channel/DM.
 * Filters out messages from the bot itself.
 * Formats the history into a simple string for context.
 * @param {object} params
 * @param {string} params.channel - The channel ID.
 * @param {string|null} params.threadTs - The thread timestamp (fetches thread replies if present).
 * @param {string} params.originalTs - Timestamp of the message triggering the fetch (used for channel history lookup).
 * @param {boolean} params.isDM - True if the channel is a Direct Message.
 * @param {object} params.slackWebClient - The initialized Slack WebClient.
 * @returns {Promise<string>} - Formatted conversation history string, or empty string if none found/error.
 */
export async function fetchConversationHistory({ channel, threadTs, originalTs, isDM, slackWebClient }) {
  let historyResult;
  const context = { channel, threadTs, originalTs, isDM };

  try {
    if (!isDM && threadTs) {
      logger.debug(context, 'Fetching thread replies for history');
      historyResult = await slackWebClient.conversations.replies({
        channel: channel,
        ts: threadTs,
        // Fetch +1 to ensure we have enough after potential filtering
        limit: HISTORY_LIMIT + 5, // Increased limit slightly for more robust filtering
      });
    } else {
      logger.debug(context, 'Fetching channel/DM history');
      historyResult = await slackWebClient.conversations.history({
        channel: channel,
        latest: originalTs,
        limit: HISTORY_LIMIT + 5, // Fetch more to account for filtering
        inclusive: false // Don't include the triggering message itself
      });
    }

    if (historyResult.ok && historyResult.messages) {
      // Filter out messages from the bot and messages without text,
      // then take the most recent ones up to the limit.
      const relevantMessages = historyResult.messages
        .filter(msg =>
          msg.user &&
          msg.text &&
          msg.user !== botUserId &&
          msg.subtype !== 'channel_join' && // Filter out join messages etc.
          msg.subtype !== 'channel_leave'
        )
        .slice(0, HISTORY_LIMIT) // Limit after filtering non-user messages
        .reverse(); // Order from oldest to newest for the context string

      if (relevantMessages.length > 0) {
        let history = "Conversation History:\n";
        relevantMessages.forEach(msg => {
          // Simple formatting, could be enhanced
          history += `User ${msg.user}: ${msg.text.replace(/\n/g, ' ')}\n`;
        });
        logger.debug({ ...context, count: relevantMessages.length }, 'Fetched relevant conversation history');
        return history.trim();
      } else {
        logger.debug(context, 'No relevant prior messages found in history fetch.');
      }
    } else {
      logger.warn({ ...context, error: historyResult.error }, 'Failed to fetch Slack conversation history');
    }
  } catch (error) {
    logger.error({ ...context, error }, 'Error during fetchConversationHistory');
  }
  return ""; // Return empty string if no history or error
} 