/**
 * Connectivity boundary so the engine stays testable without native modules.
 */
export interface NetworkMonitor {
  isOnline(): Promise<boolean>;
  /** Subscribes to connectivity changes; returns the unsubscribe function. */
  subscribe(listener: (online: boolean) => void): () => void;
}
