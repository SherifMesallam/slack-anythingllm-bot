# Orbit

A modular Slack bot designed as an AI assistant to support developers working with **Gravity Forms and its ecosystem**. It leverages AI to answer questions, retrieve relevant information, and perform specific GitHub actions related to Gravity Forms development.

## Features

* **Slack Interaction:** Responds to Direct Messages and @mentions.
* **AI-Powered Assistance:** Provides answers and insights based on its knowledge of Gravity Forms development, documentation, code examples, and best practices within Slack threads.
* **GitHub Integration (Requires `GITHUB_TOKEN`):**
    * **Release Checks:** Fetches the latest release information for configured GitHub repositories (e.g., `@Orbit latest gravityforms release?`).
    * **Issue Analysis:** Summarizes and analyzes GitHub issues from a specified repository (e.g., `@Orbit analyze issue #123 What are the potential causes?`).
    * **Pull Request Review:** Fetches PR details (description, diff, comments) and uses an LLM (via a specified workspace) to provide a code review (e.g., `@Orbit review pr gravityforms/repo#456 #workspace-slug`).
    * **GitHub API Gateway:** Translates natural language requests (prefixed with `github` or containing `#github`) into GitHub API calls using a dedicated LLM workspace (`githubWorkspaceSlug`) and formats the results using another optional LLM workspace (`formatterWorkspaceSlug`).
* **Slack Commands:**
    * `#save`: In a thread, exports the conversation history to a Markdown file, posts it to the thread, and optionally uploads it to a configured AnythingLLM 'conversations' workspace.

## Prerequisites

* **Node.js:** Version 18.x or later recommended.
* **npm** or **yarn:** Package manager for Node.js.
* **Slack:**
    * A Slack workspace.
    * A Slack App created with the necessary permissions (see below).
    * Bot Token (`xoxb-...`), App Token (`xapp-...`), and Signing Secret.
* **AnythingLLM:**
    * A running instance of AnythingLLM.
    * API Key for your AnythingLLM instance.
    * Workspace slugs relevant to your knowledge bases.
* **GitHub (Optional but Required for GitHub Features):**
    * A GitHub account.
    * A Personal Access Token (Classic) with `repo` scope (or finer-grained permissions as needed for API calls, PR reviews, issue reading).
* **Redis (Optional but Recommended for Production):**
    * A running Redis instance (local or cloud).
    * Connection URL.
* **PostgreSQL (Optional but Required for Feedback Storage):**
    * A running PostgreSQL database.
    * Database connection URL.

### Slack App Permissions

Your Slack App will likely need the following Bot Token Scopes:

* `app_mentions:read`
* `chat:write`
* `channels:history`
* `groups:history`
* `im:history`
* `mpim:history`
* `users:read` (potentially, for user info)
* `reactions:write` (if you add reaction-based features)
* `files:write` (for exporting conversations and uploading files)
* `chat:delete` (for the `#delete_last_message` command)

You also need to enable:

* **Socket Mode:** For the `appToken`.
* **Event Subscriptions:** Subscribe to `app_mention` and `message.im` bot events.
* **Interactivity & Shortcuts:** To handle button clicks (feedback). Provide an endpoint URL or configure Socket Mode for interactivity.

## Setup & Installation

1.  **Clone the Repository:**
    ```bash
    git clone <your-repository-url>
    cd <repository-directory>
    ```

2.  **Install Dependencies:**
    ```bash
    npm install
    # or
    yarn install
    ```

