import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVisualHullMesh,
  compute2DSdf,
  computeSmoothNormals,
  createCalibratedViews,
  extractMarchingCubesMesh,
  filterSmallMeshComponents,
  segmentStudioForeground,
  taubinSmoothMesh,
  type SegmentationResult,
} from './sdfAndHull';
import { buildGlbBuffer, buildObjString } from './exporters';
import { STUDIO_VIEWS } from './types';

test('segmentStudioForeground isolates centered dark subject from light gray studio backdrop', () => {
  const w = 64;
  const h = 96;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const isSubject = x >= 22 && x <= 42 && y >= 12 && y <= 84;
      rgba[i] = isSubject ? 30 : 210;
      rgba[i + 1] = isSubject ? 28 : 204;
      rgba[i + 2] = isSubject ? 32 : 202;
      rgba[i + 3] = 255;
    }
  }

  const seg = segmentStudioForeground(rgba, w, h);
  assert.ok(seg.yTop >= 11 && seg.yTop <= 13);
  assert.ok(seg.yBottom >= 83 && seg.yBottom <= 85);
  assert.ok(Math.abs(seg.spineCenterX - 32) <= 1.5);
  assert.equal(seg.mask[48 * w + 32], 1);
  assert.equal(seg.mask[48 * w + 5], 0);
});

test('compute2DSdf returns negative inside and positive outside', () => {
  const w = 32;
  const h = 32;
  const mask = new Uint8Array(w * h);
  for (let y = 10; y <= 22; y++) {
    for (let x = 10; x <= 22; x++) {
      mask[y * w + x] = 1;
    }
  }
  const sdf = compute2DSdf(mask, w, h, 0.01);
  assert.ok(sdf[16 * w + 16] < -0.04, 'center should be strictly negative');
  assert.ok(sdf[2 * w + 2] > 0.08, 'corner should be strictly positive');
});

test('extractMarchingCubesMesh produces outward-facing normals on a sphere SDF', () => {
  const nx = 24;
  const ny = 24;
  const nz = 24;
  const bounds = { minX: -1, maxX: 1, minY: -1, maxY: 1, minZ: -1, maxZ: 1 };
  const field = new Float32Array(nx * ny * nz);
  const r = 0.6;

  for (let iy = 0; iy < ny; iy++) {
    const y = -1 + (2 * iy) / (ny - 1);
    for (let iz = 0; iz < nz; iz++) {
      const z = -1 + (2 * iz) / (nz - 1);
      for (let ix = 0; ix < nx; ix++) {
        const x = -1 + (2 * ix) / (nx - 1);
        field[iy * nx * nz + iz * nx + ix] = Math.hypot(x, y, z) - r;
      }
    }
  }

  const raw = extractMarchingCubesMesh(field, nx, ny, nz, bounds);
  assert.ok(raw.vertexCount > 100);
  assert.ok(raw.indices.length > 300);

  taubinSmoothMesh(raw.positions, raw.indices, 2);
  const normals = computeSmoothNormals(raw.positions, raw.indices);

  // Verify normals point outward (dot(normal, position) > 0) and no NaNs
  let dotSum = 0;
  for (let i = 0; i < raw.vertexCount; i++) {
    const px = raw.positions[i * 3];
    const py = raw.positions[i * 3 + 1];
    const pz = raw.positions[i * 3 + 2];
    const nxv = normals[i * 3];
    const nyv = normals[i * 3 + 1];
    const nzv = normals[i * 3 + 2];
    assert.ok(Number.isFinite(nxv) && Number.isFinite(nyv) && Number.isFinite(nzv));
    dotSum += px * nxv + py * nyv + pz * nzv;
  }
  assert.ok(dotSum > 0, `expected outward normals, got dotSum=${dotSum}`);
});

test('filterSmallMeshComponents removes tiny floating specks while preserving primary mesh', () => {
  const nx = 24;
  const ny = 24;
  const nz = 24;
  const bounds = { minX: -1, maxX: 1, minY: -1, maxY: 1, minZ: -1, maxZ: 1 };
  const field = new Float32Array(nx * ny * nz);

  const step = 2 / (nx - 1);
  const speckX = -1 + 19 * step;
  const speckY = -1 + 3 * step;
  const speckZ = -1 + 12 * step;

  for (let iy = 0; iy < ny; iy++) {
    const y = -1 + iy * step;
    for (let iz = 0; iz < nz; iz++) {
      const z = -1 + iz * step;
      for (let ix = 0; ix < nx; ix++) {
        const x = -1 + ix * step;
        const mainSphere = Math.hypot(x, y - 0.15, z) - 0.45;
        const tinySpeck = Math.hypot(x - speckX, y - speckY, z - speckZ) - 0.07;
        field[iy * nx * nz + iz * nx + ix] = Math.min(mainSphere, tinySpeck);
      }
    }
  }

  const raw = extractMarchingCubesMesh(field, nx, ny, nz, bounds);
  const filtered = filterSmallMeshComponents(raw.positions, raw.indices);
  assert.ok(filtered.vertexCount > 100);
  assert.ok(filtered.vertexCount < raw.vertexCount, 'expected tiny speck vertices to be removed');
  for (let i = 0; i < filtered.vertexCount; i++) {
    assert.ok(filtered.positions[i * 3 + 1] > -0.45, 'expected no vertices remaining at bottom speck');
  }
});

