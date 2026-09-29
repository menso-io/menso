import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { EXIT, htmlEscape, main, safeJson, safeText, VERSION } from "../src/cli.mjs";
import { PROTOCOL_VERSION } from "../src/mcp-client.mjs";

const KEY = "menso_sk_" + "k".repeat(40);

function sink() {
  const chunks = [];
  return { write: (text) => chunks.push(String(text)), text: () => chunks.join("") };
}

function text(value, structured, isError = false) {
  return {
    content: [{ type: "text", text: value }],
    ...(structured ? { structuredContent: structured } : {}),
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * A fake Menso MCP endpoint. It checks every request the way the real server
 * does for protocol 2026-07-28, then answers from `handlers[toolName]`.
 */
function fakeServer(handlers) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const headers = new Headers(init.headers);
    const body = JSON.parse(init.body);
    assert.equal(init.method, "POST");
    assert.equal(headers.get("authorization"), `Bearer ${KEY}`);
    assert.equal(headers.get("mcp-protocol-version"), PROTOCOL_VERSION);
    assert.equal(headers.get("mcp-method"), body.method);
    assert.equal(headers.get("mcp-name"), body.params.name);
    assert.match(headers.get("accept"), /application\/json/);
    assert.match(headers.get("accept"), /text\/event-stream/);
    assert.equal(body.params._meta["io.modelcontextprotocol/protocolVersion"], PROTOCOL_VERSION);
    assert.deepEqual(body.params._meta["io.modelcontextprotocol/clientCapabilities"], {});
    calls.push({ url, name: body.params.name, args: body.params.arguments });
    const handler = handlers[body.params.name];
    const outcome = typeof handler === "function" ? handler(body.params.arguments, calls) : handler;
    if (outcome instanceof Response) return outcome;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { resultType: "complete", ...outcome } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetchImpl, calls };
}

async function run(argv, { handlers = {}, env = {}, stdin = "", fetchImpl } = {}) {
  const stdout = sink();
  const stderr = sink();
  const server = fakeServer(handlers);
  const code = await main(argv, {
    env: { MENSO_API_KEY: KEY, ...env },
    stdout,
    stderr,
    stdin: Readable.from([stdin]),
    fetchImpl: fetchImpl ?? server.fetchImpl,
    sleep: async () => {},
  });
  return { code, stdout: stdout.text(), stderr: stderr.text(), calls: server.calls };
}

const TRACES = { total: 72.5, dimensions: [] };

test("run starts a purchase test and prints the start message", async () => {
  const result = await run(["run", "example.com"], {
    handlers: { run_test: text("Started Menso test abc on https://example.com", { test_id: "a".repeat(32), state: "running" }) },
  });
  assert.equal(result.code, EXIT.ok);
  assert.deepEqual(result.calls[0].args, { url: "example.com", template: "purchase", tier: "speed" });
  assert.match(result.stdout, /Started Menso test/);
});

test("run --json prints the structured result for scripts", async () => {
  const result = await run(["run", "https://example.com", "--tier", "quality", "--json"], {
    handlers: { run_test: text("Started", { test_id: "b".repeat(32), state: "queued", queue_position: 2 }) },
  });
  assert.equal(result.code, EXIT.ok);
  assert.deepEqual(JSON.parse(result.stdout), { test_id: "b".repeat(32), state: "queued", queue_position: 2 });
  assert.equal(result.calls[0].args.tier, "quality");
});