3.  **Configure Environment Variables:**
    Create a `.env` file in the root directory of the project and populate it with the necessary values. See the [Configuration](#configuration) section below for details.

    ```dotenv
    # Slack Configuration
    SLACK_SIGNING_SECRET=your_slack_signing_secret
    SLACK_BOT_TOKEN=xoxb-your-slack-bot-token
    SLACK_APP_TOKEN=xapp-your-slack-app-level-token
    SLACK_BOT_USER_ID=UXXXXXXXXXX # The bot's user ID
    SLACK_DEVELOPER_ID=UYYYYYYYYYY # Your user ID (optional, for specific notifications)

    # AnythingLLM Configuration
    ANYTHINGLLM_API_KEY=your_anythingllm_api_key
    ANYTHINGLLM_BASE_URL=http://your-anythingllm-instance:3001 # Base URL of your AnythingLLM API
    # Define workspace mappings if needed (optional, uses 'all'/'fallback' otherwise)
    # WORKSPACE_MAPPING={"channel1":"workspace1","channel2":"workspace2"}
    FALLBACK_WORKSPACE=all # Default workspace if no specific mapping found
    # ENABLE_USER_WORKSPACES=false
    # USER_WORKSPACE_MAPPING={"user1":"user_workspace1"}
    CONVERSATION_EXPORT_WORKSPACE=conversations # Workspace slug for #save uploads

    # GitHub Configuration (Required for GitHub features)
    GITHUB_TOKEN=ghp_your_github_personal_access_token
    GITHUB_WORKSPACE_SLUG=github-api # AnythingLLM workspace trained to generate GitHub API calls
    FORMATTER_WORKSPACE_SLUG=response-formatter # AnythingLLM workspace trained to format GitHub API JSON responses

    # Database Configuration (Required for feedback)
    DATABASE_URL=postgresql://user:password@host:port/database

    # Redis Configuration (Recommended for deduplication)
    REDIS_URL=redis://host:port

    # Bot Behavior Configuration
    MIN_SUBSTANTIVE_RESPONSE_LENGTH=25 # Min length for a response to get feedback buttons
    MAX_SLACK_BLOCK_TEXT_LENGTH=2900 # Max characters per Slack message block

    # Debugging (Optional)
    NODE_ENV=development # Set to 'production' for production
    LOG_LEVEL=debug # Or info, warn, error
    ```

4.  **Database Setup (If using Feedback):**
    Ensure your PostgreSQL database has a table named `feedback`. You can use the following SQL schema as a starting point:

    ```sql
    CREATE TABLE feedback (
        id SERIAL PRIMARY KEY,
        feedback_value VARCHAR(10), -- 'bad', 'ok', 'great'
        user_id VARCHAR(50),
        channel_id VARCHAR(50),
        bot_message_ts VARCHAR(50),
        original_user_message_ts VARCHAR(50),
        action_id VARCHAR(50),
        sphere_slug VARCHAR(100), -- Workspace used for the response
        bot_message_text TEXT,
        original_user_message_text TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
    ```

5.  **Start the Application:**
    ```bash
    npm start
    # or
    yarn start
    ```

## Configuration

Environment variables are used for configuration (loaded from `.env` file using `dotenv`):

* **`SLACK_SIGNING_SECRET` (Required):** Found in your Slack App's "Basic Information" page.
* **`SLACK_BOT_TOKEN` (Required):** Found in your Slack App's "OAuth & Permissions" page (`xoxb-...`).
* **`SLACK_APP_TOKEN` (Required):** Generated in your Slack App's "Basic Information" page under "App-Level Tokens" (`xapp-...`). Needs `connections:write` scope.
* **`SLACK_BOT_USER_ID` (Required):** The User ID of your bot (e.g., `UXXXXXXXXXX`). Find it in the bot's profile or via API.
* **`SLACK_DEVELOPER_ID` (Optional):** Your Slack User ID for potential special handling or notifications.
* **`ANYTHINGLLM_API_KEY` (Required):** API Key generated within your AnythingLLM instance.
* **`ANYTHINGLLM_BASE_URL` (Required):** The base URL for your AnythingLLM instance API (e.g., `http://localhost:3001`).
* **`WORKSPACE_MAPPING` (Optional):** JSON string mapping Slack Channel IDs to AnythingLLM workspace slugs. e.g., `{"C123":"docs", "C456":"dev"}`.
* **`FALLBACK_WORKSPACE` (Optional):** Workspace slug to use if no specific mapping is found. Defaults to `all`.
* **`ENABLE_USER_WORKSPACES` (Optional):** Set to `true` to enable per-user workspace mappings. Defaults to `false`.
* **`USER_WORKSPACE_MAPPING` (Optional):** JSON string mapping Slack User IDs to AnythingLLM workspace slugs if `ENABLE_USER_WORKSPACES` is true.
* **`CONVERSATION_EXPORT_WORKSPACE` (Optional):** The AnythingLLM workspace slug where exported conversations (`#save`) should be uploaded. Defaults to `conversations`.
* **`GITHUB_TOKEN` (Optional):** GitHub Personal Access Token (Classic) required for all GitHub features.
* **`GITHUB_WORKSPACE_SLUG` (Optional):** AnythingLLM workspace slug specifically trained to understand GitHub API requests and generate the necessary JSON parameters for `callGithubApi`. Required for the `github`/`#github` command.
* **`FORMATTER_WORKSPACE_SLUG` (Optional):** AnythingLLM workspace slug trained to take raw JSON GitHub API responses and format them nicely in Markdown for Slack. Used by the `github`/`#github` command.
* **`DATABASE_URL` (Optional):** Connection string for your PostgreSQL database. Required for storing feedback. Example: `postgresql://user:password@host:port/database`.
* **`REDIS_URL` (Optional):** Connection string for your Redis instance. Required for event deduplication. Example: `redis://localhost:6379`.
* **`MIN_SUBSTANTIVE_RESPONSE_LENGTH` (Optional):** Minimum character length for a bot response to be considered "substantive" and receive feedback buttons. Defaults to `25`.
* **`MAX_SLACK_BLOCK_TEXT_LENGTH` (Optional):** Maximum characters allowed in a single Slack text block (used for splitting long messages). Defaults to `2900` (Slack's limit is 3000).
* **`NODE_ENV` (Optional):** Set to `production` or `development`.
* **`LOG_LEVEL` (Optional):** Controls logging verbosity (e.g., `debug`, `info`, `warn`, `error`).

## Usage

1.  **Invite the Bot:** Invite the bot user to any channels you want it to operate in.
2.  **Interact:**
    * **Direct Message (DM):** Send a message directly to the bot app.
    * **Mention:** Mention the bot in a channel it's part of (e.g., `@Orbit what is the status of project X?`).
3.  **Commands & Features:**
    * **General Queries:** Ask questions related to the knowledge in the configured AnythingLLM workspace(s). The bot will automatically use the mapped workspace or the fallback. For new threads, you can specify a workspace: `@Orbit #specific-workspace How do I configure feature Y?`
    * **GitHub Release Check:** Ask for the latest release of supported products (uses abbreviations/repo names configured in the code):
        * `@Orbit latest gravityforms release?`
        * `@Orbit latest stripe addon release?`
        * `@Orbit latest ppcp release?`
    * **GitHub Issue Analysis:** Ask the bot to summarize or analyze a GitHub issue (currently hardcoded to `gravityforms/backlog` but adaptable):
        * `@Orbit summarize issue #123`
        * `@Orbit analyze backlog #456 What are the potential side effects?`
    * **GitHub Pull Request Review:** Ask the bot to review a specific PR (currently hardcoded to `gravityforms/` owner but adaptable):
        * `@Orbit review pr gravityforms/gravityforms#789 #core-dev` (where `#core-dev` is the AnythingLLM workspace slug used for the review analysis).
    * **GitHub API Gateway:** Use natural language to query the GitHub API (requires `GITHUB_WORKSPACE_SLUG`):
        * `@Orbit github list open issues for google/zx tagged bug`
        * `@Orbit show repo details for octokit/rest.js #github`
    * **Export Conversation:** In a thread you want to save, reply with the message `#save`.


## Contributing

Contributions are welcome! Please follow standard Git workflow (fork, branch, pull request). Ensure code includes relevant comments and adheres to existing style. Consider adding tests for new features.

## License

(Specify your license here, e.g., MIT, Apache 2.0, or leave blank if private)