test('buildVisualHullMesh preserves unshifted SDF alignment, separates legs, and exports grounded GLB & OBJ', () => {
  const w = 48;
  const h = 80;
  const segs: SegmentationResult[] = STUDIO_VIEWS.map((_, idx) => {
    const mask = new Uint8Array(w * h);
    const isSide = idx === 2 || idx === 6;
    for (let y = 8; y < 74; y++) {
      for (let x = 0; x < w; x++) {
        if (y < 44) {
          const halfW = isSide ? 7 : 12;
          if (Math.abs(x - 24) <= halfW) mask[y * w + x] = 1;
        } else {
          if (isSide) {
            if (Math.abs(x - 24) <= 5) mask[y * w + x] = 1;
          } else {
            if ((x >= 14 && x <= 20) || (x >= 28 && x <= 34)) {
              mask[y * w + x] = 1;
            }
          }
        }
      }
    }
    return {
      mask,
      yTop: 8,
      yBottom: 73,
      minX: 12,
      maxX: 36,
      spineCenterX: 24,
    };
  });

  const { views, camParams } = createCalibratedViews(STUDIO_VIEWS, segs, w, h);
  const mesh = buildVisualHullMesh(views, camParams, { nx: 28, ny: 48, nz: 28 }, 2);

  assert.ok(mesh.vertexCount > 200);
  assert.ok(mesh.triangleCount > 200);
  // Top of mesh should stay aligned near subjectHeight (1.78m) rather than shifting downward
  assert.ok(mesh.bounds.maxY > 1.72 && mesh.bounds.maxY < 1.85);

  // Verify the gap between the legs near ankle height (y ~ 0.25) has NO vertices around x = 0
  let centerLegVerts = 0;
  for (let i = 0; i < mesh.vertexCount; i++) {
    const x = mesh.positions[i * 3];
    const y = mesh.positions[i * 3 + 1];
    if (y > 0.15 && y < 0.45 && Math.abs(x) < 0.03) {
      centerLegVerts++;
    }
  }
  assert.equal(centerLegVerts, 0, 'expected legs to remain cleanly separated');

  // Verify GLB binary header & chunks
  const fakePng = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const glb = buildGlbBuffer(mesh, fakePng);
  const dv = new DataView(glb);
  assert.equal(dv.getUint32(0, true), 0x46546c67); // glTF magic
  assert.equal(dv.getUint32(4, true), 2);
  assert.equal(dv.getUint32(8, true), glb.byteLength);
  assert.equal(dv.getUint32(16, true), 0x4e4f534a); // JSON

  // Verify OBJ output
  const obj = buildObjString(mesh);
  assert.ok(obj.includes('v ') && obj.includes('vn ') && obj.includes('f '));
});

