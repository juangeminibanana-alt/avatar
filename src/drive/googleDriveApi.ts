export type DriveFileCategory = 'all' | 'models' | 'images';

export const LINKED_DRIVE_FOLDER_ID = '11tJYmnsS3YawWar60ZTzkPQzRgl-lwbI';
export const LINKED_DRIVE_FOLDER_URL =
  'https://drive.google.com/drive/folders/11tJYmnsS3YawWar60ZTzkPQzRgl-lwbI?usp=drive_link';
export const DRIVE_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

export interface DriveFileItem {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  webViewLink?: string;
  iconLink?: string;
  thumbnailLink?: string;
}

export interface ListDriveFilesResult {
  files: DriveFileItem[];
}

export function extractDriveFolderId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const folderPathMatch = trimmed.match(/\/folders\/([a-zA-Z0-9_-]{10,})/);
  if (folderPathMatch?.[1]) {
    return folderPathMatch[1];
  }

  const queryIdMatch = trimmed.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
  if (queryIdMatch?.[1]) {
    return queryIdMatch[1];
  }

  if (/^[a-zA-Z0-9_-]{10,64}$/.test(trimmed)) {
    return trimmed;
  }

  return null;
}

function extractAngleHint(filename: string): number | null {
  const withoutExt = filename.replace(/\.[^.]+$/, '');
  const namedMatch = withoutExt.match(
    /(?:vista|view|perfil|angle|angulo|foto|img)[_-]?(\d{1,3})(?=[_.-]|$)/i,
  );
  if (namedMatch?.[1]) {
    const val = Number(namedMatch[1]);
    if (Number.isFinite(val) && val <= 360) return val;
  }

  const tokenMatches = withoutExt.match(/(?:^|[^0-9])(\d{1,3})(?=[^0-9]|$)/g);
  if (tokenMatches) {
    for (const raw of tokenMatches) {
      const digits = raw.replace(/[^0-9]/g, '');
      const val = Number(digits);
      if (Number.isFinite(val) && val <= 360) {
        return val;
      }
    }
  }
  return null;
}

export function orderImagesForStudioViews(files: DriveFileItem[]): DriveFileItem[] {
  const images = files.filter((f) => f.mimeType.startsWith('image/'));
  if (images.length <= 1) return images;

  const withHints = images.map((file) => ({
    file,
    hint: extractAngleHint(file.name),
  }));

  const hintedCount = withHints.filter((item) => item.hint !== null).length;
  if (hintedCount === images.length) {
    return [...withHints]
      .sort((a, b) => {
        const diff = (a.hint ?? 0) - (b.hint ?? 0);
        if (diff !== 0) return diff;
        return a.file.name.localeCompare(b.file.name, undefined, {
          numeric: true,
          sensitivity: 'base',
        });
      })
      .map((item) => item.file);
  }

  return [...images].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
  );
}

