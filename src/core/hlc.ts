export interface HlcState {
  lastWallMs: number;
  counter: number;
  nodeId: string; // 12 lowercase hex chars unique per device installation in SecureStore
}

export type FieldHlcMap = Record<string, string>;

const HLC_REGEX =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)-([0-9a-f]{4})-([0-9a-f]{12})$/;
const NODE_ID_REGEX = /^[0-9a-f]{12}$/;
const MAX_COUNTER = 0xffff;

/**
 * Validates whether a string is a canonical 42-character HLC.
 * Format: `<ISO-8601 UTC 24 chars>-<counter hex 4 chars>-<node_id 12 hex chars>`
 */
export function isValidHlc(hlc: string): boolean {
  if (typeof hlc !== 'string' || hlc.length !== 42) {
    return false;
  }
  const match = HLC_REGEX.exec(hlc);
  if (!match) {
    return false;
  }
  const parsedMs = Date.parse(match[1]);
  return Number.isFinite(parsedMs) && new Date(parsedMs).toISOString() === match[1];
}

/**
 * Packs wall clock milliseconds, 16-bit logical counter, and 12-char hex nodeId
 * into a canonical 42-character lexicographically sortable HLC string.
 */
export function packHlc(wallMs: number, counter: number, nodeId: string): string {
  if (!Number.isInteger(wallMs) || !Number.isSafeInteger(wallMs) || wallMs < 0) {
    throw new Error(`Invalid HLC wallMs: ${wallMs}`);
  }
  if (!Number.isInteger(counter) || counter < 0 || counter > MAX_COUNTER) {
    throw new Error(
      counter > MAX_COUNTER
        ? 'HLC logical counter overflow'
        : `Invalid HLC counter: ${counter}`,
    );
  }
  const normalizedNodeId = nodeId.toLowerCase();
  if (!NODE_ID_REGEX.test(normalizedNodeId)) {
    throw new Error(`Invalid HLC nodeId (expected 12 hex chars): ${nodeId}`);
  }

  const iso = new Date(wallMs).toISOString(); // Always 24 chars: YYYY-MM-DDTHH:mm:ss.sssZ
  const hexCounter = counter.toString(16).padStart(4, '0');
  return `${iso}-${hexCounter}-${normalizedNodeId}`;
}

/**
 * Unpacks a canonical 42-character HLC string into its components.
 */
export function unpackHlc(hlc: string): HlcState {
  if (!isValidHlc(hlc)) {
    throw new Error(`Invalid HLC format: ${hlc}`);
  }
  const iso = hlc.slice(0, 24);
  const counterHex = hlc.slice(25, 29);
  const nodeId = hlc.slice(30, 42);
  return {
    lastWallMs: Date.parse(iso),
    counter: parseInt(counterHex, 16),
    nodeId,
  };
}

/**
 * Lexicographically compares two canonical 42-character HLC strings.
 * Returns -1 if a < b, 0 if a === b, and 1 if a > b.
 */
export function compareHlc(a: string, b: string): -1 | 0 | 1 {
  if (!isValidHlc(a)) {
    throw new Error(`Invalid HLC format for 'a': ${a}`);
  }
  if (!isValidHlc(b)) {
    throw new Error(`Invalid HLC format for 'b': ${b}`);
  }
  if (a === b) return 0;
  return a > b ? 1 : -1;
}

/**
 * Computes the server clock offset (`server_now_ms - Date.now()`).
 */
export function computeServerTimeOffsetMs(serverNowMs: number, localNowMs: number): number {
  if (!Number.isSafeInteger(serverNowMs) || !Number.isSafeInteger(localNowMs)) {
    throw new Error('Server and local timestamps must be safe integers in milliseconds');
  }
  return serverNowMs - localNowMs;
}

/**
 * Computes the server-calibrated wall clock time (`Date.now() + offset_ms`).
 */
export function computeCorrectedNowMs(localNowMs: number, serverTimeOffsetMs: number): number {
  if (!Number.isSafeInteger(localNowMs) || !Number.isSafeInteger(serverTimeOffsetMs)) {
    throw new Error('Local timestamp and offset must be safe integers in milliseconds');
  }
  return localNowMs + serverTimeOffsetMs;
}

/**
 * Advances the local HLC for a local SQLite mutation event.
 * Never regresses below `state.lastWallMs` even if the local clock is rolled back.
 */
