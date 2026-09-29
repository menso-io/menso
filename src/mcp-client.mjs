/**
 * A minimal client for Menso's hosted MCP endpoint (Streamable HTTP,
 * protocol 2026-07-28: stateless, one POST per call, version and method in
 * both the body's _meta and the request headers).
 */

export const PROTOCOL_VERSION = "2026-07-28";
export const DEFAULT_ENDPOINT = "https://api.menso.io/mcp";

export class McpError extends Error {
  constructor(message, { status, retryable = false } = {}) {
    super(message);
    this.name = "McpError";
    this.status = status;
    this.retryable = retryable;
  }
}

function parseSse(text, id) {
  // A server may answer with an SSE stream; the result is the event whose id matches.
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    try {
      const message = JSON.parse(data);
      if (message && message.id === id) return message;
    } catch {
      // not a JSON-RPC message; ignore
    }
  }
  return null;
}

export class McpClient {
  constructor({ endpoint = DEFAULT_ENDPOINT, apiKey, clientVersion = "0", fetchImpl = globalThis.fetch, timeoutMs = 90_000 }) {
    if (!apiKey) throw new McpError("An API key is required.");
    this.endpoint = endpoint;
    this.apiKey = apiKey;
    this.clientVersion = clientVersion;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
  }

  async callTool(name, args) {
    const id = this.nextId++;
    const body = {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name,
        arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientInfo": { name: "menso-cli", version: this.clientVersion },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    };
    let response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": PROTOCOL_VERSION,
          "Mcp-Method": "tools/call",
          "Mcp-Name": name,
          Authorization: `Bearer ${this.apiKey}`,
          "User-Agent": `menso-cli/${this.clientVersion}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new McpError(`Could not reach ${this.endpoint}: ${error?.message ?? error}`, { retryable: true });
    }
    const text = await response.text();
    const contentType = response.headers.get("content-type") ?? "";
    let message = null;
    if (contentType.includes("text/event-stream")) {
      message = parseSse(text, id);
    } else {
      try {
        message = JSON.parse(text);
      } catch {
        message = null;
      }
    }
    if (message?.error) {
      throw new McpError(message.error.message || "The Menso server returned an error.", {
        status: response.status,
        retryable: response.status >= 500,
      });
    }
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      const hint = response.status === 429 ? "Too many requests; slow down and retry." : `HTTP ${response.status}`;
      throw new McpError(`The Menso server refused the request (${hint}).`, { status: response.status, retryable });
    }
    if (!message || !message.result) {
      throw new McpError("The Menso server sent a response this CLI could not read.", { status: response.status });
    }
    return message.result;
  }
}
