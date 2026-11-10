/**
 * Google Drive REST API v3 Client
 * Strictly avoids `googleapis` library; uses native REST fetch with Bearer token authentication.
 * Targets the restricted `appDataFolder` space for secure couple backups.
 */

export const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
export const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';

export interface DriveFileMetadata {
  id: string;
  name: string;
  createdTime?: string;
  modifiedTime?: string;
  size?: number;
}

export interface UploadBackupOptions {
  accessToken: string;
  filename: string;
  content: Uint8Array;
  mimeType?: string;
  fetchFn?: typeof fetch;
}

export interface ListBackupsOptions {
  accessToken: string;
  fetchFn?: typeof fetch;
}

export interface DownloadBackupOptions {
  accessToken: string;
  fileId: string;
  fetchFn?: typeof fetch;
}

export interface DeleteBackupOptions {
  accessToken: string;
  fileId: string;
  fetchFn?: typeof fetch;
}

export interface RotateBackupsOptions {
  accessToken: string;
  keepCount?: number;
  fetchFn?: typeof fetch;
}

export interface RotationResult {
  totalFound: number;
  retainedFileIds: string[];
  deletedFileIds: string[];
}

/**
 * Uploads an encrypted backup file to the user's hidden Google Drive `appDataFolder`.
 * Uses a binary-safe multipart/related upload.
 */
export async function uploadBackupToDrive(
  options: UploadBackupOptions,
): Promise<DriveFileMetadata> {
  const {
    accessToken,
    filename,
    content,
    mimeType = 'application/octet-stream',
    fetchFn = fetch,
  } = options;

  if (!accessToken) {
    throw new Error('DRIVE_AUTH_ERROR: Missing Google Drive access token');
  }

  const boundary = `nosotros_boundary_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const metadata = JSON.stringify({
    name: filename,
    parents: ['appDataFolder'],
  });

  const encoder = new TextEncoder();
  const headerPart = encoder.encode(
    `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${metadata}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`,
  );
  const footerPart = encoder.encode(`\r\n--${boundary}--\r\n`);

  const multipartBody = new Uint8Array(
    headerPart.length + content.length + footerPart.length,
  );
  multipartBody.set(headerPart, 0);
  multipartBody.set(content, headerPart.length);
  multipartBody.set(footerPart, headerPart.length + content.length);

  const response = await fetchFn(
    `${DRIVE_UPLOAD_BASE}/files?uploadType=multipart`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: multipartBody,
    },
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(
      `DRIVE_UPLOAD_FAILED: HTTP ${response.status} - ${errorText}`,
    );
  }

  const json = (await response.json()) as { id: string; name: string };
  return {
    id: json.id,
    name: json.name,
  };
}

/**
 * Lists all backup files stored in the Google Drive `appDataFolder`,
 * ordered from newest to oldest by `createdTime`.
 */
export async function listBackupsFromDrive(
  options: ListBackupsOptions,
): Promise<DriveFileMetadata[]> {
  const { accessToken, fetchFn = fetch } = options;

  if (!accessToken) {
    throw new Error('DRIVE_AUTH_ERROR: Missing Google Drive access token');
  }

  const queryParams = new URLSearchParams({
    spaces: 'appDataFolder',
    fields: 'files(id, name, createdTime, modifiedTime, size)',
    orderBy: 'createdTime desc',
  });

  const response = await fetchFn(
    `${DRIVE_API_BASE}/files?${queryParams.toString()}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    },
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(
      `DRIVE_LIST_FAILED: HTTP ${response.status} - ${errorText}`,
    );
  }

  const data = (await response.json()) as {
    files?: {
      id: string;
      name: string;
      createdTime?: string;
      modifiedTime?: string;
      size?: string;
    }[];
  };

  return (data.files ?? []).map((f) => ({
    id: f.id,
    name: f.name,
    createdTime: f.createdTime,
    modifiedTime: f.modifiedTime,
    size: f.size ? parseInt(f.size, 10) : undefined,
  }));
}

/**
 * Downloads a backup file from Google Drive by its fileId, returning raw binary bytes.
 */
export async function downloadBackupFromDrive(
  options: DownloadBackupOptions,
): Promise<Uint8Array> {
  const { accessToken, fileId, fetchFn = fetch } = options;

  if (!accessToken) {
    throw new Error('DRIVE_AUTH_ERROR: Missing Google Drive access token');
  }
  if (!fileId) {
    throw new Error('DRIVE_INVALID_FILE_ID: fileId is required');
  }

  const response = await fetchFn(`${DRIVE_API_BASE}/files/${fileId}?alt=media`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(
      `DRIVE_DOWNLOAD_FAILED: HTTP ${response.status} - ${errorText}`,
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  return new Uint8Array(arrayBuffer);
}

/**
 * Permanently deletes a backup file from Google Drive.
 */
export async function deleteBackupFromDrive(
  options: DeleteBackupOptions,
): Promise<void> {
  const { accessToken, fileId, fetchFn = fetch } = options;

  if (!accessToken) {
    throw new Error('DRIVE_AUTH_ERROR: Missing Google Drive access token');
  }

  const response = await fetchFn(`${DRIVE_API_BASE}/files/${fileId}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok && response.status !== 404) {
    const errorText = await response.text().catch(() => '');
    throw new Error(
      `DRIVE_DELETE_FAILED: HTTP ${response.status} - ${errorText}`,
    );
  }
}

/**
 * Rotates backups in Google Drive to strictly preserve at most `keepCount` (default: 10).
 * Any excess older backups are deleted.
 */
export async function rotateDriveBackups(
  options: RotateBackupsOptions,
): Promise<RotationResult> {
  const { accessToken, keepCount = 10, fetchFn = fetch } = options;

  const files = await listBackupsFromDrive({ accessToken, fetchFn });

  // files are already sorted descending by createdTime
  const retained = files.slice(0, keepCount);
  const toDelete = files.slice(keepCount);

  const deletedFileIds: string[] = [];

  for (const file of toDelete) {
    await deleteBackupFromDrive({
      accessToken,
      fileId: file.id,
      fetchFn,
    });
    deletedFileIds.push(file.id);
  }

  return {
    totalFound: files.length,
    retainedFileIds: retained.map((f) => f.id),
    deletedFileIds,
  };
}
