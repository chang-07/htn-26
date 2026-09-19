#!/usr/bin/env node
/**
 * Local dev LLM on your Claude plan.
 *
 * Serves an OpenAI-compatible POST /v1/chat/completions on 127.0.0.1 and answers
 * each request by running headless Claude Code (`claude -p`), which is signed in
 * with your Claude subscription. Point the agent's `dev` LLM profile at it and
 * local testing spends neither OpenAI credits nor Anthropic API credits:
 *
 *   node scripts/claude-llm-proxy.mjs            # then, in .env:
 *   DEV_LLM_BASE_URL=http://127.0.0.1:11435/v1
 *   DEV_LLM_MODEL=haiku                          # or sonnet / opus
 *
 * This is for one developer's own laptop. It cannot work from the deployed
 * Worker, and it must not be exposed to other people: it spends your plan's
 * usage limits — the same limits your interactive Claude Code sessions draw on.
 *
 * How tool calling works: the OpenAI `tools` array is served to Claude Code as
 * real tools by a minimal MCP server (this same file, run with --mcp). The model
 * then makes a native tool call, which the proxy reads off the stream-json
 * output and returns as OpenAI `tool_calls` — stopping the run before anything
 * executes, because executing tools is the agent loop's job, not Claude Code's.
 * Imitating function calling in the prompt instead does not work: the model
 * tries a native call anyway, finds no such tool, and reports a failure.
 */
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const PORT = Number(process.env.CLAUDE_PROXY_PORT ?? 11435);
const DEFAULT_MODEL = process.env.CLAUDE_PROXY_MODEL ?? "haiku";

// An empty working directory: no CLAUDE.md, project settings or memory leak in.
const CWD = path.join(os.tmpdir(), "claude-llm-proxy");
fs.mkdirSync(CWD, { recursive: true });

// With ANTHROPIC_API_KEY in the environment, `claude -p` bills that key instead
// of the plan — the opposite of the point. Thinking is off for latency.
const childEnv = { ...process.env, MAX_THINKING_TOKENS: "0" };
delete childEnv.ANTHROPIC_API_KEY;
delete childEnv.ANTHROPIC_AUTH_TOKEN;

const text = (content) =>
  typeof content === "string" ? content : (content ?? []).map((p) => p.text ?? "").join("");

const MCP_NAME = "fn";
const MCP_PREFIX = `mcp__${MCP_NAME}__`;

/**
 * MCP server mode: `node claude-llm-proxy.mjs --mcp <tools.json>`. Speaks just
 * enough newline-delimited JSON-RPC for Claude Code to list the tools. A call is
 * never expected to complete — the proxy stops the run as soon as it sees one.
 */
if (process.argv[2] === "--mcp") {
  const tools = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
  let buffer = "";
  const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id === undefined) continue; // notification
      if (msg.method === "initialize") {
        reply(msg.id, {
          protocolVersion: msg.params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "claude-llm-proxy", version: "1" },
        });
      } else if (msg.method === "tools/list") {
        reply(msg.id, {
          tools: tools.map((t) => ({
            name: t.function.name,
            description: t.function.description ?? "",
            inputSchema: t.function.parameters ?? { type: "object" },
          })),
        });
      } else if (msg.method === "tools/call") {
        reply(msg.id, { content: [{ type: "text", text: "queued" }] });
      } else {
        reply(msg.id, {});
      }
    }
  });
  await new Promise(() => {}); // serve until Claude Code closes us
}

const TOOL_NOTE = `

You act only through the provided ${MCP_NAME} tools; they are all available and working. When a tool can do or find something, call it rather than describing it. Your plain-text output is read by the calling program, never by a person: if there is a tool for communicating with people, that tool is the only way to reach them.`;

/** The conversation after the system message, as a plain transcript. */
function transcript(messages) {
  return messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      if (m.role === "tool") return `TOOL RESULT (${m.tool_call_id}):\n${text(m.content)}`;
      if (m.role === "assistant") {
        const calls = (m.tool_calls ?? []).map(
          (c) => `CALLED ${c.function.name} (${c.id}) with ${c.function.arguments}`,
        );
        return `ASSISTANT:\n${[text(m.content), ...calls].filter(Boolean).join("\n")}`;
      }
      return `USER:\n${text(m.content)}`;
    })
    .join("\n\n");
}

/**
 * Runs one model turn. Resolves with the tool calls the model made, or with its
 * text when it made none. The child is killed at the first sign a tool call is
 * being executed, so a turn costs exactly one model response.
 */
