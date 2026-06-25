/**
 * Auth manager — picks the right credential source based on mode.
 * @see .omo/plans/zcode-proxy.md Task 4
 */
import type { AuthMode, Credential } from "./types.js";
import { createApiKeyCredential } from "./apikey.js";
import type { ProviderId } from "../provider/types.js";
import { renewJWT, type RenewalContext } from "./renewer.js";

/** Options for constructing an `AuthManager`. */
interface AuthManagerOptions {
  mode: AuthMode;
  provider: ProviderId;
  /** Raw credential string for apikey mode (`{apiKey}` or `{apiKey}.{secret}`). */
  apiKey?: string;
}

/**
 * Resolves the upstream credential to inject into proxied requests.
 *
 * In `apikey` mode: returns a static credential parsed from the config string.
 * In `oauth` mode: returns the OAuth credential, auto-renewing if expired.
 */
export class AuthManager {
  private mode: AuthMode;
  private provider: ProviderId;
  private cachedApiKeyCred: Credential | null = null;
  private oauthCred: Credential | null = null;
  private renewalContext: RenewalContext | null = null;
  private renewalInProgress: Promise<Credential | null> | null = null;

  constructor(opts: AuthManagerOptions) {
    this.mode = opts.mode;
    this.provider = opts.provider;
    if (opts.mode === "apikey" && opts.apiKey) {
      this.cachedApiKeyCred = createApiKeyCredential(this.provider, opts.apiKey);
    }
  }

  /** Returns the current credential, refreshing if necessary. */
  async getCredential(): Promise<Credential> {
    if (this.mode === "apikey") {
      if (this.cachedApiKeyCred) return this.cachedApiKeyCred;
      throw new Error("apikey mode configured but no credential was set");
    }

    // oauth mode
    if (this.oauthCred) {
      // Check if expired
      if (this.oauthCred.expiresAt && Date.now() >= this.oauthCred.expiresAt) {
        // JWT expired, attempt auto-renewal
        if (this.renewalInProgress) {
          // Another request is already renewing, wait for it
          const fresh = await this.renewalInProgress;
          if (fresh) return fresh;
          throw new Error("JWT renewal in progress failed");
        }

        // Start renewal
        this.renewalInProgress = this.attemptRenewal();
        const fresh = await this.renewalInProgress;
        this.renewalInProgress = null;

        if (fresh) {
          this.oauthCred = fresh;
          return fresh;
        }

        // Renewal failed
        this.oauthCred = null;
        throw new Error("OAuth credential expired and auto-renewal failed. Re-run: zcode-proxy auth login");
      }

      return this.oauthCred;
    }
    throw new Error("OAuth credential not available — run login flow first");
  }

  /** Set the OAuth credential (used by T9/T10 OAuth flow). */
  setOAuthCredential(cred: Credential): void {
    this.oauthCred = cred;
  }

  /** Set renewal context (oauth access token, credential path) */
  setRenewalContext(ctx: RenewalContext): void {
    this.renewalContext = ctx;
  }

  /** Current auth mode. */
  getMode(): AuthMode {
    return this.mode;
  }

  private async attemptRenewal(): Promise<Credential | null> {
    if (!this.oauthCred || !this.renewalContext) {
      return null;
    }
    return await renewJWT(this.oauthCred, this.renewalContext);
  }
}
