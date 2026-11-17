import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDriveFilesQuery,
  buildMultipartUploadPayload,
  extractDriveFolderId,
  formatFileSize,
  LINKED_DRIVE_FOLDER_ID,
  LINKED_DRIVE_FOLDER_URL,
  orderAndAssign360Degrees,
  orderImagesForStudioViews,
  sampleDriveCatalogViews,
  type DriveFileItem,
} from './googleDriveApi';

test('extractDriveFolderId parses Drive folder links, query IDs, raw IDs, and rejects invalid text', () => {
  assert.equal(extractDriveFolderId(LINKED_DRIVE_FOLDER_URL), LINKED_DRIVE_FOLDER_ID);
  assert.equal(
    extractDriveFolderId('https://drive.google.com/drive/u/1/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz'),
    '1AbCdEfGhIjKlMnOpQrStUvWxYz',
  );
  assert.equal(
    extractDriveFolderId('https://drive.google.com/open?id=1AbCdEfGhIjKlMnOpQrStUvWxYz'),
    '1AbCdEfGhIjKlMnOpQrStUvWxYz',
  );
  assert.equal(extractDriveFolderId(LINKED_DRIVE_FOLDER_ID), LINKED_DRIVE_FOLDER_ID);
  assert.equal(extractDriveFolderId(''), null);
  assert.equal(extractDriveFolderId('no es un enlace valido'), null);
});

test('buildDriveFilesQuery builds filtered queries, folder scoping, and sanitizes quotes', () => {
  assert.equal(
    buildDriveFilesQuery('', 'all'),
    "trashed = false and mimeType != 'application/vnd.google-apps.folder'",
  );

  const folderAllQ = buildDriveFilesQuery('', 'all', LINKED_DRIVE_FOLDER_ID);
  assert.equal(folderAllQ, `trashed = false and '${LINKED_DRIVE_FOLDER_ID}' in parents`);

  const folderImagesQ = buildDriveFilesQuery('vista', 'images', LINKED_DRIVE_FOLDER_ID);
  assert.ok(folderImagesQ.includes(`'${LINKED_DRIVE_FOLDER_ID}' in parents`));
  assert.ok(folderImagesQ.includes("mimeType contains 'image/'"));
  assert.ok(folderImagesQ.includes("name contains 'vista'"));

  const modelsQ = buildDriveFilesQuery("avatar'3d", 'models');
  assert.ok(modelsQ.includes("name contains '.glb'"));
  assert.ok(modelsQ.includes("name contains 'avatar3d'"));
  assert.ok(!modelsQ.includes("avatar'3d"));
});

test('buildMultipartUploadPayload creates valid multipart/related body with metadata, parents, and binary blob', async () => {
  const sampleBlob = new Blob(['obj-content'], { type: 'text/plain' });
  const { body, contentTypeHeader } = buildMultipartUploadPayload(
    { name: 'modelo.obj', mimeType: 'text/plain', parents: [LINKED_DRIVE_FOLDER_ID] },
    sampleBlob,
    'TESTBOUNDARY',
  );

  assert.equal(contentTypeHeader, 'multipart/related; boundary="TESTBOUNDARY"');
  const text = await body.text();
  assert.ok(text.includes('--TESTBOUNDARY'));
  assert.ok(text.includes('"name":"modelo.obj"'));
  assert.ok(text.includes(`"parents":["${LINKED_DRIVE_FOLDER_ID}"]`));
  assert.ok(text.includes('obj-content'));
  assert.ok(text.endsWith('--TESTBOUNDARY--'));
});

test('orderImagesForStudioViews orders 8 profile photos by angular hint and ignores non-images', () => {
  const unsorted: DriveFileItem[] = [
    { id: '9', name: 'readme.txt', mimeType: 'text/plain' },
    { id: '6', name: 'vista_242_3f101735.png', mimeType: 'image/png' },
    { id: '1', name: 'vista_046_7101a34c.png', mimeType: 'image/png' },
    { id: '8', name: 'vista_278_de015d9f.png', mimeType: 'image/png' },
    { id: '0', name: 'vista_000_83139bbb.png', mimeType: 'image/png' },
    { id: '4', name: 'vista_163_4b1df61c.png', mimeType: 'image/png' },
    { id: '2', name: 'vista_087_7366bcdb.png', mimeType: 'image/png' },
    { id: '5', name: 'vista_201_15ac99d8.png', mimeType: 'image/png' },
    { id: '3', name: 'vista_127_1f931038.png', mimeType: 'image/png' },
  ];

  const ordered = orderImagesForStudioViews(unsorted);
  assert.equal(ordered.length, 8);
  assert.deepEqual(
    ordered.map((f) => f.id),
    ['0', '1', '2', '3', '4', '5', '6', '8'],
  );
});

test('orderAndAssign360Degrees and sampleDriveCatalogViews map 360 1-degree photos accurately', () => {
  const files360: DriveFileItem[] = [];
  for (let d = 359; d >= 0; d--) {
    files360.push({
      id: `id-${d}`,
      name: `vista_${String(d).padStart(3, '0')}.png`,
      mimeType: 'image/png',
    });
  }

  const catalog = orderAndAssign360Degrees(files360);
  assert.equal(catalog.length, 360);
  assert.equal(catalog[0].azimuthDeg, 0);
  assert.equal(catalog[90].azimuthDeg, 90);
  assert.equal(catalog[180].azimuthDeg, 180);
  assert.equal(catalog[359].azimuthDeg, 359);

  const sampled36 = sampleDriveCatalogViews(catalog, 36);
  assert.equal(sampled36.length, 36);
  assert.equal(sampled36[0].azimuthDeg, 0);
  assert.equal(sampled36[9].azimuthDeg, 90);
  assert.equal(sampled36[18].azimuthDeg, 180);
  assert.equal(sampled36[27].azimuthDeg, 270);
  assert.equal(sampled36[35].azimuthDeg, 350);

  const sampledAll = sampleDriveCatalogViews(catalog, 360);
  assert.equal(sampledAll.length, 360);
});

test('formatFileSize formats bytes, KB, and MB cleanly', () => {
  assert.equal(formatFileSize(undefined), '—');
  assert.equal(formatFileSize('512'), '512 B');
  assert.equal(formatFileSize('2048'), '2.0 KB');
  assert.equal(formatFileSize(String(3 * 1024 * 1024)), '3.00 MB');
});
