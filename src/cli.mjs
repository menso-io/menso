import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";

import { DEFAULT_ENDPOINT, McpClient, McpError } from "./mcp-client.mjs";

const require = createRequire(import.meta.url);
export const VERSION = require("../package.json").version;

export const EXIT = { ok: 0, error: 1, usage: 2, gate: 3 };

const HELP = `menso ${VERSION}: AI users run real tasks on your live site and show where they get stuck,
with a replay of every step. https://menso.io/docs/mcp

Usage:
  menso run <url> [--template purchase|signup] [--tier speed|quality] [--wait]
  menso status <test_id>
  menso findings <test_id>

Options:
  --template <id>      purchase (default): read the homepage and pricing, decide whether to buy.
                       signup: create an account and reach the signed-in home (needs --email
                       and a password).
  --tier <tier>        speed (default, 40 credits) or quality (300 credits).
  --email <address>    signup: email for the new test account (or MENSO_TEST_EMAIL).
  --password-stdin     signup: read the test account's password from stdin
                       (default: MENSO_TEST_PASSWORD).
  --wait               run: wait for the run to finish and print its findings.
  --timeout <minutes>  run --wait: give up after this long (default 30).
  --poll <seconds>     run --wait: seconds between status checks (default 20).
  --fail-under <score> run --wait, findings: exit 3 when the TRACES score is below <score>.
  --json               print the structured result as JSON.
  -h, --help           show this help.
  -v, --version        show the version.

Environment:
  MENSO_API_KEY        required; create it at https://menso.io/settings
  MENSO_MCP_URL        server address (default ${DEFAULT_ENDPOINT})

Runs spend Menso credits exactly like runs started on menso.io.
Exit codes: 0 ok, 1 error, 2 usage, 3 run failed or scored below --fail-under.
`;

const OPTIONS = {
  template: { type: "string" },
  tier: { type: "string" },
  email: { type: "string" },
  "password-stdin": { type: "boolean" },
  wait: { type: "boolean" },
  timeout: { type: "string" },
  poll: { type: "string" },
  "fail-under": { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
};

class UsageError extends Error {}

// The key travels in the Authorization header, so only send it over HTTPS
// (plain HTTP only to this machine, for local testing).
function checkedEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError(`MENSO_MCP_URL is not a valid URL: ${value}`);
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new UsageError("MENSO_MCP_URL must use https");
  }
  return url.href;
}

// Server text quotes the tested website. In CI, GitHub Actions reads a line
// that starts with "::" as a workflow command, and the legacy "##[command]"
// form anywhere in a line, so a page could forge annotations, groups or
// stop-commands through a finding. Every server string passes through here
// before it reaches stdout, stderr or the job summary.
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g;

export function safeText(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_CHARS, " ")
    .split("\n")
    .map((line) => line.replace(/^(\s*):(?=:)/, "$1:\u200b").replace(/#(?=#\[)/g, "#\u200b"))
    .join("\n");
}

/**
 * --json output for the same logs. JSON already escapes newlines, so no line
 * can start with "::"; "##[" can still sit inside a string. Writing its "#"
 * as the escape \u0023 keeps the parsed value identical for scripts.
 */
export function safeJson(value) {
  return JSON.stringify(value ?? {}, null, 2).replace(/#(?=#\[)/g, "\\u0023");
}

export function htmlEscape(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** A job-summary block that page text cannot break out of. */
function summaryBlock(title, text) {
  return `## ${htmlEscape(title)}\n\n<pre>${htmlEscape(safeText(text))}</pre>`;
}

function textOf(result) {
  return safeText(
    (result?.content ?? [])
      .filter((block) => block?.type === "text")
      .map((block) => block.text)
      .join("\n"),
  );
}

function positiveNumber(value, name, fallback) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new UsageError(`${name} must be a positive number`);
  return number;
}

function scoreThreshold(value) {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 100) {
    throw new UsageError("--fail-under must be a number from 0 to 100");
  }
  return number;
}

async function readStdin(stdin) {
  let data = "";
  for await (const chunk of stdin) data += chunk;
  return data.replace(/\r?\n$/, "");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function callWithRetry(client, name, args, { attempts = 3, delayMs = 2000, sleepFn = sleep } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await client.callTool(name, args);
    } catch (error) {
      if (!(error instanceof McpError) || !error.retryable || attempt >= attempts) throw error;
      await sleepFn(delayMs * attempt);
    }
  }
}

function writeStepSummary(env, markdown) {
  const path = env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  try {
    appendFileSync(path, `${markdown}\n`);
  } catch {
    // A summary is a convenience; never fail the run over it.
  }
}

function belowThreshold(structured, threshold) {
  if (threshold === undefined) return false;
  const total = structured?.traces?.total;
  return typeof total !== "number" || total < threshold;
}

/**
 * Run the CLI. Returns the exit code. `io` carries env, stdout, stderr,
 * stdin and (for tests) fetchImpl and sleep.
 */
