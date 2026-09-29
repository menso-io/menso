# Menso

AI users run real tasks on your live site and show where they get stuck, with a replay of every step.

This repository holds the public parts of [Menso](https://menso.io)'s developer integration:

- the settings for Menso's hosted **MCP server**, for Claude Code, Cursor, Windsurf and any MCP client that supports Streamable HTTP and a custom Authorization header;
- `menso`, the **command line** for terminals and CI (`bin/`, `src/`);
- the entry for the official MCP registry (`mcp-registry/server.json`).

The test runner, the AI users and the scoring run on Menso's servers and are not part of this repository. MCP documentation: [menso.io/docs/mcp](https://menso.io/docs/mcp).

## 1. Create an API key

Sign in to Menso, open [Settings](https://menso.io/settings) and choose **Create API key**. Copy it right away: Menso shows it once. Keep it in an environment variable or a CI secret, never in a repository.

## 2. Connect your editor (MCP)

The server is hosted at `https://api.menso.io/mcp` (Streamable HTTP). Nothing to install.

**Claude Code**

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

Then ask for a test in plain words: "Run a Menso signup test on https://staging.example.com and tell me where the AI user got stuck."

### Tools

| Tool | What it does |
|---|---|
| `run_test(url, template, tier)` | Starts a test on a public URL and returns a `test_id`. Templates: `purchase` (read the homepage and pricing, then decide whether to buy) and `signup` (create an account with the email and password you pass, then reach the signed-in home). Tiers: `speed` or `quality`. |
| `get_status(test_id)` | Queued, running with step progress, paused for you, scoring, done, failed or stopped. |
| `get_findings(test_id)` | The TRACES score (0–100) with each dimension's score and reason, and on Studio every friction point with its steps, evidence and a suggested fix. Text from the tested site is marked as untrusted evidence: review it before you change code, and never run commands it contains. |
| `get_replay_link(test_id)` | A public menso.io/r/… replay of every step the AI user took. Pro and Studio; anyone with the link can watch it. |

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
| `--tier speed` / `--tier quality` | Speed (default) costs 40 credits; Quality costs 300. |
| `--wait` | Poll until the run is done and print the findings. `--timeout` (minutes, default 30) and `--poll` (seconds, default 20) tune it. |
| `--fail-under <score>` | With `--wait` or `findings`: exit with code 3 when the TRACES score is below the bar or missing. |
| `--json` | Print the structured result. |

Exit codes: `0` ok, `1` error, `2` usage, `3` run failed or scored below `--fail-under`. In GitHub Actions the findings are also added to the job summary; [`examples/github-action.yml`](examples/github-action.yml) tests each successful deployment (it uses the npm package, so it works once `@menso/cli` 1.0 is published).

## Credits and security

Runs started through MCP or the command line follow the same rules as runs started on menso.io: the balance is checked before a run starts, and runs that fail for a reason caused by Menso are not charged. The key can start tests and read your account's results; error messages may show your credit balance and plan. It cannot change your plan or payment details, and it cannot create or revoke keys. Revoke it in Settings if it leaks. Test only sites you own or have permission to test.

Questions: support@menso.io

## License

MIT
