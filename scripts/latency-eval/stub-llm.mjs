// A fixed-latency, deterministic stand-in for the model, so the only thing that
// differs between two runs is the harness under test. First call of a turn asks
// for send_message; once a tool result is in the conversation it ends the turn.
import http from "node:http";
const LATENCY = Number(process.env.STUB_MS ?? 300);
let calls = 0;
http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url === "/calls") return res.end(String(calls));
    calls++;
    const { messages = [] } = JSON.parse(body || "{}");
    const spoke = messages.some((m) => m.role === "tool");
    const message = spoke
      ? { role: "assistant", content: "" }
      : { role: "assistant", content: null, tool_calls: [{ id: `call_${calls}`, type: "function", function: { name: "send_message", arguments: JSON.stringify({ text: "sounds good" }) } }] };
    setTimeout(() => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: `stub-${calls}`, object: "chat.completion", created: 0, model: "stub", choices: [{ index: 0, message, finish_reason: spoke ? "stop" : "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }));
    }, LATENCY);
  });
}).listen(18080, "127.0.0.1", () => console.log("stub llm on 18080, latency", LATENCY));
