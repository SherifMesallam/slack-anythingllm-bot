// index.js
// Refactored version using modular handlers

import express from 'express';
import crypto from 'crypto'; // Import crypto for signature verification
// import { createEventAdapter } from '@slack/events-api'; // We might create this manually or use Bolt
import { WebClient } from '@slack/web-api';
import logger from './logger.js'; // Use our structured logger

// Import configuration
import {
    port,
    signingSecret,
    botToken,
    // botUserId, // Will be fetched via auth.test
    // anythingLLMBaseUrl, // Config related to specific services, keep there
    // anythingLLMApiKey,
    // redisUrl,
    // databaseUrl,
    // MAX_SLACK_BLOCK_TEXT_LENGTH,
    // RESET_CONVERSATION_COMMAND,
    // RESET_HISTORY_REDIS_PREFIX,
    // RESET_HISTORY_TTL,
    // WORKSPACE_LIST_CACHE_KEY,
    // WORKSPACE_LIST_CACHE_TTL,
    // DUPLICATE_EVENT_REDIS_PREFIX,
    // DUPLICATE_EVENT_TTL,
    validateConfig // Keep validation
} from './config.js';

// Validate essential configuration for startup
validateConfig();

// Import Services & Shutdown Logic
// Services initialize themselves upon import (Redis, DB, GitHub)
import {
    shutdownServices,
    // dbPool, // Not directly used in app.js
    redisClient,
    isRedisReady
} from './services.js';

// Import the duplicate checker
import { isDuplicateRedis } from './utils.js';

// --- Initialize Slack Clients ---
if (!signingSecret || !botToken) {
    logger.error("Missing critical Slack environment variables (SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN)");
    process.exit(1);
}

const slackClient = new WebClient(botToken);
// We will handle event verification manually or use Bolt later if needed.
// const slackEvents = createEventAdapter(signingSecret);

let botInfo = {};
try {
    logger.info('Testing Slack auth and fetching bot info...');
    botInfo = await slackClient.auth.test();
    if (!botInfo.ok) throw new Error(botInfo.error);
    logger.info(`Slack auth successful. Bot User ID: ${botInfo.user_id}, Bot ID: ${botInfo.bot_id}`);
    // We should export botUserId from config.js, but fetching it here is also good validation.
    // If config.botUserId exists, verify it matches botInfo.user_id
} catch (error) {
    logger.error({ error }, 'Slack auth test failed. Check bot token and permissions.');
    process.exit(1);
}

// Import New Handlers AFTER client initialization
import { routeMessageEvent } from './slack/messageRouter.js';
import { handleInteraction } from './slack/interactionHandler.js';

// --- Signature Verification Helper ---
/**
 * Verifies the Slack request signature.
 * @param {string} secret - The Slack Signing Secret.
 * @param {string} timestamp - The X-Slack-Request-Timestamp header.
 * @param {string} requestBody - The raw request body string.
 * @param {string} signatureHeader - The X-Slack-Signature header.
 * @returns {boolean} - True if the signature is valid and recent, false otherwise.
 */
function verifySlackSignature(secret, timestamp, requestBody, signatureHeader) {
    const now = Math.floor(Date.now() / 1000);

    // Check if timestamp is too old (e.g., > 5 minutes)
    if (Math.abs(now - parseInt(timestamp, 10)) > 300) {
        logger.warn({ timestamp, now }, 'Slack timestamp too old, possible replay attack');
        return false;
    }

    const sigBasestring = `v0:${timestamp}:${requestBody}`;
    const calculatedSignature = 'v0=' + crypto
        .createHmac('sha256', secret)
        .update(sigBasestring, 'utf8')
        .digest('hex');

    // Use timing-safe comparison
    try {
      return crypto.timingSafeEqual(Buffer.from(calculatedSignature, 'utf8'), Buffer.from(signatureHeader, 'utf8'));
    } catch (error) {
      // Handles errors like mismatched buffer lengths
      logger.warn({ error: error.message }, 'Error during timingSafeEqual comparison for Slack signature');
      return false;
    }
}

// --- Express App Setup ---
const app = express();

// --- Global Raw Body Capture Middleware ---
// Use express.raw globally, but use verify to conditionally assign the raw body
// based on route and content type for signature verification purposes.
app.use(express.raw({
    type: '*/*', // Apply to all content types initially
    limit: '10mb',
    verify: (req, res, buf, encoding) => {
        logger.debug({ url: req.originalUrl, contentType: req.headers['content-type'] }, 'Global express.raw verify running');
        if (buf && buf.length) {
            if (req.originalUrl === '/slack/events' && req.headers['content-type'] === 'application/json') {
                req.rawBody = buf; // Assign raw buffer for events
                logger.debug('Attached req.rawBody for /slack/events');
            } else if (req.originalUrl === '/slack/interactions' && req.headers['content-type'] === 'application/x-www-form-urlencoded') {
                req.rawBodyString = buf.toString(encoding || 'utf8'); // Assign raw string for interactions
                logger.debug('Attached req.rawBodyString for /slack/interactions');
            } else {
                 logger.debug('Global express.raw verify ignored (route/type mismatch)');
            }
        } else {
             logger.warn('Global express.raw verify received empty buffer');
        }
    }
}));

