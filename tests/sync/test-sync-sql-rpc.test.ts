/**
 * @jest-environment node
 */
import { PgliteSyncServer } from './pgliteSyncServer';
import { registerServerScenarios } from './syncScenarios';

let server: PgliteSyncServer;

beforeAll(async () => {
  server = await PgliteSyncServer.create();
}, 60_000);

afterAll(async () => {
  await server.close();
});

// Same scenarios, but against the real sync_push_batch / sync_pull_changes SQL (migrations 0001-0004).
registerServerScenarios('Real SQL RPCs on PGlite (TEST-SYNC-A..EF)', () => server);
