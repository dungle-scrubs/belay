import { frames, type HostPresence, type StreamEnvelope } from "@belay/session";
import type { WebSocket } from "ws";

type AttachOptions = {
  readonly host?: HostPresence;
};

/**
 * Owns the live per-session WebSocket fan-out and host presence maps.
 *
 * The durable log can replay history, but only the open socket set can answer
 * "which hosts are live right now". Keeping subscribers and host presence under
 * one owner prevents close handling from updating one map without the other.
 */
export class SessionHub {
  readonly #subscribers = new Map<string, Set<WebSocket>>();
  readonly #hosts = new Map<string, Map<WebSocket, HostPresence>>();

  attach(sessionId: string, socket: WebSocket, options: AttachOptions = {}): void {
    this.#subscribe(sessionId, socket);

    if (options.host) {
      this.#addHost(sessionId, socket, options.host);
      this.broadcastPresence(sessionId);
      return;
    }

    this.#send(socket, frames.presence(this.hostsOf(sessionId)));
  }

  detach(sessionId: string, socket: WebSocket): void {
    this.#unsubscribe(sessionId, socket);
    if (this.#removeHost(sessionId, socket)) {
      this.broadcastPresence(sessionId);
    }
  }

  publish(sessionId: string, frame: StreamEnvelope): void {
    const set = this.#subscribers.get(sessionId);
    if (!set) {
      return;
    }

    const data = JSON.stringify(frame);
    for (const socket of set) {
      if (socket.readyState === socket.OPEN) {
        socket.send(data);
      }
    }
  }

  broadcastPresence(sessionId: string): void {
    this.publish(sessionId, frames.presence(this.hostsOf(sessionId)));
  }

  hostsOf(sessionId: string): HostPresence[] {
    const set = this.#hosts.get(sessionId);
    if (!set) {
      return [];
    }

    const byId = new Map<string, HostPresence>();
    for (const presence of set.values()) {
      byId.set(presence.instanceId, presence);
    }
    return [...byId.values()];
  }

  hasLiveHost(sessionId: string): boolean {
    return this.hostsOf(sessionId).length > 0;
  }

  #subscribe(sessionId: string, socket: WebSocket): void {
    const set = this.#subscribers.get(sessionId) ?? new Set<WebSocket>();
    set.add(socket);
    this.#subscribers.set(sessionId, set);
  }

  #unsubscribe(sessionId: string, socket: WebSocket): void {
    const set = this.#subscribers.get(sessionId);
    if (!set) {
      return;
    }

    set.delete(socket);
    if (set.size === 0) {
      this.#subscribers.delete(sessionId);
    }
  }

  #addHost(sessionId: string, socket: WebSocket, presence: HostPresence): void {
    const set = this.#hosts.get(sessionId) ?? new Map<WebSocket, HostPresence>();
    set.set(socket, presence);
    this.#hosts.set(sessionId, set);
  }

  #removeHost(sessionId: string, socket: WebSocket): boolean {
    const set = this.#hosts.get(sessionId);
    if (!set?.delete(socket)) {
      return false;
    }

    if (set.size === 0) {
      this.#hosts.delete(sessionId);
    }
    return true;
  }

  #send(socket: WebSocket, frame: StreamEnvelope): void {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(frame));
    }
  }
}