export async function main(argv, io) {
  const { env, stdout, stderr } = io;
  const out = (text) => stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  const err = (text) => stderr.write(text.endsWith("\n") ? text : `${text}\n`);

  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    err(`menso: ${error.message}\n\n${HELP}`);
    return EXIT.usage;
  }
  const { values, positionals } = parsed;
  if (values.version) {
    out(VERSION);
    return EXIT.ok;
  }
  const [command, target, ...extra] = positionals;
  if (values.help || !command || command === "help") {
    out(HELP);
    return command || values.help ? EXIT.ok : EXIT.usage;
  }

  try {
    if (!["run", "status", "findings"].includes(command)) throw new UsageError(`unknown command "${command}"`);
    if (!target) throw new UsageError(command === "run" ? "run needs a URL" : `${command} needs a test_id`);
    if (extra.length) throw new UsageError(`unexpected argument "${extra[0]}"`);
    const apiKey = env.MENSO_API_KEY;
    if (!apiKey) {
      throw new UsageError("set MENSO_API_KEY (create a key at https://menso.io/settings)");
    }
    const threshold = scoreThreshold(values["fail-under"]);
    const client = new McpClient({
      endpoint: checkedEndpoint(env.MENSO_MCP_URL || DEFAULT_ENDPOINT),
      apiKey,
      clientVersion: VERSION,
      fetchImpl: io.fetchImpl ?? globalThis.fetch,
    });
    const retry = { sleepFn: io.sleep ?? sleep };

    if (command === "status") {
      const result = await callWithRetry(client, "get_status", { test_id: target }, retry);
      if (result.isError) {
        err(textOf(result));
        return EXIT.error;
      }
      out(values.json ? safeJson(result.structuredContent) : textOf(result));
      return EXIT.ok;
    }

    if (command === "findings") {
      const result = await callWithRetry(client, "get_findings", { test_id: target }, retry);
      if (result.isError) {
        err(textOf(result));
        return EXIT.error;
      }
      out(values.json ? safeJson(result.structuredContent) : textOf(result));
      if (belowThreshold(result.structuredContent, threshold)) {
        err(`TRACES score is below --fail-under ${threshold}.`);
        return EXIT.gate;
      }
      return EXIT.ok;
    }

    // run
    const template = values.template ?? "purchase";
    const tier = values.tier ?? "speed";
    if (!["purchase", "signup"].includes(template)) throw new UsageError("--template must be purchase or signup");
    if (!["speed", "quality"].includes(tier)) throw new UsageError("--tier must be speed or quality");
    if (threshold !== undefined && !values.wait) throw new UsageError("--fail-under needs --wait");
    const args = { url: target, template, tier };
    if (template === "signup") {
      const email = values.email || env.MENSO_TEST_EMAIL;
      const password = values["password-stdin"] ? await readStdin(io.stdin) : env.MENSO_TEST_PASSWORD;
      if (!email || !password) {
        throw new UsageError(
          "the signup template needs --email (or MENSO_TEST_EMAIL) and a password in MENSO_TEST_PASSWORD or --password-stdin",
        );
      }
      args.email = email;
      args.password = password;
    }
    const pollMs = positiveNumber(values.poll, "--poll", 20) * 1000;
    const timeoutMs = positiveNumber(values.timeout, "--timeout", 30) * 60_000;

    // Starting a run spends credits: never retry it automatically.
    const started = await client.callTool("run_test", args);
    if (started.isError) {
      err(textOf(started));
      return EXIT.error;
    }
    const testId = started.structuredContent?.test_id;
    if (!values.wait) {
      out(values.json ? safeJson(started.structuredContent) : textOf(started));
      return EXIT.ok;
    }
    err(textOf(started));
    if (!testId) {
      err("The server did not return a test_id.");
      return EXIT.error;
    }

    const sleepFn = io.sleep ?? sleep;
    const now = io.now ?? (() => Date.now());
    const deadline = now() + timeoutMs;
    let lastLine = "";
    let status;
    for (;;) {
      await sleepFn(pollMs);
      status = await callWithRetry(client, "get_status", { test_id: testId }, retry);
      if (status.isError) {
        err(textOf(status));
        return EXIT.error;
      }
      const state = status.structuredContent?.state;
      const line = textOf(status);
      if (line !== lastLine) {
        err(line);
        lastLine = line;
      }
      if (state === "done" || state === "failed" || state === "stopped") break;
      if (now() >= deadline) {
        err(`Stopped waiting after ${values.timeout ?? 30} minutes; the run continues. Check it with: menso status ${testId}`);
        return EXIT.error;
      }
    }

    const state = status.structuredContent?.state;
    if (state !== "done") {
      writeStepSummary(env, summaryBlock(`Menso test ${testId}`, textOf(status)));
      return EXIT.gate;
    }
    const findings = await callWithRetry(client, "get_findings", { test_id: testId }, retry);
    if (findings.isError) {
      err(textOf(findings));
      return EXIT.error;
    }
    const findingsText = textOf(findings);
    out(values.json ? safeJson(findings.structuredContent) : findingsText);
    writeStepSummary(env, summaryBlock(`Menso test ${testId}`, findingsText));
    if (belowThreshold(findings.structuredContent, threshold)) {
      err(`TRACES score is below --fail-under ${threshold}.`);
      return EXIT.gate;
    }
    return EXIT.ok;
  } catch (error) {
    if (error instanceof UsageError) {
      err(`menso: ${error.message}\nRun "menso --help" for usage.`);
      return EXIT.usage;
    }
    if (error instanceof McpError) {
      err(`menso: ${safeText(error.message)}`);
      return EXIT.error;
    }
    throw error;
  }
}