test('anatomical SDF separates arms from torso, eliminates crotch webs, grounds boots, and outputs valid partWeights', () => {
  const w = 90;
  const h = 160;
  // Build synthetic 8-view human silhouettes matching real 3-interval arm/torso & 2-interval leg topology
  const segs: SegmentationResult[] = STUDIO_VIEWS.map((_, idx) => {
    const mask = new Uint8Array(w * h);
    const isSide = idx === 2 || idx === 6;
    const yTop = 16;
    const yBot = 148;
    const span = yBot - yTop;
    const cx = 45;

    for (let y = yTop; y <= yBot; y++) {
      const t = (y - yTop) / span;
      for (let x = 0; x < w; x++) {
        const dx = x - cx;
        if (t < 0.17) {
          // Head & cap
          if (Math.abs(dx) <= (isSide ? 7 : 5)) mask[y * w + x] = 1;
        } else if (t < 0.32) {
          // Shoulders
          const half = isSide ? 8 : Math.round(6 + ((t - 0.17) / 0.15) * 12);
          if (Math.abs(dx) <= half) mask[y * w + x] = 1;
        } else if (t < 0.56) {
          if (isSide) {
            if (Math.abs(dx) <= 8) mask[y * w + x] = 1;
          } else {
            // 3 distinct intervals: right arm [-18..-14], torso [-10..+10], left arm [+14..+18]
            const inRightArm = dx >= -18 && dx <= -14;
            const inTorso = Math.abs(dx) <= 10;
            const inLeftArm = dx >= 14 && dx <= 18;
            if (inRightArm || inTorso || inLeftArm) mask[y * w + x] = 1;
          }
        } else {
          if (isSide) {
            const frontExt = t > 0.90 ? 11 : 6;
            if (dx >= -6 && dx <= frontExt) mask[y * w + x] = 1;
          } else {
            // 2 distinct leg intervals
            if ((dx >= -12 && dx <= -3) || (dx >= 3 && dx <= 12)) {
              mask[y * w + x] = 1;
            }
          }
        }
      }
    }

    return {
      mask,
      yTop,
      yBottom: yBot,
      minX: cx - 18,
      maxX: cx + 18,
      spineCenterX: cx,
      headCenterX: cx,
    };
  });

  const { views, camParams } = createCalibratedViews(STUDIO_VIEWS, segs, w, h);
  const mesh = buildVisualHullMesh(views, camParams, { nx: 52, ny: 96, nz: 48 }, 2);

  assert.ok(mesh.partWeights && mesh.partWeights.length === mesh.vertexCount * 4);
  assert.ok(mesh.bounds.minY >= 0 && mesh.bounds.minY < 0.015, `expected boots grounded near 0, got ${mesh.bounds.minY}`);
  assert.ok(mesh.bounds.maxY > 1.72 && mesh.bounds.maxY < 1.82);

  // Verify clean air gap between torso and arms at y = 0.90..1.10 (around |x| in [0.165..0.195])
  let gapArmVerts = 0;
  let crotchGapVerts = 0;
  let headMatches = 0;
  let torsoMatches = 0;
  let rArmMatches = 0;
  let lArmMatches = 0;

  for (let i = 0; i < mesh.vertexCount; i++) {
    const px = mesh.positions[i * 3];
    const py = mesh.positions[i * 3 + 1];
    const wH = mesh.partWeights[i * 4];
    const wT = mesh.partWeights[i * 4 + 1];
    const wR = mesh.partWeights[i * 4 + 2];
    const wL = mesh.partWeights[i * 4 + 3];
    const wSum = wH + wT + wR + wL;
    assert.ok(wH >= 0 && wT >= 0 && wR >= 0 && wL >= 0 && wSum <= 1.0001);

    if (py > 0.88 && py < 1.12 && Math.abs(px) > 0.148 && Math.abs(px) < 0.174) {
      gapArmVerts++;
    }
    if (py > 0.25 && py < 0.66 && Math.abs(px) < 0.025) {
      crotchGapVerts++;
    }
    if (py > 1.56 && wH > 0.7) headMatches++;
    if (py > 0.90 && py < 1.25 && Math.abs(px) < 0.12 && wT > 0.7) torsoMatches++;
    if (py > 0.82 && py < 1.20 && px < -0.20 && wR > 0.7) rArmMatches++;
    if (py > 0.82 && py < 1.20 && px > 0.20 && wL > 0.7) lArmMatches++;
  }

  assert.equal(gapArmVerts, 0, 'expected clean air gap between arms and torso');
  assert.equal(crotchGapVerts, 0, 'expected clean separation between legs with zero crotch web');
  assert.ok(headMatches > 20 && torsoMatches > 20 && rArmMatches > 10 && lArmMatches > 10);
});

test('buildVisualHullMesh supports 36-view 360° reconstruction with dense hull carving and 36 depth maps', () => {
  const w = 64;
  const h = 112;
  const specs36 = Array.from({ length: 36 }, (_, idx) => {
    const deg = idx * 10;
    return {
      id: `v_${deg}`,
      url: '',
      azimuthDeg: deg,
      label: `Perfil ${deg}°`,
      shortLabel: `${deg}°`,
    };
  });

  const segs: SegmentationResult[] = specs36.map((spec) => {
    const mask = new Uint8Array(w * h);
    const rad = (spec.azimuthDeg * Math.PI) / 180;
    const isSideFactor = Math.abs(Math.sin(rad));
    const yTop = 10;
    const yBot = 102;
    const span = yBot - yTop;
    const cx = 32;

    for (let y = yTop; y <= yBot; y++) {
      const t = (y - yTop) / span;
      for (let x = 0; x < w; x++) {
        const dx = x - cx;
        if (t < 0.17) {
          if (Math.abs(dx) <= 4 + isSideFactor * 2) mask[y * w + x] = 1;
        } else if (t < 0.56) {
          const half = Math.round(13 - isSideFactor * 7);
          if (Math.abs(dx) <= half) mask[y * w + x] = 1;
        } else {
          if (isSideFactor > 0.7) {
            if (Math.abs(dx) <= 4) mask[y * w + x] = 1;
          } else if ((dx >= -9 && dx <= -2) || (dx >= 2 && dx <= 9)) {
            mask[y * w + x] = 1;
          }
        }
      }
    }
    return {
      mask,
      yTop,
      yBottom: yBot,
      minX: cx - 13,
      maxX: cx + 13,
      spineCenterX: cx,
      headCenterX: cx,
    };
  });

  const { views, camParams } = createCalibratedViews(specs36, segs, w, h);
  const mesh = buildVisualHullMesh(views, camParams, { nx: 36, ny: 64, nz: 34 }, 1, views);

  assert.ok(mesh.vertexCount > 400);
  assert.ok(mesh.bounds.minY >= 0 && mesh.bounds.minY < 0.015);
  assert.ok(mesh.bounds.maxY > 1.72 && mesh.bounds.maxY < 1.83);
  assert.equal(mesh.depthMapWidth, 192);
  assert.equal(mesh.depthMapHeight, 384);
  assert.equal(mesh.depthMaps.length, 36 * 192 * 384);
});

