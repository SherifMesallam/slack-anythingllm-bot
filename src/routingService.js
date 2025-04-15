
// src/routingService.js
import { GoogleGenerativeAI } from "@google/generative-ai";
import { routingLlmApiKey, routingLlmModelName } from './config.js';

// --- Initialize Google Generative AI Client ---
let genAI = null;
let geminiModel = null;
if (routingLlmApiKey) {
    try {
        genAI = new GoogleGenerativeAI(routingLlmApiKey);
        geminiModel = genAI.getGenerativeModel({ model: routingLlmModelName });
        console.log(`[Routing Service] Initialized Google AI Client for model: ${routingLlmModelName}`);
    } catch (error) {
        console.error("[Routing Service] Failed to initialize Google AI Client:", error.message);
        genAI = null; // Ensure it's null if init fails
        geminiModel = null;
    }
} else {
    console.warn("[Routing Service] ROUTING_LLM_API_KEY not set. Gemini routing disabled.");
}

const ROUTING_PROMPT = `
You are an intent classification assistant for a Slack bot that interacts with GitHub.
Analyze the user's message below and determine if it's a request to perform one of the following specific GitHub actions.
Respond ONLY with a single, valid JSON object matching the specified structure, and nothing else. Do not add any conversational text before or after the JSON.

Supported GitHub Actions & Keywords:
1.  'fetch_release': Get latest release info. Keywords: "latest release", "version", "tag". Needs repo name.
2.  'review_pr': Review a Pull Request. Keywords: "review pr", "look at pr", "analyze pr". Needs repo name & PR number. May have #workspace slug.
3.  'analyze_issue': Analyze/summarize a GitHub Issue (usually repo 'backlog'). Keywords: "analyze issue", "summarize issue", "explain issue", "check issue". Needs issue number. May have user prompt.
4.  'generic_github_api': A general request for GitHub info/action not matching above. Keywords: "github", "#github", "api call". Contains user prompt.

JSON Output Structure:
{
  "intent": "fetch_release" | "review_pr" | "analyze_issue" | "generic_github_api" | "no_github_action",
  "parameters": {
    "repo": "string | null", // Extracted repo name (e.g., 'gravityforms', 'gravityformsstripe') - DEFAULT TO NULL if not obvious
    "owner": "gravityforms", // Default unless specified otherwise (rare)
    "pr_number": number | null,
    "issue_number": number | null,
    "user_prompt": "string | null", // The core request part of the user's query, essential for 'generic_github_api'
    "target_workspace": "string | null" // Extracted #workspace slug if present
  }
}

Instructions:
- If the message clearly matches a supported action, set "intent" and populate "parameters". Extract repo names, PR/issue numbers (#num), and #workspace slugs. Assume owner 'gravityforms'.
- For 'generic_github_api', capture the main request in "user_prompt".
- If it's a general question, chat, command like '#delete_last_message', or unrelated command, set "intent" to "no_github_action".
- Be precise. Default parameters to null if unsure or not applicable.
- Respond ONLY with the JSON object.

User Message:
>>>
{{USER_QUERY}}
>>>

JSON Response:
`;

/**
 * Uses the configured Google Gemini model to classify the user's intent.
 * @param {string} userQuery - The cleaned user query.
 * @returns {Promise<{intent: string, parameters: object}>} - Object with intent and extracted parameters.
 *          Returns {intent: 'routing_disabled', ...} if API key is missing.
 *          Returns {intent: 'routing_error', ...} on API or parsing failure.
 */
export async function classifyIntentWithGemini(userQuery) {
    if (!geminiModel) {
        console.warn("[Routing Service] Gemini model not available (check API key/config).");
        return { intent: 'routing_disabled', parameters: {} };
    }

    const promptWithQuery = ROUTING_PROMPT.replace('{{USER_QUERY}}', userQuery);

    try {
        console.log(`[Routing Service] Sending intent classification request to Gemini (${routingLlmModelName}).`);
        const result = await geminiModel.generateContent(promptWithQuery);
        const response = result.response;
        const responseText = response.text();

        if (!responseText) {
            throw new Error("Gemini returned an empty response text.");
        }

        // Clean potential markdown code block formatting
        let jsonString = responseText.trim();
        const jsonMatch = jsonString.match(/```json\s*([\s\S]*?)\s*```/);
        if (jsonMatch && jsonMatch[1]) {
            jsonString = jsonMatch[1].trim();
        } else if (jsonString.startsWith('{') && jsonString.endsWith('}')) {
             // Assume it's just the JSON object
             jsonString = jsonString;
        } else {
             console.warn(`[Routing Service] Gemini response might not be pure JSON. Raw: "${responseText}" Attempting parse anyway.`);
             // Attempt to parse even if formatting looks off, might work.
        }

        console.log("[Routing Service] Raw JSON string from Gemini:", jsonString);
        const parsedResult = JSON.parse(jsonString);

        // Basic validation of the parsed structure
        if (!parsedResult.intent || typeof parsedResult.parameters !== 'object' || parsedResult.parameters === null) {
            throw new Error("Parsed JSON from Gemini is missing required 'intent' or 'parameters' fields.");
        }

        console.log("[Routing Service] Classified Intent (Gemini):", parsedResult.intent, "Params:", parsedResult.parameters);
        return parsedResult;

    } catch (error) {
        console.error("[Routing Service] Error during Gemini intent classification:", error);
        // Log more details if available
        if (error.response) { console.error("Gemini API Error Response:", error.response); }
        return { intent: 'routing_error', parameters: { error: error.message } };
    }
}