// --- Slack Event Handling ---
// Checks req.rawBody (assigned by global middleware's verify function)
app.post('/slack/events', async (req, res, next) => {
    // Added logging: Log entry and headers
    logger.info({
        method: req.method,
        url: req.originalUrl,
        headers: {
            'content-type': req.headers['content-type'],
            'x-slack-request-timestamp': req.headers['x-slack-request-timestamp'],
            'x-slack-signature': req.headers['x-slack-signature']
        }
    }, 'Entering /slack/events middleware');

    const timestamp = req.headers['x-slack-request-timestamp'];
    const signature = req.headers['x-slack-signature'];

    // Added logging: Check rawBody before verification
    logger.debug({ hasRawBody: !!req.rawBody, rawBodyType: typeof req.rawBody, rawBodyLength: req.rawBody?.length }, 'Checking req.rawBody before event signature verification');
    if (!req.rawBody) {
        logger.error('req.rawBody missing for /slack/events. Global verify function failed?'); // Updated error
        return res.status(500).send('Internal Server Error');
    }
    const rawBodyString = req.rawBody.toString(); // Use the captured rawBody

    if (!timestamp || !signature) {
        logger.warn('Missing Slack timestamp or signature headers');
        return res.status(400).send('Missing signature headers');
    }

    // Verify the signature
    const isVerified = verifySlackSignature(signingSecret, timestamp, rawBodyString, signature);
    // const isVerified = true; // Placeholder REMOVED

    if (!isVerified) {
        logger.warn('Slack signature verification failed!');
        return res.status(403).send('Signature verification failed');
    }

    // Signature is verified, parse body and proceed
    // Attach parsed body for subsequent middleware/handlers
    let parsedBody;
    try {
        parsedBody = JSON.parse(rawBodyString);
        req.body = parsedBody; // Attach parsed body
    } catch (parseError) {
        logger.error({ error: parseError }, 'Failed to parse verified Slack event payload');
        return res.status(400).send('Invalid JSON payload');
    }

    // --- Check for Duplicate Event --- START
    const eventId = parsedBody.event_id;
    if (eventId) {
        if (isRedisReady) { // Only check if Redis is ready
            try {
                const isDup = await isDuplicateRedis(eventId);
                if (isDup) {
                    logger.warn({ eventId }, 'Duplicate event detected, skipping processing.');
                    // Send 200 OK to Slack, but don't proceed further
                    return res.status(200).send();
                }
            } catch (redisError) {
                logger.error({ eventId, error: redisError }, 'Error checking for duplicate event in Redis. Processing anyway.');
                // Fail open: proceed with processing if Redis check fails
            }
        } else {
            logger.warn({ eventId }, 'Redis not ready, skipping duplicate event check.');
        }
    } else {
        // Not all incoming payloads on this endpoint might have an event_id (e.g., url_verification)
        logger.debug('No event_id found in payload, skipping duplicate check.');
    }
    // --- Check for Duplicate Event --- END

    // Handle URL verification challenge
    if (req.body.type === 'url_verification') {
        logger.info('Responding to Slack URL verification challenge');
        return res.status(200).send(req.body.challenge);
    }

    // Send immediate 200 OK to Slack for events to prevent timeouts
    res.status(200).send();

    // Pass control to the actual event processing
    next();
}, async (req, res) => {
    // Now process the verified event (req.body is already parsed)
    const eventPayload = req.body;

    // Check if it's an event callback with an actual event
    if (eventPayload.type === 'event_callback' && eventPayload.event) {
        const event = eventPayload.event;
        logger.debug({ eventType: event.type, eventId: eventPayload.event_id }, 'Processing event callback');

        // Route message-related events
        // Listen to message events in channels, groups, DMs, and mentions
        if (event.type === 'message' || event.type === 'app_mention') {
           // Don't await this - let it run in the background after ack
           routeMessageEvent(event, slackClient)
             .catch(err => logger.error({ error: err, eventId: eventPayload.event_id }, 'Error in routeMessageEvent handler'));
        }
         else {
             logger.debug({ eventType: event.type }, 'Ignoring event type');
         }
    } else {
        logger.warn({ payloadType: eventPayload.type }, 'Received non-event_callback payload on events endpoint');
    }
});


