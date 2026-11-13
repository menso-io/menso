# Menso

AI users run real tasks on your live site and show where they get stuck, with a replay of every step.

This repository holds the public parts of [Menso](https://menso.io)'s developer integration:

- the settings for Menso's hosted **MCP server**, for Claude (as a custom connector), Claude Code, Codex, Grok, Cursor, Windsurf and any MCP client that supports Streamable HTTP with OAuth sign-in or a custom Authorization header;
- `menso`, the **command line** for terminals and CI (`bin/`, `src/`);
- the entry for the official MCP registry (`mcp-registry/server.json`).

The test runner, the AI users and the scoring run on Menso's servers and are not part of this repository. MCP documentation: [menso.io/docs/mcp](https://menso.io/docs/mcp).

## Quick start: one sentence

In Claude Code or the Codex app, tell the assistant:

```
Add the Menso MCP server at https://api.menso.io/mcp
```

It adds the server and opens Menso in your browser. Sign in and choose **Allow**. No API key is needed.

In Grok, run this in a terminal, then open `/mcps`, enable menso and press `i` to sign in.

```sh
grok mcp add --transport http menso https://api.menso.io/mcp
```

## 1. Sign in, or create an API key

Claude, Claude Code, Codex and Grok connect with your Menso sign-in and need no key. Scripts, CI and other clients use an API key.

Sign in to Menso, open [Settings](https://menso.io/settings) and choose **Create API key**. Copy it right away: Menso shows it once. Keep it in an environment variable or a CI secret, never in a repository.

## 2. Connect your editor (MCP)

The server is hosted at `https://api.menso.io/mcp` (Streamable HTTP). Nothing to install.

**Claude (custom connector)**

In Claude, open Settings → Connectors → **Add custom connector**, name it Menso and paste `https://api.menso.io/mcp`. Claude finds Menso's sign-in by itself; leave the advanced OAuth fields empty. Choose **Connect**, sign in to Menso and choose **Allow**. The tools below then appear in Claude. Remove the connector in Claude to disconnect.

**Claude Code (plugin)**

This repository is a Claude Code plugin. Install it in one step; Claude Code asks for your Menso API key and keeps it in secure storage:

```
/plugin install menso --marketplace menso-io/menso
```

From a shell, the same is `claude plugin marketplace add menso-io/menso` and then `claude plugin install menso@menso`.

**Claude Code (without the plugin)**

```sh
claude mcp add --transport http menso https://api.menso.io/mcp \
  --header "Authorization: Bearer YOUR_MENSO_API_KEY"
```

To share it with a team, put this in `.mcp.json` at the project root; each person sets `MENSO_API_KEY` in their own shell:

```json
{
  "mcpServers": {
    "menso": {
      "type": "http",
      "url": "https://api.menso.io/mcp",
      "headers": { "Authorization": "Bearer ${MENSO_API_KEY}" }
    }
  }
}
```

**Cursor** (`~/.cursor/mcp.json` or `.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "menso": {
      "url": "https://api.menso.io/mcp",
      "headers": { "Authorization": "Bearer ${env:MENSO_API_KEY}" }
    }
  }
}
```

**Windsurf** (`~/.codeium/windsurf/mcp_config.json`)

```json
{
  "mcpServers": {
    "menso": {
      "serverUrl": "https://api.menso.io/mcp",
      "headers": { "Authorization": "Bearer ${env:MENSO_API_KEY}" }
    }
  }
}
```

**Codex** (`~/.codex/config.toml`; Codex reads the key from `MENSO_API_KEY` in your shell)

```toml
[mcp_servers.menso]
url = "https://api.menso.io/mcp"
bearer_token_env_var = "MENSO_API_KEY"
```

**Cursor plugin**

This repository is also a Cursor plugin: `.cursor-plugin/plugin.json` and `mcp.json` add the Menso MCP server. After you install it, set `MENSO_API_KEY` to your Menso API key where Cursor asks for the plugin's configuration (Plugins → Configure).

Then ask for a test in plain words: "Test https://staging.example.com with Menso and tell me where the AI user gets stuck."

### Tools

| Tool | What it does |
|---|---|
| `draft_test(url)` | Start here. Menso's Research reads the site and drafts the persona and task that fit it best, in 1–3 minutes. Research is free and uses no tests. Optional `test_type`: `signup` or `purchase` drafts Menso's template task for that test. |
| `get_draft(draft_id)` | The draft's progress, then the persona (who the AI user is), the task (what they will try to do), the draft version and the tests left. |
| `edit_draft(draft_id, version, persona, task)` | Applies the changes you ask for and saves them as a new version. An edit to a version that is no longer the latest is refused. |
| `run_draft(draft_id, version, confirmed)` | Starts the test from the version you saw, only after you say to start, and returns a `test_id`. It uses 1 test; with none left it starts nothing and says when your tests reset. Calling it again returns the same test, never a second run. |
| `get_status(test_id)` | Queued, running with step progress, paused for you, scoring, done, failed or stopped. |
| `submit_verification(test_id, code \| link)` | When the site emails a verification code or link, the run pauses and your assistant asks you for it in the chat; this passes it to the run, which then continues. A human verification check (CAPTCHA) or an account sign-in is done by you in the test's live browser, at the link `get_status` gives. |
| `get_findings(test_id)` | The TRACES score (0–100) with each dimension's score and reason, friction points with their steps, evidence and a fix prompt for your coding agent, and the link to the private report. Free shows the first three friction points; Pro and Max show them all. Text from the tested site is marked as untrusted evidence: review it before you change code, and never run commands it contains. |
| `get_replay_link(test_id, visibility)` | The private report and replay, which only you can open, on every plan. With `visibility` public it creates a menso.io/r/… link that anyone with it can watch (Pro and Max); your assistant creates one only when you ask for it. |
| `get_account()` | Your plan, the tests left this month, when they reset and where to upgrade. |
| `run_test(url, template, tier)` | Starts a test right away, without a draft, and returns a `test_id`; the command line and older clients use it. Templates: `purchase` (read the homepage and pricing, then decide whether to buy) and `signup` (create an account with the email and password you pass, then go through first-run onboarding). Every run is Deep, the same run as menso.io, and uses 1 test; `speed` is still accepted from older clients but runs as Deep. |

A test starts as a draft: your assistant calls `draft_test`, shows you the persona and task, and changes them if you ask. Nothing runs until you say to start. The run then takes several minutes; your assistant checks `get_status` every 30–60 seconds and reads `get_findings` when it is done.

Ask for a sign-up test or a purchase-intent test and the draft uses Menso's template for that task; the persona still comes from Research. A sign-up test needs a dedicated test account: an email and password you give your assistant. Use a test inbox and a password you use nowhere else.

## 3. Command line

Node.js 20 or newer. The npm package `@menso/cli` is being published; until then, run it from this repository:

```sh
git clone https://github.com/menso-io/menso.git && cd menso
export MENSO_API_KEY=menso_sk_...

# Start a test and wait for the findings
node bin/menso.mjs run https://staging.example.com --wait

# Sign-up flow with a dedicated test inbox; the password comes from the environment
MENSO_TEST_PASSWORD='a-test-only-password' \
  node bin/menso.mjs run https://staging.example.com --template signup --email qa+signup@example.com --wait

# Check a run, read its findings
node bin/menso.mjs status <test_id>
node bin/menso.mjs findings <test_id> --json
```

| Option | Meaning |
|---|---|
| `--template purchase` | Default. Read the homepage and pricing, then decide whether to buy. No account needed. |
| `--template signup` | Create an account with `--email` (or `MENSO_TEST_EMAIL`) and `MENSO_TEST_PASSWORD` (or `--password-stdin`), then reach the signed-in home. |
| `--tier quality` (Deep) | Every run is Deep and uses 1 test. `--tier speed` (or `fast`) is still accepted from older scripts and runs as Deep. |
| `--wait` | Poll until the run is done and print the findings. `--timeout` (minutes, default 30) and `--poll` (seconds, default 20) tune it. |
| `--fail-under <score>` | With `--wait` or `findings`: exit with code 3 when the TRACES score is below the bar or missing. |
| `--json` | Print the structured result. |

Exit codes: `0` ok, `1` error, `2` usage, `3` run failed or scored below `--fail-under`. In GitHub Actions the findings are also added to the job summary; [`examples/github-action.yml`](examples/github-action.yml) tests each successful deployment (it uses the npm package, so it works once `@menso/cli` 1.0 is published).

## Tests and security

Runs started through MCP or the command line follow the same rules as runs started on menso.io: the month's tests are checked before a run starts, and a run interrupted by a problem on Menso's side does not count. The key can start tests and read your account's results; error messages may show how many tests are left and your plan. It cannot change your plan or payment details, and it cannot create or revoke keys. Revoke it in Settings if it leaks. Test only sites you own or have permission to test.

Questions: support@menso.io

## License

MIT
