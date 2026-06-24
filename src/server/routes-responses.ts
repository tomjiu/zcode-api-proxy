/**
 * OpenAI Responses API route handler: POST /v1/responses
 * @see https://platform.openai.com/docs/api-reference/responses
 */
import { proxyRequest, type ProxyHandlerOptions } from "../proxy/handler.js";
import crypto from "node:crypto";

/** Handle POST /v1/responses — translate to Anthropic upstream and translate response back. */
export async function handleResponses(
  req: Request,
  opts: ProxyHandlerOptions,
): Promise<Response> {
  // Read the original body
  const body = await req.text();
  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch {
    return new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "Invalid JSON" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const stream = parsed.stream || false;

  // Convert OpenAI Responses API format to Chat Completions format
  const messages: any[] = [];

  // Add instructions as system message
  if (parsed.instructions) {
    messages.push({ role: "system", content: parsed.instructions });
  }

  // Convert input to messages
  if (typeof parsed.input === "string") {
    messages.push({ role: "user", content: parsed.input });
  } else if (Array.isArray(parsed.input)) {
    for (const item of parsed.input) {
      if (typeof item === "string") {
        messages.push({ role: "user", content: item });
      } else if (item.role && item.content) {
        messages.push({ role: item.role, content: item.content });
      }
    }
  }

  // Build Chat Completions request
  const chatRequest = {
    model: parsed.model,
    messages,
    stream: false, // Always get non-streaming for conversion
    max_tokens: parsed.max_output_tokens || parsed.max_tokens,
    temperature: parsed.temperature,
    top_p: parsed.top_p,
  };

  // Create a new request with the converted body
  const newReq = new Request(req.url.replace("/v1/responses", "/v1/chat/completions"), {
    method: req.method,
    headers: req.headers,
    body: JSON.stringify(chatRequest),
  });

  // Get the response from the proxy
  const chatResponse = await proxyRequest(newReq, "openai", opts);

  if (!chatResponse.ok) {
    return chatResponse;
  }

  // Convert Chat Completions response to Responses API format
  const chatData = await chatResponse.json() as any;
  const responseId = "resp_" + crypto.randomBytes(12).toString("hex");
  const created = Math.floor(Date.now() / 1000);

  const content = chatData.choices?.[0]?.message?.content || "";

  const responseData = {
    id: responseId,
    object: "response",
    created,
    model: chatData.model,
    output: [
      {
        type: "message",
        id: "msg_" + crypto.randomBytes(12).toString("hex"),
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: content,
            annotations: [],
          },
        ],
        status: "completed",
      },
    ],
    usage: chatData.usage || { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    status: "completed",
  };

  return new Response(JSON.stringify(responseData), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
