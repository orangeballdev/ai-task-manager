import Anthropic from "@anthropic-ai/sdk";
import { Agent, ProxyAgent, fetch as undiciFetch } from "undici";
import { ApiProvider } from "./api";

/**
 * Anthropic API provider for self-hosted / gateway deployments that authenticate
 * via mutual TLS (PKI) instead of (or in addition to) an API key. The client
 * presents a .p12 certificate bundle on the TLS handshake; requests are otherwise
 * identical to the standard Anthropic API, so this reuses ApiProvider's tool-use
 * execution loop and only swaps out how the HTTP client is built.
 */
export class ClaudePkiProvider extends ApiProvider {
  private pkiCert: Buffer;
  private pkiPassphrase?: string;
  private proxyUrl?: string;

  constructor(
    pkiCert: Buffer,
    pkiPassphrase?: string,
    apiKey?: string,
    model?: string,
    baseURL?: string,
    proxyUrl?: string,
    timeoutMs?: number,
    maxTokens?: number,
    effort?: string,
  ) {
    // PKI auth doesn't require an API key — the certificate is the credential.
    // Anthropic's SDK still insists on a non-empty apiKey/authToken being present
    // before it will send a request, so fall back to a harmless placeholder;
    // self-hosted gateways authenticating via mTLS ignore this header.
    super(apiKey?.trim() || "pki-client-cert-auth", model, baseURL, timeoutMs, maxTokens, effort);
    this.pkiCert = pkiCert;
    this.pkiPassphrase = pkiPassphrase;
    this.proxyUrl = proxyUrl;
  }

  override buildClient(): Anthropic {
    const tlsOptions = {
      pfx: this.pkiCert,
      passphrase: this.pkiPassphrase,
    };

    const dispatcher = this.proxyUrl
      ? new ProxyAgent({ uri: this.proxyUrl, requestTls: tlsOptions })
      : new Agent({ connect: tlsOptions });

    const clientOptions: Record<string, unknown> = {
      apiKey: this.apiKey,
      // Use undici's own fetch alongside its own dispatcher — mixing Node's global
      // fetch with an `undici` package dispatcher is not guaranteed compatible.
      fetch: undiciFetch,
      fetchOptions: { dispatcher },
    };
    if (this.baseURL) clientOptions.baseURL = this.baseURL;

    return new Anthropic(clientOptions as ConstructorParameters<typeof Anthropic>[0]);
  }
}