// --- Interaction Endpoint ---
// Checks req.rawBodyString (assigned by global middleware's verify function)
// Then, uses express.urlencoded *after* verification to parse the body.
app.post('/slack/interactions', async (req, res, next) => { // Add next for middleware

    // Added logging: Log entry and headers for interactions
    logger.info({
        method: req.method,
        url: req.originalUrl,
        headers: {
            'content-type': req.headers['content-type'],
            'x-slack-request-timestamp': req.headers['x-slack-request-timestamp'],
            'x-slack-signature': req.headers['x-slack-signature']
        }
    }, 'Entering /slack/interactions handler');

    // --- Verify Signature --- Start
    const timestamp = req.headers['x-slack-request-timestamp'];
    const signature = req.headers['x-slack-signature'];

    if (!timestamp || !signature) {
        logger.warn('Interaction request missing Slack timestamp or signature headers');
        return res.status(400).send('Missing signature headers');
    }

    // Added logging: Check rawBodyString before verification
    logger.debug({ hasRawBodyString: !!req.rawBodyString, rawBodyStringType: typeof req.rawBodyString, rawBodyStringLength: req.rawBodyString?.length }, 'Checking req.rawBodyString before interaction signature verification');
    if (!req.rawBodyString) {
        logger.error('Raw body string missing from interaction request. Global verify function failed?'); // Updated error
        return res.status(500).send('Internal Server Error');
    }

    const isVerified = verifySlackSignature(signingSecret, timestamp, req.rawBodyString, signature);

    if (!isVerified) {
       logger.warn('Interaction signature verification failed!');
       return res.status(403).send('Signature verification failed');
    }
    // --- Verify Signature --- End

    // Signature is verified, NOW parse the urlencoded body to access payload
    // Pass control to the next middleware which is the urlencoded parser
    next();

}, express.urlencoded({ extended: true, limit: '10mb' }), async (req, res) => {
    // This middleware runs AFTER verification AND urlencoded parsing

    // Process the payload (which is now parsed into req.body by the previous middleware)
    let payload;
    try {
        // The payload is nested within the parsed body
        if (!req.body || !req.body.payload) {
             logger.error({ bodyKeys: req.body ? Object.keys(req.body) : null }, 'req.body or req.body.payload missing after urlencoded parsing in interaction handler');
             return res.status(400).send('Invalid interaction payload format');
        }
        payload = JSON.parse(req.body.payload);
    } catch (parseError) {
        logger.error({ error: parseError, body: req.body }, 'Failed to parse interaction payload JSON');
        return res.status(400).send('Invalid interaction payload format');
    }

    logger.debug({ type: payload.type, user: payload.user?.id, actionId: payload.actions?.[0]?.action_id }, 'Received verified interaction payload');

    // Acknowledge interaction immediately (conditionally)
    // For commands, ack might be handled within the handler after posting initial response
    // For buttons/menus, ack here is usually fine.
    if (payload.type !== 'slash_command') { // Example condition
        if (!res.headersSent) { // Check if ack wasn't already sent
            res.status(200).send();
        }
    }

    // Handle the interaction asynchronously
    handleInteraction(payload, slackClient)
       .then(() => {
           // If we didn't ack earlier (e.g., for commands), do it now if needed/possible
           if (payload.type === 'slash_command' && !res.headersSent) {
              res.status(200).send(); // Or send response specific to command
           }
       })
      .catch(err => {
          logger.error({ error: err, payloadType: payload.type }, 'Error in handleInteraction handler');
          // Try to send an error message back if possible and not already acked
          if (!res.headersSent) {
            res.status(500).send('Sorry, something went wrong.');
          }
       });
});

// --- Basic Health Check Route ---
app.get('/', (req, res) => {
    // const redisStatus = redisUrl ? (isRedisReady ? 'Ready' : 'Not Ready/Error') : 'Not Configured'; // isRedisReady might need direct access
    const healthStatus = {
        status: 'OK',
        slackAuth: botInfo.ok ? 'OK' : 'Error',
        // redisStatus: redisStatus, // Add check if needed
        timestamp: new Date().toISOString()
    };
    res.json(healthStatus);
});

// --- Start Server ---
const server = app.listen(port, () => {
    logger.info(`🚀 App running on port ${port}`);
    logger.info(`🕒 Current Time: ${new Date().toLocaleString('en-US', { timeZone: 'Africa/Cairo' })} (Cairo Time)`); // Example timezone
});

// --- Graceful Shutdown Handler ---
async function gracefulShutdown(signal) {
    logger.info(`${signal} received. Shutting down gracefully...`);
    server.close(async () => {
        logger.info('HTTP server closed.');
        await shutdownServices(signal); // Close Redis/DB connections
        logger.info('Cleanup finished. Exiting.');
        process.exit(0);
    });

    // Force shutdown after timeout
    setTimeout(() => {
        logger.error('Could not close connections gracefully after timeout, forcing shutdown.');
        process.exit(1);
    }, 10000); // 10 seconds timeout
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

logger.info("Application setup complete. Listening for events and interactions...");