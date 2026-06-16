/**
 * Tests for identity header builder.
 * @see _reverse/NOTEPAD.md "How Credential is Used for LLM Calls"
 */
import { describe, it, expect } from "bun:test";
import { buildIdentityHeaders } from "./identity.js";
import type { ProxyIdentity } from "../config/types.js";

const BASE: ProxyIdentity = {
  appVersion: "1.2.3",
  sourceTitle: "cli",
  refererOrigin: "https://zcode.z.ai",
};

describe("buildIdentityHeaders", () => {
  it("emits User-Agent as ZCode/{appVersion}", () => {
    const h = buildIdentityHeaders({ ...BASE, appVersion: "9.9.9" });
    expect(h["User-Agent"]).toBe("ZCode/9.9.9");
  });

  it("emits X-ZCode-App-Version mirroring User-Agent version", () => {
    const h = buildIdentityHeaders({ ...BASE, appVersion: "4.5.6" });
    expect(h["X-ZCode-App-Version"]).toBe("4.5.6");
    expect(h["User-Agent"]).toBe("ZCode/4.5.6");
  });

  it("emits X-Title as `Z Code@{sourceTitle}`", () => {
    const h = buildIdentityHeaders({ ...BASE, sourceTitle: "electron" });
    expect(h["X-Title"]).toBe("Z Code@electron");
  });

  it("hard-codes X-ZCode-Agent to glm", () => {
    const h = buildIdentityHeaders(BASE);
    expect(h["X-ZCode-Agent"]).toBe("glm");
  });

  it("passes refererOrigin through as HTTP-Referer", () => {
    const h = buildIdentityHeaders({ ...BASE, refererOrigin: "https://example.com" });
    expect(h["HTTP-Referer"]).toBe("https://example.com");
  });

  it("preserves the 'unknown' fallback literally (loader-level concern)", () => {
    const h = buildIdentityHeaders({ ...BASE, appVersion: "unknown" });
    expect(h["User-Agent"]).toBe("ZCode/unknown");
    expect(h["X-ZCode-App-Version"]).toBe("unknown");
  });
});