export function formatFileSize(sizeStr?: string): string {
  if (!sizeStr) return '—';
  const bytes = Number(sizeStr);
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function buildDriveFilesQuery(
  searchText: string,
  category: DriveFileCategory,
  folderId?: string | null,
): string {
  const clauses = ['trashed = false'];
  const cleanFolderId = folderId ? folderId.trim().replace(/[^a-zA-Z0-9_-]/g, '') : '';

  if (cleanFolderId) {
    clauses.push(`'${cleanFolderId}' in parents`);
  }

  if (category === 'models') {
    clauses.push(
      "(name contains '.glb' or name contains '.gltf' or name contains '.obj' or mimeType = 'model/gltf-binary')",
    );
  } else if (category === 'images') {
    clauses.push("mimeType contains 'image/'");
  } else if (!cleanFolderId) {
    clauses.push(`mimeType != '${DRIVE_FOLDER_MIME_TYPE}'`);
  }

  const trimmed = searchText.trim().replace(/['\\]/g, '');
  if (trimmed.length > 0) {
    clauses.push(`name contains '${trimmed}'`);
  }

  return clauses.join(' and ');
}

export function buildMultipartUploadPayload(
  metadata: { name: string; mimeType: string; parents?: string[] },
  contentBlob: Blob,
  boundary = '-------314159265358979323846',
): { body: Blob; contentTypeHeader: string } {
  const metadataPayload: { name: string; mimeType: string; parents?: string[] } = {
    name: metadata.name,
    mimeType: metadata.mimeType,
  };
  if (metadata.parents && metadata.parents.length > 0) {
    metadataPayload.parents = metadata.parents;
  }
  const metadataJson = JSON.stringify(metadataPayload);

  const prefix =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${metadataJson}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${metadata.mimeType}\r\n\r\n`;
  const suffix = `\r\n--${boundary}--`;

  return {
    body: new Blob([prefix, contentBlob, suffix]),
    contentTypeHeader: `multipart/related; boundary="${boundary}"`,
  };
}

async function parseDriveError(res: Response, fallbackMsg: string): Promise<Error> {
  if (res.status === 401) {
    return new Error('AUTH_EXPIRED');
  }
  try {
    const json = (await res.json()) as { error?: { message?: string } };
    return new Error(json.error?.message || fallbackMsg);
  } catch {
    return new Error(fallbackMsg);
  }
}

export async function getDriveFileMetadata(
  accessToken: string,
  fileId: string,
): Promise<DriveFileItem> {
  const params = new URLSearchParams({
    fields: 'id,name,mimeType,webViewLink',
    supportsAllDrives: 'true',
  });
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?${params.toString()}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );

  if (!res.ok) {
    throw await parseDriveError(res, 'No se pudo obtener la información de la carpeta en Drive.');
  }

  return (await res.json()) as DriveFileItem;
}

export async function listDriveFiles(
  accessToken: string,
  searchText = '',
  category: DriveFileCategory = 'all',
  pageSize = 50,
  folderId?: string | null,
): Promise<ListDriveFilesResult> {
  const q = buildDriveFilesQuery(searchText, category, folderId);
  const params = new URLSearchParams({
    q,
    pageSize: String(pageSize),
    orderBy: folderId ? 'folder,modifiedTime desc' : 'modifiedTime desc',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
    fields: 'files(id,name,mimeType,size,modifiedTime,webViewLink,iconLink,thumbnailLink)',
  });

  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    throw await parseDriveError(res, 'No se pudieron listar los archivos de Google Drive.');
  }

  const data = (await res.json()) as { files?: DriveFileItem[] };
  return { files: data.files ?? [] };
}

export interface DriveCatalogViewItem {
  file: DriveFileItem;
  azimuthDeg: number;
  label: string;
  shortLabel: string;
}

export function orderAndAssign360Degrees(files: DriveFileItem[]): DriveCatalogViewItem[] {
  const images = files.filter((f) => f.mimeType.startsWith('image/'));
  if (images.length === 0) return [];

  const extracted = images.map((file) => ({
    file,
    hint: extractAngleHint(file.name),
  }));

  const hinted = extracted.filter((e) => e.hint !== null);
  const uniqueHints = new Set(hinted.map((e) => e.hint));

  // If >= 80% of images carry distinct numeric hints in 0..360, sort by hint and compute exact degrees
  if (hinted.length >= Math.max(2, Math.floor(images.length * 0.8)) && uniqueHints.size >= Math.floor(images.length * 0.8)) {
    const sorted = [...extracted].sort((a, b) => {
      const ha = a.hint ?? 999;
      const hb = b.hint ?? 999;
      if (ha !== hb) return ha - hb;
      return a.file.name.localeCompare(b.file.name, undefined, { numeric: true, sensitivity: 'base' });
    });

    const minHint = Math.min(...hinted.map((h) => h.hint!));
    const maxHint = Math.max(...hinted.map((h) => h.hint!));
    const isOneIndexed360 = minHint === 1 && maxHint === 360;
    const isSequentialCount =
      images.length >= 16 &&
      maxHint <= images.length &&
      minHint >= 0 &&
      maxHint < 355 &&
      images.length !== 360;

    return sorted.map((item, idx) => {
      let deg: number;
      if (item.hint !== null && !isSequentialCount) {
        deg = isOneIndexed360 ? (item.hint - 1) % 360 : item.hint % 360;
      } else {
        deg = (idx * 360) / sorted.length;
      }
      const rounded = Math.round(deg * 10) / 10;
      return {
        file: item.file,
        azimuthDeg: rounded,
        label: `Perfil ${Math.round(deg)}°`,
        shortLabel: `${Math.round(deg)}°`,
      };
    });
  }

  const naturalSorted = [...images].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
  );
  return naturalSorted.map((file, idx) => {
    const deg = (idx * 360) / naturalSorted.length;
    const rounded = Math.round(deg * 10) / 10;
    return {
      file,
      azimuthDeg: rounded,
      label: `Perfil ${Math.round(deg)}°`,
      shortLabel: `${Math.round(deg)}°`,
    };
  });
}

export function sampleDriveCatalogViews(
  catalog: DriveCatalogViewItem[],
  targetCount: number,
): DriveCatalogViewItem[] {
  if (catalog.length === 0) return [];
  const count = Math.max(1, Math.min(targetCount, catalog.length));
  if (count >= catalog.length) return [...catalog];

  const used = new Set<number>();
  const picked: DriveCatalogViewItem[] = [];
  for (let i = 0; i < count; i++) {
    const targetDeg = (i * 360) / count;
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let j = 0; j < catalog.length; j++) {
      if (used.has(j)) continue;
      const diff = Math.abs(((catalog[j].azimuthDeg - targetDeg + 540) % 360) - 180);
      if (diff < bestDist) {
        bestDist = diff;
        bestIdx = j;
      }
    }
    if (bestIdx >= 0) {
      used.add(bestIdx);
      picked.push(catalog[bestIdx]);
    }
  }
  return picked.sort((a, b) => a.azimuthDeg - b.azimuthDeg);
}

export async function listAllDriveImagesInFolder(
  accessToken: string,
  folderId: string,
  onProgressCount?: (count: number) => void,
): Promise<DriveFileItem[]> {
  const cleanFolderId = folderId.trim().replace(/[^a-zA-Z0-9_-]/g, '');
  const q = `trashed = false and '${cleanFolderId}' in parents and mimeType contains 'image/'`;
  const allFiles: DriveFileItem[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      q,
      pageSize: '1000',
      orderBy: 'name',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink)',
    });
    if (pageToken) {
      params.set('pageToken', pageToken);
    }

    const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      throw await parseDriveError(res, 'No se pudieron listar las imágenes de la carpeta en Drive.');
    }

    const data = (await res.json()) as {
      nextPageToken?: string;
      files?: DriveFileItem[];
    };
    if (data.files?.length) {
      allFiles.push(...data.files);
      onProgressCount?.(allFiles.length);
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  return allFiles;
}

export async function uploadFileToDrive(
  accessToken: string,
  params: { name: string; mimeType: string; blob: Blob; parentId?: string | null },
): Promise<DriveFileItem> {
  const { body, contentTypeHeader } = buildMultipartUploadPayload(
    {
      name: params.name,
      mimeType: params.mimeType,
      parents: params.parentId ? [params.parentId] : undefined,
    },
    params.blob,
  );

  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,mimeType,size,modifiedTime,webViewLink',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': contentTypeHeader,
      },
      body,
    },
  );

  if (!res.ok) {
    throw await parseDriveError(res, 'No se pudo subir el archivo a Google Drive.');
  }

  return (await res.json()) as DriveFileItem;
}

export async function overwriteDriveFile(
  accessToken: string,
  fileId: string,
  blob: Blob,
  mimeType: string,
): Promise<DriveFileItem> {
  const res = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media&supportsAllDrives=true&fields=id,name,mimeType,size,modifiedTime,webViewLink`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': mimeType,
      },
      body: blob,
    },
  );

  if (!res.ok) {
    throw await parseDriveError(res, 'No se pudo actualizar el archivo en Google Drive.');
  }

  return (await res.json()) as DriveFileItem;
}

export async function downloadDriveFileBlob(
  accessToken: string,
  fileId: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal,
    },
  );

  if (!res.ok) {
    throw await parseDriveError(res, 'No se pudo descargar el archivo desde Google Drive.');
  }

  return res.blob();
}

export async function deleteDriveFile(accessToken: string, fileId: string): Promise<void> {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );

  if (!res.ok) {
    throw await parseDriveError(res, 'No se pudo eliminar el archivo de Google Drive.');
  }
}
