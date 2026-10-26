# pi-multi-accounts

A [Pi](https://github.com/earendil-works/pi) extension for people with more than one subscription:

- **Claude**: keep **multiple Claude Pro/Max OAuth accounts** for Pi's built-in `/login` and switch between them with a single `/account` command. Pi stores exactly one `anthropic` credential; this extension saves additional logins next to it and swaps the active one on demand.
- **Codex**: use extra **ChatGPT (Codex) logins as parallel providers** (`openai-codex-<name>`) next to Pi's built-in `openai-codex`. Use `/account` to select a provider for this session, or pick its model with `/model`.

## Install

```bash
# local checkout
pi install /absolute/path/to/pi-multi-accounts

# or from git
pi install git:github.com/<user>/pi-multi-accounts
```

Then run `/reload` (or restart Pi).

### Migrating from the standalone extensions / the old package

- Remove `~/.pi/agent/extensions/codex-accounts.ts` and `~/.pi/agent/extensions/claude-accounts.ts` if present. Otherwise the commands and providers are registered twice.
- Remove old `pi-claude-accounts` package entries from your Pi settings.
- `~/.pi/agent/claude-accounts.json` is kept: your saved Claude accounts continue to work.

## Usage

| Command                       | What it does                                        |
| ----------------------------- | --------------------------------------------------- |
| `/account login`              | Ask which account type, then run the matching login below |
| `/account login claude <name>`| Log in to a Claude Pro/Max account in the browser and save it as `<name>` |
| `/account login codex <name>` | Import `~/.codex-<name>` (a Codex CLI login) as provider `openai-codex-<name>` |
| `/account`                    | Pick a Claude account or a registered Codex provider |
| `/account <name/id>`          | Use an exact saved Claude name or registered Codex provider ID |
| `/account save <name>`        | Save the current built-in Anthropic `/login` under `<name>` |
| `/account list`               | List Claude accounts (● active, ○ inactive) and Codex providers (login state) |
| `/account usage`              | Show subscription usage (5h / weekly limits, reset times) of every logged-in account |
| `/account remove <name>`      | Forget a saved Claude account (`auth.json` is not changed) |
| `/account help`               | Show command help                                   |

Use `/account login` instead of Pi's built-in `/login` for this extension's accounts. It explains every step in the session, saves the Claude login under a name, and registers new Codex homes without `/reload`. The built-in `/login` still works; adopt its Claude login with `/account save <name>`.

Save and remove work on **Claude accounts only**. Their arguments are literal Claude names, not provider qualifiers. `login` and `usage` are reserved names: a Claude account saved under one of them by an older version stays reachable with `/account use <name>` or `/account claude:<name>`.

Claude selection changes shared credentials. It does not change the session model. Codex selection changes only this session's model. It does not change Claude credentials or the default model for new sessions.

Use an unqualified name or ID when it matches exactly one provider. If a saved Claude name equals a registered Codex ID, use `/account claude:<name>` or `/account codex:<provider-id>`. Existing Claude names such as `openai-codex-team` remain valid. The picker identifies each provider and does not need qualifiers.

`/account use` and `/account switch` without a target open the same picker. Prefix completions include the aliases, saved names, registered Codex IDs, and qualified targets. Completions for `remove` and `rm` include only literal Claude names.

Aliases: `add` = `save`, `ls` = `list`, `rm` = `remove`, `use`/`switch` = switch.

The footer shows `claude: <name>` for the active saved account, or `claude: unsaved login` when the login in `auth.json` is not saved yet.

## Logging in to Claude accounts

1. `/account login claude work`. Pi prints a claude.ai login URL and waits; it does not open the browser itself. Sign in, and the login is saved as `work`. If the browser cannot reach `localhost`, paste the final redirect URL or code into the prompt.
2. `/account login claude personal` for the second account. claude.ai reuses the browser's signed-in session, so the URL in a normal window gives you `work` again. Instead, either:
   - open the URL in a **private/incognito window**, or
   - use a **different browser profile**, or
   - **sign out of claude.ai** first.

   If the browser still returns an account that is already saved, the command reports it and saves nothing. This check uses the Anthropic profile lookup; when that lookup fails, compare the emails with `/account list`.
3. A login is activated at once when `auth.json` has no Claude login or holds the same account. Otherwise you are asked whether to switch, because a switch affects every running Pi session.
4. Run `/account list` and check that the emails differ.

## Codex accounts

1. For each extra ChatGPT account, log in with the Codex CLI into its own folder: `CODEX_HOME=~/.codex-<name> codex login`. For a second account, finish that login in a private window, or sign out of chatgpt.com first.
2. In Pi, run `/account login codex <name>`. This imports the tokens from `~/.codex-<name>/auth.json`; no browser is involved. A folder created after Pi started is registered on the spot. Without `<name>`, the command lists the found homes. If the folder has no login yet, it prints the exact `codex login` command. (The built-in `/login` → **"OpenAI Codex (<name>)"** does the same import for already registered homes.)
3. Select the provider with `/account openai-codex-<name>`, or use the unified `/account` picker. `/account login codex` also offers to switch right away. The command keeps the current model ID if the target provider supports it. Otherwise, it asks you to choose a target model. Cancel leaves the session unchanged. Without dialog support, choose explicitly with `/model`, e.g. `openai-codex-<name>/<model>`.

The provider has the same models as the built-in `openai-codex`. The command reports success only after Pi accepts the model change. `/account list` shows each provider's auth path, login state, and current-session active marker.

The Codex auth file stays the source of truth: on refresh the extension first adopts newer tokens found in the file (e.g. refreshed by the Codex CLI); otherwise it refreshes with the file's refresh token and writes the rotated tokens back. `~/.codex-*` folders are discovered at load time; later ones are added by `/account login codex <name>` or `/reload`.

## Usage limits

`/account usage` checks the subscription quota of every logged-in account at once:

```text
Claude accounts:
[Claude] ● personal <me@example.com>
    5h  ██░░░░░░░░  20%  resets in 4h 49m
    7d  █░░░░░░░░░  10%  resets in 6d 16h
[Claude] ○ work <me@work.example>
    5h  ████░░░░░░  40%  resets in 29m
    7d  ░░░░░░░░░░   1%  resets in 6d 22h

Codex providers:
[Codex] ● openai-codex-team (plus)
    5h  █░░░░░░░░░   7%  resets in 3h 2m
    7d  ███░░░░░░░  31%  resets in 5d 1h
```

- Claude: every saved account plus an unsaved login in `auth.json`. Model-scoped weekly caps and enabled extra usage are listed when Anthropic reports them.
- Codex: the built-in `openai-codex` login and every logged-in `openai-codex-<name>` provider, with the plan type.
- Active logins get their token from Pi, which refreshes it under its own lock. An expired token of an inactive Claude account is refreshed by the extension and the rotated token is saved in `claude-accounts.json` at once.
- An account that fails (expired login, HTTP 401/429) shows its error inline; the others are still listed.

## How it works (Claude)

- Pi keeps a single `anthropic` entry in `~/.pi/agent/auth.json`. Switching replaces that entry and leaves other providers untouched.
- Saved logins live in `~/.pi/agent/claude-accounts.json` (mode `0600`).
- Writes happen under the same `auth.json.lock` directory lock that Pi's `proper-lockfile` uses, so Pi and the extension never write at the same time.
- Refresh tokens rotate. When Pi refreshes the active token, the extension copies the new one back into the right slot on `session_start`, after each `agent_end`, and during every switch.
- To tell whose token is whose, it asks `https://api.anthropic.com/api/oauth/profile` for the account id/email. If that lookup fails, it falls back gracefully (matching on the refresh token, or asking you when ownership is unclear).

## Caveats

- `auth.json` is shared: a Claude switch affects **every running Pi session**. A Codex switch changes only the current session model.
- It relies on Pi internals (the `auth.json` format and its lock directory). Tested with Pi 0.99.2.
- The Anthropic profile and usage endpoints (`/api/oauth/profile`, `/api/oauth/usage`) are unofficial and may change.
- The OpenAI token endpoint, client id and usage endpoint (`chatgpt.com/backend-api/wham/usage`) used for Codex are unofficial and may change.
- The Claude usage endpoint is rate limited; running `/account usage` in quick succession can return HTTP 429 for a few minutes.
- The Codex CLI and Pi share each Codex refresh token (single use); if both refresh at once, one of them may need `codex login` and `/login` again.
- `claude-accounts.json` contains refresh tokens. Keep it private and never commit it.

## Development

```bash
npm install
npm run check   # typecheck + tests
```

Layout:

```text
src/index.ts                  entry point: shares one registered Codex-home snapshot
src/accounts.ts               /account command, typed entries, exact resolution and completions
src/claude.ts                 Claude credentials, status, validation and lifecycle sync
src/codex.ts                  Codex parallel providers and session-model selection
src/usage.ts                  Claude/Codex usage endpoints, parsing and formatting for /account usage
test/account.test.mjs         node:test suite for /account (temp PI_CODING_AGENT_DIR and HOME, no network)
test/codex.test.mjs           node:test suite for the Codex providers (stubbed fetch, no network)
test/usage.test.mjs           node:test suite for usage parsing and formatting
```

## License

MIT
