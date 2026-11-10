import fs from 'fs';
import path from 'path';
import {
  uploadBackupToDrive,
  listBackupsFromDrive,
  downloadBackupFromDrive,
  deleteBackupFromDrive,
  rotateDriveBackups,
  DRIVE_API_BASE,
  DRIVE_UPLOAD_BASE,
} from '@/sync/googleDriveClient';
import {
  findEventByNosotrosId,
  upsertCalendarEvent,
  deleteCalendarEvent,
  syncRemindersToCalendar,
  CALENDAR_API_BASE,
} from '@/sync/googleCalendarClient';

describe('Google Clients — Drive appDataFolder & Calendar REST API (No googleapis)', () => {
  describe('1. Architectural Prohibition: googleapis Package', () => {
    it('verifies that googleapis package is NOT installed in package.json', () => {
      const packageJsonPath = path.resolve(__dirname, '../../package.json');
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      expect(deps.googleapis).toBeUndefined();
    });
  });

  describe('2. Google Drive appDataFolder REST Client', () => {
    const mockToken = 'mock-oauth-bearer-token-drive';

    it('uploads an encrypted backup file using multipart/related format to appDataFolder', async () => {
      const payloadBytes = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
      let capturedUrl = '';
      let capturedHeaders: Record<string, string> = {};
      let capturedBody: Uint8Array | null = null;

      const mockFetch: typeof fetch = async (input, init) => {
        capturedUrl = input.toString();
        capturedHeaders = (init?.headers as Record<string, string>) ?? {};
        capturedBody = init?.body as Uint8Array;

        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'file-drive-123', name: 'nosotros_backup.bin' }),
          text: async () => '',
        } as unknown as Response;
      };

      const result = await uploadBackupToDrive({
        accessToken: mockToken,
        filename: 'nosotros_backup.bin',
        content: payloadBytes,
        fetchFn: mockFetch,
      });

      expect(result.id).toBe('file-drive-123');
      expect(result.name).toBe('nosotros_backup.bin');
      expect(capturedUrl).toBe(`${DRIVE_UPLOAD_BASE}/files?uploadType=multipart`);
      expect(capturedHeaders.Authorization).toBe(`Bearer ${mockToken}`);
      expect(capturedHeaders['Content-Type']).toContain('multipart/related; boundary=');

      // Verify multipart body contains metadata with parents: ['appDataFolder']
      const bodyText = Buffer.from(capturedBody!).toString('utf-8');
      expect(bodyText).toContain('"parents":["appDataFolder"]');
      expect(bodyText).toContain('"name":"nosotros_backup.bin"');
    });

    it('lists backups in appDataFolder ordered by createdTime desc', async () => {
      let capturedUrl = '';
      const mockFiles = [
        { id: 'f2', name: 'bkp-2.bin', createdTime: '2026-11-10T12:00:00Z', size: '1024' },
        { id: 'f1', name: 'bkp-1.bin', createdTime: '2026-11-09T12:00:00Z', size: '1024' },
      ];

      const mockFetch: typeof fetch = async (input) => {
        capturedUrl = input.toString();
        return {
          ok: true,
          status: 200,
          json: async () => ({ files: mockFiles }),
        } as unknown as Response;
      };

      const list = await listBackupsFromDrive({
        accessToken: mockToken,
        fetchFn: mockFetch,
      });

      expect(capturedUrl).toContain('spaces=appDataFolder');
      expect(capturedUrl).toContain('orderBy=createdTime+desc');
      expect(list).toHaveLength(2);
      expect(list[0].id).toBe('f2');
      expect(list[0].size).toBe(1024);
    });

    it('downloads raw binary backup content', async () => {
      const fileData = new Uint8Array([0x41, 0x42, 0x43]);
      const mockFetch: typeof fetch = async (input) => {
        expect(input.toString()).toBe(`${DRIVE_API_BASE}/files/f123?alt=media`);
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => fileData.buffer,
        } as unknown as Response;
      };

      const downloaded = await downloadBackupFromDrive({
        accessToken: mockToken,
        fileId: 'f123',
        fetchFn: mockFetch,
      });

      expect(downloaded).toEqual(fileData);
    });

    it('rotates backups and retains at most keepCount (deletes excess older backups)', async () => {
      // 13 files existing, keepCount = 10 -> oldest 3 must be deleted
      const mockFiles = Array.from({ length: 13 }, (_, i) => ({
        id: `file-${i}`,
        name: `backup-${i}.bin`,
        createdTime: `2026-11-${String(20 - i).padStart(2, '0')}T00:00:00Z`,
      }));

      const deletedIds: string[] = [];
      const mockFetch: typeof fetch = async (input, init) => {
        const url = input.toString();
        if (url.includes('/files?spaces=appDataFolder')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ files: mockFiles }),
          } as unknown as Response;
        }
        if (init?.method === 'DELETE') {
          const match = url.match(/\/files\/([^?]+)/);
          if (match) {
            deletedIds.push(match[1]);
          }
          return { ok: true, status: 204 } as unknown as Response;
        }
        return { ok: false, status: 404 } as unknown as Response;
      };

      const rotation = await rotateDriveBackups({
        accessToken: mockToken,
        keepCount: 10,
        fetchFn: mockFetch,
      });

      expect(rotation.totalFound).toBe(13);
      expect(rotation.retainedFileIds).toHaveLength(10);
      expect(rotation.deletedFileIds).toHaveLength(3);
      // Older files are at the end (index 10, 11, 12)
      expect(rotation.deletedFileIds).toEqual(['file-10', 'file-11', 'file-12']);
      expect(deletedIds).toEqual(['file-10', 'file-11', 'file-12']);
    });
  });

  describe('3. Google Calendar Idempotent Reminder Upsert', () => {
    const mockToken = 'mock-oauth-bearer-token-cal';

    it('creates a new calendar event when no existing event matches nosotros_event_id', async () => {
      let createdBody: Record<string, unknown> | null = null;

      const mockFetch: typeof fetch = async (input, init) => {
        const url = input.toString();
        if (init?.method === 'GET' && url.includes('privateExtendedProperty=')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ items: [] }),
          } as unknown as Response;
        }
        if (init?.method === 'POST') {
          createdBody = JSON.parse(init.body as string);
          return {
            ok: true,
            status: 200,
            json: async () => ({ id: 'new-event-cal-1', ...createdBody }),
          } as unknown as Response;
        }
        return { ok: false, status: 404 } as unknown as Response;
      };

      const res = await upsertCalendarEvent({
        accessToken: mockToken,
        event: {
          summary: 'Fatura Nubank — Vencimento',
          description: 'Fatura de R$ 1.250,00',
          dueDate: '2026-11-20',
          nosotrosEventId: 'invoice:inv-nubank-nov',
        },
        fetchFn: mockFetch,
      });

      expect(res.action).toBe('CREATED');
      expect(res.event.id).toBe('new-event-cal-1');
      expect(createdBody).not.toBeNull();
      expect((createdBody as any).extendedProperties?.private?.nosotros_event_id).toBe(
        'invoice:inv-nubank-nov',
      );
    });

    it('updates an existing calendar event idempotently without duplicating', async () => {
      let putCalled = false;
      let putUrl = '';

      const mockFetch: typeof fetch = async (input, init) => {
        const url = input.toString();
        if (init?.method === 'GET' && url.includes('privateExtendedProperty=')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              items: [
                {
                  id: 'existing-event-999',
                  summary: 'Old summary',
                  start: { date: '2026-11-20' },
                  end: { date: '2026-11-20' },
                },
              ],
            }),
          } as unknown as Response;
        }
        if (init?.method === 'PUT') {
          putCalled = true;
          putUrl = url;
          const body = JSON.parse(init.body as string);
          return {
            ok: true,
            status: 200,
            json: async () => ({ id: 'existing-event-999', ...body }),
          } as unknown as Response;
        }
        return { ok: false, status: 404 } as unknown as Response;
      };

      const res = await upsertCalendarEvent({
        accessToken: mockToken,
        event: {
          summary: 'Fatura Nubank Atualizada',
          dueDate: '2026-11-20',
          nosotrosEventId: 'invoice:inv-nubank-nov',
        },
        fetchFn: mockFetch,
      });

      expect(res.action).toBe('UPDATED');
      expect(putCalled).toBe(true);
      expect(putUrl).toBe(`${CALENDAR_API_BASE}/calendars/primary/events/existing-event-999`);
    });

    it('syncs multiple reminders and summarizes results', async () => {
      const mockFetch: typeof fetch = async (input, init) => {
        const url = input.toString();
        if (init?.method === 'GET') {
          return {
            ok: true,
            status: 200,
            json: async () => ({ items: [] }),
          } as unknown as Response;
        }
        if (init?.method === 'POST') {
          return {
            ok: true,
            status: 200,
            json: async () => ({ id: `event-${Math.random()}` }),
          } as unknown as Response;
        }
        return { ok: false, status: 404 } as unknown as Response;
      };

      const summary = await syncRemindersToCalendar({
        accessToken: mockToken,
        reminders: [
          {
            summary: 'Aluguel do Mês',
            dueDate: '2026-11-05',
            nosotrosEventId: 'recurring:rule-rent:2026-11',
          },
          {
            summary: 'Conta de Energia Elétrica',
            dueDate: '2026-11-15',
            nosotrosEventId: 'recurring:rule-power:2026-11',
          },
        ],
        fetchFn: mockFetch,
      });

      expect(summary.total).toBe(2);
      expect(summary.created).toBe(2);
      expect(summary.failed).toBe(0);
    });
  });
});
