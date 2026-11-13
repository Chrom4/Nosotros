/**
 * @jest-environment node
 */
import { InMemorySyncServer } from './inMemorySyncServer';
import { registerServerScenarios } from './syncScenarios';

// Applies batches exactly as received (no server-side re-sort) so FK checks prove client ordering.
const server = new InMemorySyncServer({ sortBatch: false });

registerServerScenarios('In-memory server (TEST-SYNC-A..EF)', () => server);
