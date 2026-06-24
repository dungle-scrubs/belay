import { type SessionTransport, streamTransport } from "@trevor/session";

/**
 * The Richter transport plug-in: the shared session stream client (@trevor/session)
 * bound to a Richter service URL. Richter speaks the same `/sessions` REST + WS
 * contract as the local session-store, so this is currently a thin binding - it
 * exists as the seam where Richter-specific concerns (auth, capabilities) will live
 * when Richter diverges from the local backend. Selecting Richter is constructing
 * `richterTransport(url)`; nothing else in the app names Richter.
 */
export function richterTransport(serviceUrl: string): SessionTransport {
  return streamTransport(serviceUrl);
}
