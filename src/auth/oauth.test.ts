/**
 * Tests for OAuth flow handlers.
 * @see .omo/plans/zcode-proxy.md Task 9
 */
import { describe, it, expect } from "bun:test";
import { ZaiOAuthClient } from "./oauth.js";

/**
 * Wrap response data in the Z.AI {code, data, msg} envelope.
 * The real API always wraps responses this way.
 */
function zaiEnvelope(data: Record<string, unknown>): string {
  return JSON.stringify({ code: 0, data, msg: "success" });
}

describe("ZaiOAuthClient", () => {
  it("init unwraps {code,data} envelope and returns flowId + authorizeUrl + client-generated pollToken", async () => {
    let capturedAuthHeader = "";
    const trackingFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      if (init?.headers && typeof init.headers === "object") {
        const headers = init.headers as Record<string, string>;
        capturedAuthHeader = headers.authorization ?? headers.Authorization ?? "";
      }
      if (url.includes("/init")) {
        return new Response(zaiEnvelope({
          flow_id: "flow_123",
          poll_token: "server_poll_tok",
          authorize_url: "https://zcode.z.ai/authorize?flow=flow_123",
          expires_at: Math.floor(Date.now() / 1000) + 300,
          poll_interval_sec: 1,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const client = new ZaiOAuthClient(trackingFetch);
    const init = await client.init("zai");
    expect(init.flowId).toBe("flow_123");
    expect(init.pollToken).toMatch(/^[0-9a-f]{64}$/);
    expect(capturedAuthHeader).toBe(`Bearer ${init.pollToken}`);
    expect(init.authorizeUrl).toContain("authorize");
    expect(init.pollIntervalSec).toBe(1);
  });

  it("poll unwraps envelope and returns pending status", async () => {
    const mockFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/poll/")) {
        return new Response(zaiEnvelope({ status: "pending" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("404", { status: 404 });
    }) as typeof fetch;

    const client = new ZaiOAuthClient(mockFetch);
    const result = await client.poll("flow_123", "poll_tok");
    expect(result.status).toBe("pending");
  });

  it("poll unwraps envelope and returns ready with access token", async () => {
    const mockFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/poll/")) {
        return new Response(zaiEnvelope({
          status: "ready",
          token: "jwt_token_xyz",
          zai: { access_token: "zai_access_123" },
          user: { user_id: "u1", name: "test" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("404", { status: 404 });
    }) as typeof fetch;

    const client = new ZaiOAuthClient(mockFetch);
    const result = await client.poll("flow_123", "poll_tok");
    expect(result.status).toBe("ready");
    expect(result.zai?.access_token).toBe("zai_access_123");
    expect(result.userId).toBe("u1");
  });

  it("poll returns userId undefined when user object absent", async () => {
    const mockFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/poll/")) {
        return new Response(zaiEnvelope({
          status: "ready",
          token: "jwt",
          zai: { access_token: "tok" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("404", { status: 404 });
    }) as typeof fetch;

    const client = new ZaiOAuthClient(mockFetch);
    const result = await client.poll("flow_123", "poll_tok");
    expect(result.userId).toBeUndefined();
  });

  it("poll returns failed on 400", async () => {
    const mockFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      return new Response(JSON.stringify({ code: 3004, msg: "invalid_flow" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const client = new ZaiOAuthClient(mockFetch);
    const result = await client.poll("flow_123", "poll_tok");
    expect(result.status).toBe("failed");
  });

  it("init throws on non-zero business code", async () => {
    const mockFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      return new Response(JSON.stringify({ code: 3004, msg: "invalid_flow" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const client = new ZaiOAuthClient(mockFetch);
    expect(client.init("zai")).rejects.toThrow(/invalid_flow|business error/);
  });

  it("init throws on HTTP error", async () => {
    const mockFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      return new Response("server error", { status: 500 });
    }) as typeof fetch;

    const client = new ZaiOAuthClient(mockFetch);
    expect(client.init("zai")).rejects.toThrow(/init failed/);
  });

  it("waitForAuth resolves on ready status after pending polls", async () => {
    let pollCount = 0;
    const dynamicFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/init")) {
        return new Response(zaiEnvelope({
          flow_id: "f1",
          poll_token: "p1",
          authorize_url: "https://example.com/auth",
          expires_at: Math.floor(Date.now() / 1000) + 10,
          poll_interval_sec: 0,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/poll/")) {
        pollCount++;
        if (pollCount < 2) {
          return new Response(zaiEnvelope({ status: "pending" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(zaiEnvelope({
          status: "ready",
          token: "jwt",
          zai: { access_token: "resolved_token" },
          user: { user_id: "user_42" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("404", { status: 404 });
    }) as typeof fetch;

    const client = new ZaiOAuthClient(dynamicFetch);
    const init = await client.init("zai");
    const result = await client.waitForAuth(init);
    expect(result.accessToken).toBe("resolved_token");
    expect(result.provider).toBe("zai");
    expect(result.userId).toBe("user_42");
  });

  it("waitForAuth calls onAuthorizeUrl callback", async () => {
    let callbackUrl = "";
    const fastFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/init")) {
        return new Response(zaiEnvelope({
          flow_id: "f1",
          poll_token: "p1",
          authorize_url: "https://custom-auth-url.com/xyz",
          expires_at: Math.floor(Date.now() / 1000) + 10,
          poll_interval_sec: 0,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(zaiEnvelope({
        status: "ready",
        token: "jwt",
        zai: { access_token: "tok" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const client = new ZaiOAuthClient(fastFetch);
    const init = await client.init("zai");
    await client.waitForAuth(init, (url) => { callbackUrl = url; });
    expect(callbackUrl).toBe("https://custom-auth-url.com/xyz");
  });
});
