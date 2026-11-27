// Browser half of the passkey ceremonies: converts the JSON options from
// /api/auth/passkey/* into what navigator.credentials expects and the resulting
// credential back into JSON (base64url) for the verify call.
import { useSyncExternalStore } from "react";

function b64urlToBuffer(s: string): ArrayBuffer {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

function bufferToB64url(buf: ArrayBuffer | null | undefined): string | undefined {
  if (!buf) return undefined;
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

type Json = Record<string, unknown>;
interface CredDescriptorJSON {
  id: string;
  type?: string;
  transports?: string[];
}

export function passkeysSupported(): boolean {
  return typeof window !== "undefined" && !!window.PublicKeyCredential && !!navigator.credentials;
}

export function passkeyUnsupportedReason(): string | null {
  if (typeof window === "undefined") return null;
  if (!window.isSecureContext) return "Passkeys need HTTPS (or http://localhost).";
  if (!passkeysSupported()) return "This browser doesn't support passkeys.";
  return null;
}

const noopSubscribe = () => () => {};

/** passkeyUnsupportedReason() as a hook: null during SSR, the real answer after hydration. */
export function usePasskeyUnsupportedReason(): string | null {
  return useSyncExternalStore(noopSubscribe, passkeyUnsupportedReason, () => null);
}

function toDescriptors(list: unknown): PublicKeyCredentialDescriptor[] | undefined {
  if (!Array.isArray(list)) return undefined;
  return (list as CredDescriptorJSON[]).map((c) => ({
    id: b64urlToBuffer(c.id),
    type: "public-key",
    transports: c.transports as AuthenticatorTransport[] | undefined,
  }));
}

export async function createPasskey(options: Json): Promise<Json> {
  const user = options.user as { id: string; name: string; displayName: string };
  const publicKey: PublicKeyCredentialCreationOptions = {
    ...(options as unknown as PublicKeyCredentialCreationOptions),
    challenge: b64urlToBuffer(options.challenge as string),
    user: { ...user, id: b64urlToBuffer(user.id) },
    excludeCredentials: toDescriptors(options.excludeCredentials),
  };
  const cred = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null;
  if (!cred) throw new Error("Passkey creation was cancelled.");
  const response = cred.response as AuthenticatorAttestationResponse;
  return {
    id: cred.id,
    rawId: bufferToB64url(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      clientDataJSON: bufferToB64url(response.clientDataJSON),
      attestationObject: bufferToB64url(response.attestationObject),
      transports: typeof response.getTransports === "function" ? response.getTransports() : undefined,
    },
  };
}

export async function getPasskey(options: Json): Promise<Json> {
  const publicKey: PublicKeyCredentialRequestOptions = {
    ...(options as unknown as PublicKeyCredentialRequestOptions),
    challenge: b64urlToBuffer(options.challenge as string),
    allowCredentials: toDescriptors(options.allowCredentials),
  };
  const cred = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
  if (!cred) throw new Error("Passkey sign-in was cancelled.");
  const response = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id,
    rawId: bufferToB64url(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      clientDataJSON: bufferToB64url(response.clientDataJSON),
      authenticatorData: bufferToB64url(response.authenticatorData),
      signature: bufferToB64url(response.signature),
      userHandle: bufferToB64url(response.userHandle),
    },
  };
}

/** Friendly message for the DOMExceptions WebAuthn throws. */
export function describePasskeyError(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === "NotAllowedError") return "The passkey prompt was cancelled or timed out.";
    if (err.name === "InvalidStateError") return "This passkey is already registered.";
    if (err.name === "SecurityError") return "Passkeys aren't available on this address. Use the site's HTTPS domain.";
  }
  return err instanceof Error ? err.message : "Passkey operation failed.";
}