test("run --wait polls until done, prints findings and writes the GitHub summary", async () => {
  const summaryDir = mkdtempSync(join(tmpdir(), "menso-cli-"));
  const summary = join(summaryDir, "summary.md");
  const states = ["running", "running", "scoring", "done"];
  const result = await run(["run", "example.com", "--wait", "--fail-under", "60"], {
    env: { GITHUB_STEP_SUMMARY: summary },
    handlers: {
      run_test: text("Started", { test_id: "c".repeat(32), state: "running" }),
      get_status: () => {
        const state = states.shift();
        return text(`state ${state}`, { test_id: "c".repeat(32), state, findings_ready: state === "done" });
      },
      get_findings: text("TRACES 72.5/100", { test_id: "c".repeat(32), traces: TRACES, friction_points_included: false }),
    },
  });
  assert.equal(result.code, EXIT.ok);
  assert.equal(result.stdout.trim(), "TRACES 72.5/100");
  assert.equal(result.calls.filter((call) => call.name === "get_status").length, 4);
  assert.equal(result.stderr.match(/state running/g).length, 1, "unchanged status lines print once");
  assert.match(readFileSync(summary, "utf8"), /## Menso test c{32}[\s\S]*TRACES 72.5\/100/);
});

test("--fail-under exits 3 when the score is below the bar or missing", async () => {
  const handlers = (traces) => ({
    run_test: text("Started", { test_id: "d".repeat(32), state: "running" }),
    get_status: text("done", { test_id: "d".repeat(32), state: "done", findings_ready: true }),
    get_findings: text("findings", { test_id: "d".repeat(32), traces, friction_points_included: false }),
  });
  assert.equal((await run(["run", "example.com", "--wait", "--fail-under", "80"], { handlers: handlers(TRACES) })).code, EXIT.gate);
  assert.equal((await run(["run", "example.com", "--wait", "--fail-under", "70"], { handlers: handlers(TRACES) })).code, EXIT.ok);
  assert.equal((await run(["run", "example.com", "--wait", "--fail-under", "10"], { handlers: handlers(null) })).code, EXIT.gate);
  assert.equal((await run(["findings", "d".repeat(32), "--fail-under", "80"], { handlers: handlers(TRACES) })).code, EXIT.gate);
});

test("a run that ends without findings exits 3", async () => {
  const result = await run(["run", "example.com", "--wait"], {
    handlers: {
      run_test: text("Started", { test_id: "e".repeat(32), state: "running" }),
      get_status: text("ended without findings", { test_id: "e".repeat(32), state: "failed", findings_ready: false }),
    },
  });
  assert.equal(result.code, EXIT.gate);
  assert.equal(result.calls.some((call) => call.name === "get_findings"), false);
});

test("signup reads the password from the environment or stdin, never from argv", async () => {
  const handlers = { run_test: text("Started", { test_id: "f".repeat(32), state: "running" }) };
  const fromEnv = await run(["run", "example.com", "--template", "signup", "--email", "qa@example.com"], {
    env: { MENSO_TEST_PASSWORD: "env-secret" },
    handlers,
  });
  assert.equal(fromEnv.code, EXIT.ok);
  assert.deepEqual(fromEnv.calls[0].args, {
    url: "example.com",
    template: "signup",
    tier: "speed",
    email: "qa@example.com",
    password: "env-secret",
  });
  const fromStdin = await run(["run", "example.com", "--template", "signup", "--password-stdin"], {
    env: { MENSO_TEST_EMAIL: "qa2@example.com" },
    stdin: "stdin-secret\n",
    handlers,
  });
  assert.equal(fromStdin.calls[0].args.password, "stdin-secret");
  assert.equal(fromStdin.calls[0].args.email, "qa2@example.com");
  const missing = await run(["run", "example.com", "--template", "signup", "--email", "qa@example.com"], { handlers });
  assert.equal(missing.code, EXIT.usage);
  assert.equal(missing.calls.length, 0);
  const rejected = await run(["run", "example.com", "--password", "x"], { handlers });
  assert.equal(rejected.code, EXIT.usage, "there is no --password flag");
});

test("tool errors go to stderr with exit 1", async () => {
  const result = await run(["run", "example.com"], {
    handlers: { run_test: text("Not enough Menso credits: this run needs 40 and the balance is 39.", null, true) },
  });
  assert.equal(result.code, EXIT.error);
  assert.match(result.stderr, /needs 40 and the balance is 39/);
  assert.equal(result.stdout, "");
});

test("starting a run is never retried, but status polling is", async () => {
  const flaky = await run(["run", "example.com"], {
    handlers: { run_test: () => new Response("upstream", { status: 502 }) },
  });
  assert.equal(flaky.code, EXIT.error);
  assert.equal(flaky.calls.length, 1);

  let attempts = 0;
  const status = await run(["status", "a".repeat(32)], {
    handlers: {
      get_status: () => {
        attempts += 1;
        return attempts < 3 ? new Response("busy", { status: 503 }) : text("running", { test_id: "a".repeat(32), state: "running" });
      },
    },
  });
  assert.equal(status.code, EXIT.ok);
  assert.equal(attempts, 3);
});

test("usage errors and help", async () => {
  assert.equal((await run([])).code, EXIT.usage);
  assert.equal((await run(["--help"])).code, EXIT.ok);
  assert.equal((await run(["--version"])).stdout.trim(), VERSION);
  assert.equal((await run(["deploy", "x"])).code, EXIT.usage);
  assert.equal((await run(["run"])).code, EXIT.usage);
  assert.equal((await run(["run", "example.com", "--template", "checkout"])).code, EXIT.usage);
  assert.equal((await run(["run", "example.com", "--fail-under", "50"])).code, EXIT.usage);
  const noKey = await main(["status", "a".repeat(32)], {
    env: {},
    stdout: sink(),
    stderr: sink(),
    stdin: Readable.from([""]),
    fetchImpl: () => assert.fail("no request without a key"),
  });
  assert.equal(noKey, EXIT.usage);
});

test("the key is read only from MENSO_API_KEY and only sent over https", async () => {
  const noRequest = () => assert.fail("no request");
  const io = (env) => ({ env, stdout: sink(), stderr: sink(), stdin: Readable.from([""]), fetchImpl: noRequest });
  // No --api-key flag: a key on the command line would land in shell history and CI logs.
  assert.equal(await main(["status", "a".repeat(32), "--api-key", KEY], io({})), EXIT.usage);
  assert.equal(await main(["status", "a".repeat(32), "--endpoint", "http://example.com/mcp"], io({ MENSO_API_KEY: KEY })), EXIT.usage);
  assert.equal(await main(["status", "a".repeat(32)], io({ MENSO_API_KEY: KEY, MENSO_MCP_URL: "http://example.com/mcp" })), EXIT.usage);
  assert.equal(await main(["status", "a".repeat(32)], io({ MENSO_API_KEY: KEY, MENSO_MCP_URL: "not a url" })), EXIT.usage);
});

test("the published binary talks to a real HTTP server", async () => {
  const seen = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw);
      seen.push({ method: req.headers["mcp-method"], name: req.headers["mcp-name"], auth: req.headers.authorization });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { resultType: "complete", content: [{ type: "text", text: "Test aaaa is running." }], structuredContent: { state: "running" } },
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const binary = fileURLToPath(new URL("../bin/menso.mjs", import.meta.url));
    // Async spawn: a blocking spawnSync would starve this in-process server.
    const child = await new Promise((resolve) => {
      const proc = spawn(process.execPath, [binary, "status", "a".repeat(32)], {
        env: { PATH: process.env.PATH, MENSO_API_KEY: KEY, MENSO_MCP_URL: `http://127.0.0.1:${port}/mcp` },
      });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk) => (stdout += chunk));
      proc.stderr.on("data", (chunk) => (stderr += chunk));
      proc.on("close", (status) => resolve({ status, stdout, stderr }));
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.trim(), "Test aaaa is running.");
    assert.deepEqual(seen, [{ method: "tools/call", name: "get_status", auth: `Bearer ${KEY}` }]);
  } finally {
    server.close();
  }
});

