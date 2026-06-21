/**
 * Tests for SSE event translator.
 * @see .omo/plans/zcode-proxy.md Task 12
 */
import { describe, it, expect } from "bun:test";
import { anthropicSseToOpenaiSse, openaiSseToAnthropicSse } from "./sse-translator.js";

function makeStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  return result;
}

const ANTHROPIC_SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_123","type":"message","role":"assistant","content":[],"model":"glm-4.6","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":0}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
].join('\n');

describe("anthropicSseToOpenaiSse", () => {
  it("translates message_start to first chunk with role", async () => {
    const input = makeStream(ANTHROPIC_SSE);
    const output = await collectStream(anthropicSseToOpenaiSse(input, "glm-4.6"));
    expect(output).toContain('"role":"assistant"');
  });

  it("translates text_delta to delta.content", async () => {
    const input = makeStream(ANTHROPIC_SSE);
    const output = await collectStream(anthropicSseToOpenaiSse(input, "glm-4.6"));
    expect(output).toContain('"content":"Hello"');
    expect(output).toContain('"content":" world"');
  });

  it("translates message_delta stop_reason to finish_reason", async () => {
    const input = makeStream(ANTHROPIC_SSE);
    const output = await collectStream(anthropicSseToOpenaiSse(input, "glm-4.6"));
    expect(output).toContain('"finish_reason":"stop"');
  });

  it("emits [DONE] at the end", async () => {
    const input = makeStream(ANTHROPIC_SSE);
    const output = await collectStream(anthropicSseToOpenaiSse(input, "glm-4.6"));
    expect(output).toContain("data: [DONE]");
  });

  it("emits usage on final chunk from input_tokens + output_tokens", async () => {
    const input = makeStream(ANTHROPIC_SSE);
    const output = await collectStream(anthropicSseToOpenaiSse(input, "glm-4.6"));
    expect(output).toContain('"usage"');
    expect(output).toContain('"prompt_tokens":10');
    expect(output).toContain('"completion_tokens":5');
    expect(output).toContain('"total_tokens":15');
  });

  it("handles max_tokens stop reason", async () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_1","model":"glm-4.6"}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');
    const input = makeStream(sse);
    const output = await collectStream(anthropicSseToOpenaiSse(input, "glm-4.6"));
    expect(output).toContain('"finish_reason":"length"');
  });
});

describe("openaiSseToAnthropicSse", () => {
  it("emits message_start on first chunk", async () => {
    const sse = [
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":123,"model":"glm-4.6","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
      '',
    ].join('\n');
    const input = makeStream(sse);
    const output = await collectStream(openaiSseToAnthropicSse(input, "glm-4.6"));
    expect(output).toContain("message_start");
    expect(output).toContain('"role":"assistant"');
  });

  it("translates delta.content to text_delta", async () => {
    const sse = [
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"glm-4.6","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const input = makeStream(sse);
    const output = await collectStream(openaiSseToAnthropicSse(input, "glm-4.6"));
    expect(output).toContain("text_delta");
    expect(output).toContain('"text":"Hi"');
  });

  it("emits message_stop on [DONE]", async () => {
    const sse = [
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"glm-4.6","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const input = makeStream(sse);
    const output = await collectStream(openaiSseToAnthropicSse(input, "glm-4.6"));
    expect(output).toContain("message_stop");
  });
});