function runClaude({ system, prompt, model, tools }) {
  const args = [
    "-p", "--model", model, "--system-prompt", system, "--tools", "",
    "--disable-slash-commands", "--no-session-persistence",
    "--output-format", "stream-json", "--verbose", "--strict-mcp-config",
  ];
  let toolsFile;
  if (tools.length) {
    toolsFile = path.join(CWD, `tools-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(toolsFile, JSON.stringify(tools));
    args.push("--mcp-config", JSON.stringify({
      mcpServers: { [MCP_NAME]: { command: process.execPath, args: [new URL(import.meta.url).pathname, "--mcp", toolsFile] } },
    }));
  }

  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { cwd: CWD, env: childEnv });
    const calls = [];
    let usage = {};
    let buffer = "";
    let err = "";
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      if (toolsFile) fs.rm(toolsFile, () => {});
      fn(value);
    };

    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }

        if (event.type === "assistant") {
          usage = event.message?.usage ?? usage;
          for (const block of event.message?.content ?? []) {
            if (block.type === "tool_use" && block.name.startsWith(MCP_PREFIX)) {
              calls.push({ name: block.name.slice(MCP_PREFIX.length), arguments: block.input ?? {} });
            }
          }
        } else if (event.type === "user" && calls.length) {
          // A tool result is coming back: the model's turn is over. Stop here.
          finish(resolve, { calls, content: "", usage });
        } else if (event.type === "result") {
          if (event.is_error && !calls.length) return finish(reject, new Error(String(event.result).slice(0, 400)));
          finish(resolve, { calls, content: calls.length ? "" : String(event.result ?? ""), usage: event.usage ?? usage });
        }
      }
    });
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => finish(reject, e));
    child.on("close", (code) => finish(reject, new Error(`claude exited ${code} without a result: ${err.slice(0, 400)}`)));
    child.stdin.end(prompt);
  });
}

async function complete(body) {
  const tools = (body.tools ?? []).filter((t) => t.type === "function");
  const wantsJson = body.response_format?.type === "json_object";
  const model = ["haiku", "sonnet", "opus"].includes(body.model) ? body.model : DEFAULT_MODEL;
  const base = body.messages.filter((m) => m.role === "system").map((m) => text(m.content)).join("\n\n");

  const started = Date.now();
  const res = await runClaude({
    system: base + (tools.length ? TOOL_NOTE : wantsJson ? "\n\nReply with the JSON object only: no prose, no code fences." : ""),
    prompt: transcript(body.messages),
    model,
    tools,
  });

  const calls = res.calls;
  let content = res.content;
  if (wantsJson) content = content.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, "");

  const message = { role: "assistant", content: calls.length ? null : content };
  if (calls.length) {
    message.tool_calls = calls.map((c) => ({
      id: `call_${Math.random().toString(36).slice(2, 12)}`,
      type: "function",
      function: { name: c.name, arguments: JSON.stringify(c.arguments) },
    }));
  }

  const u = res.usage ?? {};
  const promptTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  console.log(
    `${new Date().toISOString().slice(11, 19)} ${model.padEnd(6)} ${String(Date.now() - started).padStart(6)}ms  ` +
      (calls.length ? `tools: ${calls.map((c) => c.name).join(", ")}` : `text: ${content.length} chars`),
  );

  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: `claude-${model}`,
    choices: [{ index: 0, message, finish_reason: calls.length ? "tool_calls" : "stop" }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: u.output_tokens ?? 0,
      total_tokens: promptTokens + (u.output_tokens ?? 0),
    },
  };
}

http
  .createServer(async (req, res) => {
    const send = (status, json) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };
    if (req.method === "GET" && req.url?.startsWith("/v1/models")) {
      return send(200, { object: "list", data: ["haiku", "sonnet", "opus"].map((id) => ({ id, object: "model" })) });
    }
    if (req.method !== "POST" || !req.url?.startsWith("/v1/chat/completions")) {
      return send(404, { error: { message: "only POST /v1/chat/completions" } });
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    try {
      send(200, await complete(JSON.parse(raw)));
    } catch (err) {
      console.error("request failed:", err.message);
      send(500, { error: { message: err.message, type: "claude_proxy_error" } });
    }
  })
  // Loopback only: anyone who can reach this port can spend your plan.
  .listen(PORT, "127.0.0.1", () => {
    console.log(`claude-llm-proxy on http://127.0.0.1:${PORT}/v1  (default model: ${DEFAULT_MODEL}, billing: Claude plan login)`);
  });