export function nextLocalHlc(
  state: HlcState,
  correctedNowMs: number,
): { hlc: string; nextState: HlcState } {
  if (!Number.isInteger(correctedNowMs) || !Number.isSafeInteger(correctedNowMs)) {
    throw new Error(`Invalid correctedNowMs: ${correctedNowMs}`);
  }

  if (correctedNowMs > state.lastWallMs) {
    const nextState: HlcState = {
      lastWallMs: correctedNowMs,
      counter: 0,
      nodeId: state.nodeId.toLowerCase(),
    };
    return {
      hlc: packHlc(nextState.lastWallMs, nextState.counter, nextState.nodeId),
      nextState,
    };
  }

  const nextCounter = state.counter + 1;
  if (nextCounter > MAX_COUNTER) {
    throw new Error('HLC logical counter overflow');
  }
  const nextState: HlcState = {
    lastWallMs: state.lastWallMs,
    counter: nextCounter,
    nodeId: state.nodeId.toLowerCase(),
  };
  return {
    hlc: packHlc(nextState.lastWallMs, nextState.counter, nextState.nodeId),
    nextState,
  };
}

/**
 * Updates the local HLC state upon receiving a remote HLC from the server/partner.
 */
export function receiveRemoteHlc(
  state: HlcState,
  remoteHlc: string,
  correctedNowMs: number,
): HlcState {
  if (!Number.isInteger(correctedNowMs) || !Number.isSafeInteger(correctedNowMs)) {
    throw new Error(`Invalid correctedNowMs: ${correctedNowMs}`);
  }

  const remote = unpackHlc(remoteHlc);
  const maxWall = Math.max(correctedNowMs, state.lastWallMs, remote.lastWallMs);

  let nextCounter = 0;
  if (maxWall === state.lastWallMs && maxWall === remote.lastWallMs) {
    nextCounter = Math.max(state.counter, remote.counter) + 1;
  } else if (maxWall === state.lastWallMs) {
    nextCounter = state.counter + 1;
  } else if (maxWall === remote.lastWallMs) {
    nextCounter = remote.counter + 1;
  }

  if (nextCounter > MAX_COUNTER) {
    throw new Error('HLC logical counter overflow');
  }

  return {
    lastWallMs: maxWall,
    counter: nextCounter,
    nodeId: state.nodeId.toLowerCase(),
  };
}

/**
 * Merges two versions of a synchronized domain record using Field-level Last-Write-Wins (LWW)
 * and Tombstone Precedence (`deletedAt !== null` always wins over concurrent edits).
 */
export function mergeRecordLww<
  T extends Record<string, unknown> & {
    hlcTimestamp: string;
    fieldHlc: FieldHlcMap;
    deletedAt: string | null;
  },
>(existing: T, incoming: T, mutableFields: readonly (keyof T & string)[]): T {
  const mergedFieldHlc: FieldHlcMap = { ...existing.fieldHlc };
  const merged: Record<string, unknown> = { ...existing };

  for (const field of mutableFields) {
    const existingFieldHlc = existing.fieldHlc[field] ?? existing.hlcTimestamp;
    const incomingFieldHlc = incoming.fieldHlc[field] ?? incoming.hlcTimestamp;

    if (compareHlc(incomingFieldHlc, existingFieldHlc) > 0) {
      merged[field] = incoming[field];
      mergedFieldHlc[field] = incomingFieldHlc;
    } else {
      mergedFieldHlc[field] = existingFieldHlc;
    }
  }

  // Tombstone Precedence: once soft-deleted on either replica, deletedAt remains non-null
  // using the latest tombstone timestamp.
  let mergedDeletedAt: string | null = null;
  if (existing.deletedAt !== null && incoming.deletedAt !== null) {
    mergedDeletedAt =
       existing.deletedAt >= incoming.deletedAt ? existing.deletedAt : incoming.deletedAt;
  } else if (existing.deletedAt !== null) {
    mergedDeletedAt = existing.deletedAt;
  } else if (incoming.deletedAt !== null) {
    mergedDeletedAt = incoming.deletedAt;
  }

  const maxHlcTimestamp =
    compareHlc(incoming.hlcTimestamp, existing.hlcTimestamp) > 0
      ? incoming.hlcTimestamp
      : existing.hlcTimestamp;

  return {
    ...(merged as T),
    deletedAt: mergedDeletedAt,
    hlcTimestamp: maxHlcTimestamp,
    fieldHlc: mergedFieldHlc,
  };
}
