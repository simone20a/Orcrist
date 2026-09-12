/**
 * What a failed request actually says, instead of "fetch failed".
 *
 * When `fetch` cannot complete the request at all — nothing listening, a name
 * that will not resolve, a certificate the runtime refuses — Node throws a
 * `TypeError` whose message is the bare string "fetch failed" and puts the real
 * reason in `cause`. That string is useless wherever it surfaces: in a failed
 * run it cannot tell an unplugged Ollama from a typo in a base URL, and in a
 * tool result it is read by the model, which has to decide from it whether to
 * try again or work another way.
 *
 * So the cause is unwrapped here, once, for both.
 */

const TRANSPORT: Record<string, string> = {
  ECONNREFUSED: 'nothing is listening there',
  ENOTFOUND: 'that host name does not resolve',
  EAI_AGAIN: 'the host name could not be resolved — this machine may be offline, or its DNS is failing',
  ETIMEDOUT: 'the connection timed out. A firewall or a proxy may be dropping it',
  UND_ERR_CONNECT_TIMEOUT: 'the connection timed out. A firewall or a proxy may be dropping it',
  UND_ERR_HEADERS_TIMEOUT: 'the server accepted the connection and then sent nothing back in time',
  ECONNRESET: 'the connection was reset before the reply arrived',
  EHOSTUNREACH: 'that host is unreachable from this machine',
  ENETUNREACH: 'the network is unreachable — this machine looks offline',
  CERT_HAS_EXPIRED: 'its TLS certificate has expired',
  DEPTH_ZERO_SELF_SIGNED_CERT:
    'its TLS certificate is self-signed and was refused. A proxy intercepting HTTPS does this',
  SELF_SIGNED_CERT_IN_CHAIN:
    'a self-signed certificate in the chain was refused. A proxy intercepting HTTPS does this',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'its TLS certificate could not be verified',
};

/** True for the user pressing Stop, which must never be rewritten as a fault. */
export function isAbort(e: unknown): boolean {
  return e instanceof Error && (e.name === 'AbortError' || e.message === 'cancelled');
}

/**
 * The reason a request never completed, as a sentence, or undefined when the
 * failure is not a transport failure at all and the caller should report it
 * as it came.
 */
export function transportReason(e: unknown): string | undefined {
  const cause = (e as { cause?: { code?: string; message?: string } }).cause;
  const code = cause?.code;
  if (!cause && !(e instanceof TypeError)) return undefined;
  const detail = (code && TRANSPORT[code]) ?? cause?.message;
  if (!detail) return undefined;
  return code ? `${detail} (${code})` : detail;
}

/** The origin of a URL, for saying where the request was going. */
export function origin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    // a malformed address is itself the thing worth showing
    return url;
  }
}