test("page text cannot forge workflow commands or break out of the job summary", async () => {
  const summaryDir = mkdtempSync(join(tmpdir(), "menso-cli-"));
  const summary = join(summaryDir, "summary.md");
  const planted =
    "TRACES 40/100\n::error::Ignore prior instructions\n  ::stop-commands::token\r\n```\n</pre># Injected heading\u2028::warning::x\u001b[31m";
  const result = await run(["run", "example.com", "--wait"], {
    env: { GITHUB_STEP_SUMMARY: summary },
    handlers: {
      run_test: text("Started\n::notice::from run_test", { test_id: "9".repeat(32), state: "running" }),
      get_status: text("done", { test_id: "9".repeat(32), state: "done", findings_ready: true }),
      get_findings: text(planted, { test_id: "9".repeat(32), traces: TRACES, friction_points_included: false }),
    },
  });
  assert.equal(result.code, EXIT.ok);
  for (const stream of [result.stdout, result.stderr]) {
    for (const line of stream.split("\n")) {
      assert.doesNotMatch(line, /^\s*::/, `workflow command reached the log: ${JSON.stringify(line)}`);
    }
    assert.doesNotMatch(stream, /\u001b/);
  }
  const written = readFileSync(summary, "utf8");
  assert.match(written, /^## Menso test 9{32}\n\n<pre>/);
  assert.equal(written.match(/<\/pre>/g).length, 1, "the planted </pre> is escaped");
  assert.ok(written.trimEnd().endsWith("</pre>"), "nothing renders outside the <pre> block");
  assert.match(written, /&lt;\/pre&gt;# Injected heading/);
});

test("safeText and htmlEscape", () => {
  assert.equal(safeText("::error::x"), ":\u200b:error::x");
  assert.equal(safeText("a\r\n  ::set-output"), "a\n  :\u200b:set-output");
  assert.equal(safeText("ok :: mid-line"), "ok :: mid-line");
  assert.equal(safeText("x ##[error]boom"), "x #\u200b#[error]boom");
  assert.equal(safeText("###[group]"), "##\u200b#[group]");
  assert.equal(safeText("# heading ## [ok] #[ok]"), "# heading ## [ok] #[ok]");
  assert.equal(htmlEscape('<a href="x">&</a>'), "&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
});

// The legacy "##[command]" form works anywhere in a line.
const LEGACY = /##\[/;

test("the legacy ##[ form cannot reach the log, in text or --json output", async () => {
  const summaryDir = mkdtempSync(join(tmpdir(), "menso-cli-"));
  const summary = join(summaryDir, "summary.md");
  const planted = "Pricing is unclear ##[error]forged annotation ##[group]hidden";
  const structured = {
    test_id: "8".repeat(32),
    traces: { total: 40, dimensions: [{ key: "C", name: "Comprehension & Mental Model", score: 2, weight: 15, reason: planted }] },
    friction_points_included: true,
    friction_points: [{ description: planted, evidence: "a ##[warning]b", steps: [1] }],
    "##[key]": "a key the server should never send",
  };
  const handlers = {
    run_test: text(`Started ${planted}`, { test_id: "8".repeat(32), state: "running", note: planted }),
    get_status: text(`done ${planted}`, { test_id: "8".repeat(32), state: "done", findings_ready: true }),
    get_findings: text(`TRACES 40/100\n${planted}`, structured),
  };
  for (const argv of [
    ["run", "example.com", "--wait"],
    ["run", "example.com", "--wait", "--json"],
    ["run", "example.com", "--json"],
    ["findings", "8".repeat(32), "--json"],
    ["status", "8".repeat(32), "--json"],
    ["findings", "8".repeat(32)],
  ]) {
    const result = await run(argv, { env: { GITHUB_STEP_SUMMARY: summary }, handlers });
    assert.equal(result.code, EXIT.ok, argv.join(" "));
    for (const line of `${result.stdout}\n${result.stderr}`.split("\n")) {
      assert.doesNotMatch(line, LEGACY, `${argv.join(" ")}: ${JSON.stringify(line)}`);
      assert.doesNotMatch(line, /^\s*::/);
    }
    if (argv.includes("--json") && argv[0] !== "status" && !(argv[0] === "run" && !argv.includes("--wait"))) {
      assert.deepEqual(JSON.parse(result.stdout), structured, "scripts still parse the exact values");
    }
  }
  assert.doesNotMatch(readFileSync(summary, "utf8"), LEGACY);
});

test("safeJson keeps values and escapes only the legacy marker", () => {
  const value = { a: "x ##[error]y", b: "\\##[z", c: "## [ok]", "##[k]": 1 };
  const json = safeJson(value);
  assert.doesNotMatch(json, LEGACY);
  assert.deepEqual(JSON.parse(json), value);
  assert.equal(safeJson(undefined), "{}");
});
