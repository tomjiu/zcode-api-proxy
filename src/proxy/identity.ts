/**
 * Identity header builder — emits the ZCode desktop client's companion headers
 * on every upstream request so the proxy is indistinguishable from the official
 * client at the fingerprinting layer.
 *
 * Mirrors `eYn` in `_reverse/zcode.cjs` (offset ~9074294). Differences from the
 * bundle: we read resolved values from `ProxyIdentity` (env/YAML already merged
 * by the config loader) instead of `e[art]`/`t.appVersion`, and we always emit
 * `X-ZCode-App-Version` rather than gating on truthiness — the loader guarantees
 * a printable-ASCII value or the literal `"unknown"`.
 *
 * @see _reverse/NOTEPAD.md "How Credential is Used for LLM Calls"
 */
import type { ProxyIdentity } from "../config/types.js";

export interface IdentityHeaders {
  "User-Agent": string;
  "X-ZCode-App-Version": string;
  "X-Title": string;
  "X-ZCode-Agent": "glm";
  "HTTP-Referer": string;
}

/** Build the five identity headers injected upstream. Pure function. */
export function buildIdentityHeaders(id: ProxyIdentity): IdentityHeaders {
  return {
    "User-Agent": `ZCode/${id.appVersion}`,
    "X-ZCode-App-Version": id.appVersion,
    "X-Title": `Z Code@${id.sourceTitle}`,
    "X-ZCode-Agent": "glm",
    "HTTP-Referer": id.refererOrigin,
  };
}
