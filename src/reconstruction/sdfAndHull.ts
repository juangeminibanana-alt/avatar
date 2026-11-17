import { EDGE_TABLE, EDGE_VERTICES, TRI_TABLE } from './marchingCubesTables';
import { evaluateAnatomicalPartSdfs, extractAnatomicalProfile } from './anatomicalSdf';
import {
  buildViewProjectionCache,
  compute2DSdf,
  evaluateVisualHullSdf,
  type ViewProjectionCache,
} from './sdf2d';
import type {
  CalibratedView,
  ReconstructedMeshData,
  ViewSpec,
  WorldCameraParams,
} from './types';

export {
  buildViewProjectionCache,
  compute2DSdf,
  evaluateVisualHullSdf,
  type ViewProjectionCache,
};

export interface SegmentationResult {
  mask: Uint8Array;
  yTop: number;
  yBottom: number;
  minX: number;
  maxX: number;
  spineCenterX: number;
  headCenterX?: number;
}

/**
 * Segments a studio portrait photo with a light-gray seamless cyclorama backdrop.
 * Models background RGB per horizontal scanline from the left/right edges so vertical
 * lighting gradients on the studio sweep are cleanly cancelled.
 */
export function segmentStudioForeground(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): SegmentationResult {
  const rawMask = new Uint8Array(width * height);
  const marginCols = Math.max(4, Math.floor(width * 0.06));
  const topIgnore = Math.floor(height * 0.02);
  const bottomIgnore = Math.floor(height * 0.99);
  const floorBandY = Math.floor(height * 0.87);

  for (let y = topIgnore; y < bottomIgnore; y++) {
    // Estimate clean background color for this scanline from outer left/right studio edges
    let bgR = 0;
    let bgG = 0;
    let bgB = 0;
    let bgCount = 0;
    for (let x = 2; x < marginCols; x++) {
      const i = (y * width + x) * 4;
      bgR += rgba[i];
      bgG += rgba[i + 1];
      bgB += rgba[i + 2];
      bgCount++;
    }
    for (let x = width - marginCols; x < width - 2; x++) {
      const i = (y * width + x) * 4;
      bgR += rgba[i];
      bgG += rgba[i + 1];
      bgB += rgba[i + 2];
      bgCount++;
    }
    bgR /= bgCount;
    bgG /= bgCount;
    bgB /= bgCount;

    const isFloorBand = y >= floorBandY;

    for (let x = 2; x < width - 2; x++) {
      const i = (y * width + x) * 4;
      const r = rgba[i];
      const g = rgba[i + 1];
      const b = rgba[i + 2];
      const dr = r - bgR;
      const dg = g - bgG;
      const db = b - bgB;
      const dist = Math.sqrt(dr * dr + dg * dg + db * db);
      const lum = r * 0.299 + g * 0.587 + b * 0.114;
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);

      if (isFloorBand) {
        // Near floor: reject soft gray floor shadow (bright neutral gray), keep dark boots
        if (dist > 30 && lum < 138) {
          rawMask[y * width + x] = 1;
        }
      } else {
        // Reject shadowed neutral studio backdrop (lum > 145, low chroma) between arms and torso
        if ((dist > 26 && (lum <= 145 || chroma >= 18)) || chroma > 20) {
          rawMask[y * width + x] = 1;
        }
      }
    }
  }

  // Keep largest foreground island first, then seal small internal graphic/specular holes
  // without bridging open arm-to-torso or leg-to-leg studio background channels.
  const maxHolePixels = Math.max(64, Math.round((width * height) / 2400));
  const primaryMask = keepLargestComponent(rawMask, width, height);
  const cleanMask = fillSmallInternalHoles(primaryMask, width, height, maxHolePixels);

  // Measure bounds & spine center
  let yTop = height;
  let yBottom = 0;
  let minX = width;
  let maxX = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (cleanMask[y * width + x]) {
        if (y < yTop) yTop = y;
        if (y > yBottom) yBottom = y;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
  }

  if (yTop >= yBottom) {
    return {
      mask: cleanMask,
      yTop: Math.floor(height * 0.1),
      yBottom: Math.floor(height * 0.9),
      minX: Math.floor(width * 0.3),
      maxX: Math.floor(width * 0.7),
      spineCenterX: width * 0.5,
    };
  }

  const subjectH = yBottom - yTop;
  const headMid = bandMedianMidpointX(
    cleanMask,
    width,
    Math.floor(yTop + subjectH * 0.04),
    Math.floor(yTop + subjectH * 0.16),
  );
  const torsoMid = bandMedianMidpointX(
    cleanMask,
    width,
    Math.floor(yTop + subjectH * 0.24),
    Math.floor(yTop + subjectH * 0.54),
  );
  const ankleMid = bandMedianMidpointX(
    cleanMask,
    width,
    Math.floor(yTop + subjectH * 0.84),
    Math.floor(yTop + subjectH * 0.95),
  );

  const spineCenterX = headMid * 0.3 + torsoMid * 0.5 + ankleMid * 0.2;

  return {
    mask: cleanMask,
    yTop,
    yBottom,
    minX,
    maxX,
    spineCenterX,
    headCenterX: headMid,
  };
}

function fillSmallInternalHoles(
  mask: Uint8Array,
  w: number,
  h: number,
  maxHolePixels: number,
): Uint8Array {
  const visited = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  const out = new Uint8Array(mask);

  for (let i = 0; i < w * h; i++) {
    if (mask[i] || visited[i]) continue;

    let head = 0;
    let tail = 0;
    let touchesBorder = false;
    visited[i] = 1;
    queue[tail++] = i;

    while (head < tail) {
      const idx = queue[head++];
      const x = idx % w;
      const y = (idx - x) / w;
      if (x === 0 || x === w - 1 || y === 0 || y === h - 1) {
        touchesBorder = true;
      }
      if (x > 0 && !mask[idx - 1] && !visited[idx - 1]) {
        visited[idx - 1] = 1;
        queue[tail++] = idx - 1;
      }
      if (x + 1 < w && !mask[idx + 1] && !visited[idx + 1]) {
        visited[idx + 1] = 1;
        queue[tail++] = idx + 1;
      }
      if (y > 0 && !mask[idx - w] && !visited[idx - w]) {
        visited[idx - w] = 1;
        queue[tail++] = idx - w;
      }
      if (y + 1 < h && !mask[idx + w] && !visited[idx + w]) {
        visited[idx + w] = 1;
        queue[tail++] = idx + w;
      }
    }

    if (!touchesBorder && tail <= maxHolePixels) {
      for (let k = 0; k < tail; k++) {
        out[queue[k]] = 1;
      }
    }
  }

  return out;
}

function keepLargestComponent(mask: Uint8Array, w: number, h: number): Uint8Array {
  const labels = new Int32Array(w * h);
  const queue = new Int32Array(w * h);
  let bestLabel = 0;
  let bestSize = 0;
  let nextLabel = 1;

  for (let i = 0; i < w * h; i++) {
    if (mask[i] && labels[i] === 0) {
      const label = nextLabel++;
      let head = 0;
      let tail = 0;
      queue[tail++] = i;
      labels[i] = label;

      while (head < tail) {
        const idx = queue[head++];
        const x = idx % w;
        const y = (idx - x) / w;
        if (x > 0 && mask[idx - 1] && labels[idx - 1] === 0) {
          labels[idx - 1] = label;
          queue[tail++] = idx - 1;
        }
        if (x + 1 < w && mask[idx + 1] && labels[idx + 1] === 0) {
          labels[idx + 1] = label;
          queue[tail++] = idx + 1;
        }
        if (y > 0 && mask[idx - w] && labels[idx - w] === 0) {
          labels[idx - w] = label;
          queue[tail++] = idx - w;
        }
        if (y + 1 < h && mask[idx + w] && labels[idx + w] === 0) {
          labels[idx + w] = label;
          queue[tail++] = idx + w;
        }
      }

      if (tail > bestSize) {
        bestSize = tail;
        bestLabel = label;
      }
    }
  }

  const out = new Uint8Array(w * h);
  if (bestLabel > 0) {
    for (let i = 0; i < w * h; i++) {
      if (labels[i] === bestLabel) out[i] = 1;
    }
  }
  return out;
}

function bandMedianMidpointX(
  mask: Uint8Array,
  w: number,
  yStart: number,
  yEnd: number,
): number {
  const mids: number[] = [];
  for (let y = yStart; y <= yEnd; y++) {
    let lx = -1;
    let rx = -1;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (mask[row + x]) {
        if (lx < 0) lx = x;
        rx = x;
      }
    }
    if (lx >= 0) {
      mids.push((lx + rx) * 0.5);
    }
  }
  if (mids.length === 0) return w * 0.5;
  mids.sort((a, b) => a - b);
  return mids[Math.floor(mids.length * 0.5)];
}

function angularDistDeg(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

/**
 * Refines opposite-camera horizontal spine alignment (e.g. 0° vs 180°, 47° vs 223°, etc.)
 * by maximizing mirrored silhouette IoU so all cameras share one true vertical axis.
 */
export function refineOppositeViewCenters(views: CalibratedView[]): void {
  if (views.length < 2) return;
  const pairs: Array<readonly [number, number]> = [];
  const used = new Set<number>();

  for (let i = 0; i < views.length; i++) {
    if (used.has(i)) continue;
    const targetOpp = (views[i].spec.azimuthDeg + 180) % 360;
    let bestJ = -1;
    let bestDiff = 10.5;
    for (let j = i + 1; j < views.length; j++) {
      if (used.has(j)) continue;
      const diff = angularDistDeg(views[j].spec.azimuthDeg, targetOpp);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestJ = j;
      }
    }
    if (bestJ >= 0) {
      used.add(i);
      used.add(bestJ);
      pairs.push([i, bestJ]);
    }
  }

  for (const [idxA, idxB] of pairs) {
    const va = views[idxA];
    const vb = views[idxB];
    const w = va.analysisWidth;
    const h = va.analysisHeight;

    let bestShiftPx = 0;
    let bestScore = -1;

    const baseCxA = va.spineCenterU * w;
    const baseCxB = vb.spineCenterU * w;

    for (let shift = -8; shift <= 8; shift++) {
      let inter = 0;
      let union = 0;
      for (let y = Math.floor(h * 0.1); y < Math.floor(h * 0.9); y += 2) {
        const vaV = va.yTopV + ((y / h) - 0.1) * ((va.yBottomV - va.yTopV) / 0.8);
        const vbV = vb.yTopV + ((y / h) - 0.1) * ((vb.yBottomV - vb.yTopV) / 0.8);
        const ya = Math.max(0, Math.min(h - 1, Math.round(vaV * h)));
        const yb = Math.max(0, Math.min(h - 1, Math.round(vbV * h)));

        for (let dx = -Math.floor(w * 0.35); dx <= Math.floor(w * 0.35); dx += 2) {
          // Moving both centers by +shift shifts view A by -shift and view B by +shift in world space
          const xa = Math.round(baseCxA + dx + shift);
          const xb = Math.round(baseCxB - dx + shift);
          const ma = xa >= 0 && xa < w ? va.mask[ya * w + xa] : 0;
          const mb = xb >= 0 && xb < w ? vb.mask[yb * w + xb] : 0;
          if (ma && mb) inter++;
          if (ma || mb) union++;
        }
      }
      const rawIou = union > 0 ? inter / union : 0;
      const score = rawIou - Math.abs(shift) * 0.0005;
      if (score > bestScore) {
        bestScore = score;
        bestShiftPx = shift;
      }
    }

    va.spineCenterU += bestShiftPx / w;
    vb.spineCenterU += bestShiftPx / w;
  }
}

export interface GridBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

function smoothstepHull(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function smoothMaxHull(a: number, b: number, k: number): number {
  const h = Math.max(0, Math.min(1, 0.5 + (0.5 * (-a - -b)) / k));
  const sm = -b + (-a - -b) * h - k * h * (1 - h);
  return -sm;
}

function selectCarveSubset(views: CalibratedView[], maxCount = 72): CalibratedView[] {
  if (views.length <= maxCount) return views;
  const out: CalibratedView[] = [];
  for (let i = 0; i < maxCount; i++) {
    const idx = Math.floor((i * views.length) / maxCount);
    out.push(views[idx]);
  }
  return out;
}

/**
 * Computes the 3D SDF volume over a regular voxel grid and extracts a watertight indexed
 * triangle mesh using Marching Cubes.
 */
export function buildVisualHullMesh(
  views: CalibratedView[],
  camParams: WorldCameraParams,
  gridRes: { nx: number; ny: number; nz: number },
  smoothingPasses: number,
  textureViewsOverride?: CalibratedView[],
): ReconstructedMeshData {
  const profile = extractAnatomicalProfile(views, camParams);
  const useHullCarving = views.length >= 4;
  const carveCaches = useHullCarving
    ? buildViewProjectionCache(selectCarveSubset(views, 72), camParams, {
        x: profile.headCenterX,
        z: profile.headCenterZ,
      })
    : null;

  const { nx, ny, nz } = gridRes;
  const bounds: GridBounds = {
    minX: -0.44,
    maxX: 0.44,
    minY: -0.03,
    maxY: camParams.subjectHeight + 0.04,
    minZ: -0.38,
    maxZ: 0.38,
  };

  const dx = (bounds.maxX - bounds.minX) / (nx - 1);
  const dy = (bounds.maxY - bounds.minY) / (ny - 1);
  const dz = (bounds.maxZ - bounds.minZ) / (nz - 1);

  const H = camParams.subjectHeight;
  const isDenseSet = views.length > 8;
  const field = new Float32Array(nx * ny * nz);
  for (let iy = 0; iy < ny; iy++) {
    const y = bounds.minY + iy * dy;
    const yOff = iy * nx * nz;
    const isUpperZone = smoothstepHull(H * 0.70, H * 0.78, y);
    const isHeadZone = smoothstepHull(H * 0.81, H * 0.85, y);
    const baseCarveWeight = carveCaches
      ? smoothstepHull(0.14, 0.24, y) * (isDenseSet ? 1.0 : 0.56 + 0.24 * isHeadZone)
      : 0;
    const hullMargin = isDenseSet ? 0.006 : 0.004 - 0.002 * isHeadZone;
    for (let iz = 0; iz < nz; iz++) {
      const z = bounds.minZ + iz * dz;
      const zOff = yOff + iz * nx;
      for (let ix = 0; ix < nx; ix++) {
        const x = bounds.minX + ix * dx;
        const anatSdf = evaluateAnatomicalPartSdfs(x, y, z, profile).sdf;
        if (carveCaches && baseCarveWeight > 0.01 && anatSdf < 0.045) {
          const dHull = evaluateVisualHullSdf(x, y, z, carveCaches, camParams, isDenseSet ? 0.008 : 0.013);
          const carved = smoothMaxHull(anatSdf, dHull - hullMargin, 0.014);
          // Enforce strict outside carving on upper shoulders/head & clear outer protrusions without faceting torso folds
          const outsideUpper = smoothstepHull(-0.004, 0.003, dHull) * isUpperZone * 0.92;
          const farOutside = smoothstepHull(0.004, 0.014, dHull) * 0.90;
          const weight = Math.max(baseCarveWeight, Math.max(outsideUpper, farOutside) * smoothstepHull(0.10, 0.18, y));
          field[zOff + ix] = anatSdf + (carved - anatSdf) * weight;
        } else {
          field[zOff + ix] = anatSdf;
        }
      }
    }
  }

  const extracted = extractMarchingCubesMesh(field, nx, ny, nz, bounds);
  const raw = filterSmallMeshComponents(extracted.positions, extracted.indices);

  if (smoothingPasses > 0 && raw.vertexCount > 0) {
    taubinSmoothMesh(raw.positions, raw.indices, smoothingPasses, 0.34, -0.35);
  }

  // Keep boot soles cleanly planted at y = 0.0 without downward Taubin overshoot
  for (let i = 1; i < raw.positions.length; i += 3) {
    if (raw.positions[i] < 0) {
      raw.positions[i] = 0;
    }
  }

  // Split front/back hemisphere seam so UV baking for GLB has zero seam distortion
  const uvSplit = splitAndComputeDualHemisphereUvs(
    raw.positions,
    raw.indices,
    camParams.subjectHeight,
  );

  const normals = computeSmoothNormals(uvSplit.positions, uvSplit.indices);
  const vertexCount = uvSplit.positions.length / 3;
  const triangleCount = uvSplit.indices.length / 3;

  // Compute soft per-vertex part weights [wHead, wTorso, wRightArm, wLeftArm] for part-locked projection
  const partWeights = new Float32Array(vertexCount * 4);
  for (let i = 0; i < vertexCount; i++) {
    const px = uvSplit.positions[i * 3];
    const py = uvSplit.positions[i * 3 + 1];
    const pz = uvSplit.positions[i * 3 + 2];
    const sample = evaluateAnatomicalPartSdfs(px, py, pz, profile);
    partWeights[i * 4] = sample.wHead;
    partWeights[i * 4 + 1] = sample.wTorso;
    partWeights[i * 4 + 2] = sample.wRightArm;
    partWeights[i * 4 + 3] = sample.wLeftArm;
  }

  const meshBounds = computeMeshBounds(uvSplit.positions);
  const texViews = textureViewsOverride ?? views;
  const depthMapWidth = texViews.length > 16 ? 192 : 256;
  const depthMapHeight = texViews.length > 16 ? 384 : 512;
  const depthMaps = computeCameraDepthMaps(
    uvSplit.positions,
    uvSplit.indices,
    texViews,
    camParams,
    depthMapWidth,
    depthMapHeight,
  );

  return {
    positions: uvSplit.positions,
    normals,
    uvs: uvSplit.uvs,
    indices: uvSplit.indices,
    partWeights,
    headCenter: { x: profile.headCenterX, z: profile.headCenterZ },
    vertexCount,
    triangleCount,
    bounds: meshBounds,
    depthMaps,
    depthMapWidth,
    depthMapHeight,
  };
}

/**
 * Removes tiny disconnected floating Marching Cubes islands (e.g. 1-voxel specks near floor)
 * while keeping the main subject and any substantial mesh components intact.
 */
export function filterSmallMeshComponents(
  positions: Float32Array,
  indices: Uint32Array,
): { positions: Float32Array; indices: Uint32Array; vertexCount: number } {
  const vCount = positions.length / 3;
  const triCount = indices.length / 3;
  if (vCount === 0 || triCount === 0) {
    return { positions, indices, vertexCount: vCount };
  }

  const parent = new Int32Array(vCount);
  for (let i = 0; i < vCount; i++) parent[i] = i;

  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    let cur = x;
    while (cur !== r) {
      const nxt = parent[cur];
      parent[cur] = r;
      cur = nxt;
    }
    return r;
  };

  const unite = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t];
    const b = indices[t + 1];
    const c = indices[t + 2];
    unite(a, b);
    unite(b, c);
  }

  const compTris = new Map<number, number>();
  let maxTris = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const root = find(indices[t]);
    const next = (compTris.get(root) ?? 0) + 1;
    compTris.set(root, next);
    if (next > maxTris) maxTris = next;
  }

  const minKeepTris = Math.max(40, Math.floor(maxTris * 0.015));
  const remap = new Int32Array(vCount);
  remap.fill(-1);
  const outPos: number[] = [];
  const outIdx: number[] = [];

  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t];
    const root = find(a);
    if ((compTris.get(root) ?? 0) < minKeepTris) continue;

    const verts = [a, indices[t + 1], indices[t + 2]];
    for (let k = 0; k < 3; k++) {
      const v = verts[k];
      let mv = remap[v];
      if (mv === -1) {
        mv = outPos.length / 3;
        remap[v] = mv;
        outPos.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
      }
      outIdx.push(mv);
    }
  }

  return {
    positions: new Float32Array(outPos),
    indices: new Uint32Array(outIdx),
    vertexCount: outPos.length / 3,
  };
}

/**
 * Extracts an indexed Marching Cubes mesh from a 3D scalar SDF field (surface at iso = 0).
 */
export function extractMarchingCubesMesh(
  field: Float32Array,
  nx: number,
  ny: number,
  nz: number,
  bounds: GridBounds,
): { positions: Float32Array; indices: Uint32Array; vertexCount: number } {
  const dx = (bounds.maxX - bounds.minX) / (nx - 1);
  const dy = (bounds.maxY - bounds.minY) / (ny - 1);
  const dz = (bounds.maxZ - bounds.minZ) / (nz - 1);

  const edgeVertexMap = new Map<number, number>();
  const posList: number[] = [];
  const idxList: number[] = [];

  const cornerPos = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [1, 1, 1],
    [0, 1, 1],
  ];
  const cornerVal = new Float32Array(8);
  const cornerIdx = new Int32Array(8);
  const vertOnEdge = new Int32Array(12);

  const strideY = nx * nz;
  const strideZ = nx;

  // Unique integer edge key across a 3D grid (max dim <= 512)
  const getEdgeKey = (ix: number, iy: number, iz: number, edge: number): number => {
    // Map each of the 12 cube edges to a canonical (vx, vy, vz, axisDir 0=X,1=Y,2=Z)
    let vx = ix;
    let vy = iy;
    let vz = iz;
    let dir = 0;
    if (edge === 0) {
      dir = 0;
    } else if (edge === 1) {
      vx = ix + 1;
      dir = 1;
    } else if (edge === 2) {
      vy = iy + 1;
      dir = 0;
    } else if (edge === 3) {
      dir = 1;
    } else if (edge === 4) {
      vz = iz + 1;
      dir = 0;
    } else if (edge === 5) {
      vx = ix + 1;
      vz = iz + 1;
      dir = 1;
    } else if (edge === 6) {
      vy = iy + 1;
      vz = iz + 1;
      dir = 0;
    } else if (edge === 7) {
      vz = iz + 1;
      dir = 1;
    } else if (edge === 8) {
      dir = 2;
    } else if (edge === 9) {
      vx = ix + 1;
      dir = 2;
    } else if (edge === 10) {
      vx = ix + 1;
      vy = iy + 1;
      dir = 2;
    } else {
      vy = iy + 1;
      dir = 2;
    }
    return ((vy * nz + vz) * nx + vx) * 3 + dir;
  };

  for (let iy = 0; iy < ny - 1; iy++) {
    for (let iz = 0; iz < nz - 1; iz++) {
      for (let ix = 0; ix < nx - 1; ix++) {
        let cubeIndex = 0;
        for (let c = 0; c < 8; c++) {
          const cx = ix + cornerPos[c][0];
          const cy = iy + cornerPos[c][1];
          const cz = iz + cornerPos[c][2];
          const idx = cy * strideY + cz * strideZ + cx;
          cornerIdx[c] = idx;
          const v = field[idx];
          cornerVal[c] = v;
          if (v < 0) cubeIndex |= 1 << c;
        }

        const edgeMask = EDGE_TABLE[cubeIndex];
        if (edgeMask === 0) continue;

        for (let e = 0; e < 12; e++) {
          if ((edgeMask & (1 << e)) === 0) continue;
          const key = getEdgeKey(ix, iy, iz, e);
          let vIdx = edgeVertexMap.get(key);
          if (vIdx === undefined) {
            const [a, b] = EDGE_VERTICES[e];
            const va = cornerVal[a];
            const vb = cornerVal[b];
            const denom = vb - va;
            const t = Math.abs(denom) > 1e-8 ? Math.max(0, Math.min(1, -va / denom)) : 0.5;

            const ax = bounds.minX + (ix + cornerPos[a][0]) * dx;
            const ay = bounds.minY + (iy + cornerPos[a][1]) * dy;
            const az = bounds.minZ + (iz + cornerPos[a][2]) * dz;
            const bx = bounds.minX + (ix + cornerPos[b][0]) * dx;
            const by = bounds.minY + (iy + cornerPos[b][1]) * dy;
            const bz = bounds.minZ + (iz + cornerPos[b][2]) * dz;

            vIdx = posList.length / 3;
            posList.push(
              ax + t * (bx - ax),
              ay + t * (by - ay),
              az + t * (bz - az),
            );
            edgeVertexMap.set(key, vIdx);
          }
          vertOnEdge[e] = vIdx;
        }

        const triRow = TRI_TABLE[cubeIndex];
        for (let t = 0; triRow[t] !== -1; t += 3) {
          // Flip winding so outward normal points toward +SDF (outside)
          const i0 = vertOnEdge[triRow[t]];
          const i1 = vertOnEdge[triRow[t + 2]];
          const i2 = vertOnEdge[triRow[t + 1]];
          if (i0 !== i1 && i1 !== i2 && i0 !== i2) {
            idxList.push(i0, i1, i2);
          }
        }
      }
    }
  }

  return {
    positions: new Float32Array(posList),
    indices: new Uint32Array(idxList),
    vertexCount: posList.length / 3,
  };
}

/**
 * Volume-preserving Taubin (lambda / mu) mesh smoothing.
 * Eliminates voxel staircase steps without shrinking limb thickness.
 */
export function taubinSmoothMesh(
  positions: Float32Array,
  indices: Uint32Array,
  passes: number,
  lambda = 0.5,
  mu = -0.53,
): void {
  const vCount = positions.length / 3;
  if (vCount === 0) return;

  // Build adjacency CSR-like neighbor sums per pass using flat accumulation
  const sum = new Float32Array(positions.length);
  const deg = new Int32Array(vCount);
  const scratch = new Float32Array(positions.length);

  const step = (factor: number) => {
    sum.fill(0);
    deg.fill(0);
    for (let t = 0; t < indices.length; t += 3) {
      const a = indices[t];
      const b = indices[t + 1];
      const c = indices[t + 2];

      accumulateEdge(positions, sum, deg, a, b);
      accumulateEdge(positions, sum, deg, b, c);
      accumulateEdge(positions, sum, deg, c, a);
    }

    for (let i = 0; i < vCount; i++) {
      const d = deg[i];
      if (d === 0) {
        scratch[i * 3] = positions[i * 3];
        scratch[i * 3 + 1] = positions[i * 3 + 1];
        scratch[i * 3 + 2] = positions[i * 3 + 2];
        continue;
      }
      const invD = 1 / d;
      const ox = positions[i * 3];
      const oy = positions[i * 3 + 1];
      const oz = positions[i * 3 + 2];
      const avgX = sum[i * 3] * invD;
      const avgY = sum[i * 3 + 1] * invD;
      const avgZ = sum[i * 3 + 2] * invD;

      scratch[i * 3] = ox + factor * (avgX - ox);
      scratch[i * 3 + 1] = oy + factor * (avgY - oy);
      scratch[i * 3 + 2] = oz + factor * (avgZ - oz);
    }
    positions.set(scratch);
  };

  for (let p = 0; p < passes; p++) {
    step(lambda);
    step(mu);
  }
}

function accumulateEdge(
  pos: Float32Array,
  sum: Float32Array,
  deg: Int32Array,
  u: number,
  v: number,
): void {
  sum[u * 3] += pos[v * 3];
  sum[u * 3 + 1] += pos[v * 3 + 1];
  sum[u * 3 + 2] += pos[v * 3 + 2];
  deg[u]++;

  sum[v * 3] += pos[u * 3];
  sum[v * 3 + 1] += pos[u * 3 + 1];
  sum[v * 3 + 2] += pos[u * 3 + 2];
  deg[v]++;
}

/**
 * Generates clean non-overlapping Dual-Hemisphere (Front Z >= 0, Back Z < 0) UVs
 * by duplicating vertices only on triangles that straddle Z = 0.
 */
function splitAndComputeDualHemisphereUvs(
  positions: Float32Array,
  indices: Uint32Array,
  subjectHeight: number,
): { positions: Float32Array; uvs: Float32Array; indices: Uint32Array } {
  const newPositions: number[] = [];
  const newUvs: number[] = [];
  const newIndices = new Uint32Array(indices.length);

  // Map (origVertexIdx << 1) | side -> newVertexIdx
  const vertexMap = new Map<number, number>();
  const invH = 1 / Math.max(0.1, subjectHeight);

  for (let t = 0; t < indices.length; t += 3) {
    const i0 = indices[t];
    const i1 = indices[t + 1];
    const i2 = indices[t + 2];

    const cz =
      (positions[i0 * 3 + 2] + positions[i1 * 3 + 2] + positions[i2 * 3 + 2]) / 3;
    const side = cz >= 0 ? 0 : 1; // 0 = front hemisphere (left atlas), 1 = back hemisphere (right atlas)

    const triVerts = [i0, i1, i2];
    for (let k = 0; k < 3; k++) {
      const orig = triVerts[k];
      const key = orig * 2 + side;
      let mapped = vertexMap.get(key);
      if (mapped === undefined) {
        const px = positions[orig * 3];
        const py = positions[orig * 3 + 1];
        const pz = positions[orig * 3 + 2];

        mapped = newPositions.length / 3;
        newPositions.push(px, py, pz);

        // Compute azimuthal-planar UV within its hemisphere [0..1]
        const theta = Math.atan2(px, side === 0 ? Math.max(0.001, pz) : Math.max(0.001, -pz));
        // theta in [-PI/2, PI/2] -> normalize to [0.04, 0.46] for front, [0.54, 0.96] for back
        const uLocal = 0.5 + (theta / Math.PI) * 0.85;
        const uClamped = Math.max(0.02, Math.min(0.98, uLocal));
        const u = side === 0 ? 0.03 + uClamped * 0.44 : 0.53 + (1.0 - uClamped) * 0.44;
        const v = Math.max(0.02, Math.min(0.98, py * invH * 0.94 + 0.03));

        newUvs.push(u, v);
        vertexMap.set(key, mapped);
      }
      newIndices[t + k] = mapped;
    }
  }

  return {
    positions: new Float32Array(newPositions),
    uvs: new Float32Array(newUvs),
    indices: newIndices,
  };
}

export function computeSmoothNormals(
  positions: Float32Array,
  indices: Uint32Array,
): Float32Array {
  const normals = new Float32Array(positions.length);

  for (let t = 0; t < indices.length; t += 3) {
    const i0 = indices[t] * 3;
    const i1 = indices[t + 1] * 3;
    const i2 = indices[t + 2] * 3;

    const ax = positions[i0];
    const ay = positions[i0 + 1];
    const az = positions[i0 + 2];

    const e1x = positions[i1] - ax;
    const e1y = positions[i1 + 1] - ay;
    const e1z = positions[i1 + 2] - az;

    const e2x = positions[i2] - ax;
    const e2y = positions[i2 + 1] - ay;
    const e2z = positions[i2 + 2] - az;

    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;

    normals[i0] += nx;
    normals[i0 + 1] += ny;
    normals[i0 + 2] += nz;

    normals[i1] += nx;
    normals[i1 + 1] += ny;
    normals[i1 + 2] += nz;

    normals[i2] += nx;
    normals[i2 + 1] += ny;
    normals[i2 + 2] += nz;
  }

  for (let i = 0; i < normals.length; i += 3) {
    const x = normals[i];
    const y = normals[i + 1];
    const z = normals[i + 2];
    const len = Math.hypot(x, y, z);
    if (len > 1e-8) {
      const inv = 1 / len;
      normals[i] *= inv;
      normals[i + 1] *= inv;
      normals[i + 2] *= inv;
    } else {
      normals[i + 1] = 1;
    }
  }

  return normals;
}

export function computeMeshBounds(positions: Float32Array): ReconstructedMeshData['bounds'] {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }

  return { minX, maxX, minY, maxY, minZ, maxZ };
}

/**
 * Software Z-buffer rasterizer for all 8 views.
 * Produces depthMaps[viewIdx * mapW * mapH + py * mapW + px] containing the minimum
 * distance from camera to surface (in meters), enabling exact occlusion testing in GLSL
 * so foreground limbs never bleed textures onto occluded torso regions.
 */
export function computeCameraDepthMaps(
  positions: Float32Array,
  indices: Uint32Array,
  views: CalibratedView[],
  camParams: WorldCameraParams,
  mapW: number,
  mapH: number,
): Float32Array {
  const count = views.length;
  const perMap = mapW * mapH;
  const depthMaps = new Float32Array(count * perMap);
  depthMaps.fill(100.0);

  const yMid = camParams.subjectHeight * 0.5;
  const D = camParams.cameraDistance;
  const invH = 1 / camParams.subjectHeight;

  const vCount = positions.length / 3;
  const pxArr = new Float32Array(vCount);
  const pyArr = new Float32Array(vCount);
  const pzArr = new Float32Array(vCount);

  for (let c = 0; c < count; c++) {
    const view = views[c];
    const phi = (-view.spec.azimuthDeg * Math.PI) / 180;
    const cosT = Math.cos(phi);
    const sinT = Math.sin(phi);
    const vSpan = Math.max(0.1, view.yBottomV - view.yTopV);
    const metersPerNormU =
      camParams.metersPerNormV * (view.analysisWidth / view.analysisHeight);
    const cropUSpan = Math.max(0.05, view.cropU1 - view.cropU0);
    const cropVSpan = Math.max(0.05, view.cropV1 - view.cropV0);

    for (let i = 0; i < vCount; i++) {
      const x = positions[i * 3];
      const y = positions[i * 3 + 1];
      const z = positions[i * 3 + 2];

      const xCam = x * cosT - z * sinT;
      const zCam = x * sinT + z * cosT;
      const camDist = Math.max(1.0, D - zCam);
      const persp = D / camDist;

      const worldYProj = (y - yMid) * persp + yMid;
      const worldXProj = xCam * persp;

      const tY = 1.0 - worldYProj * invH;
      const vNorm = view.yTopV + tY * vSpan;
      const uNorm = view.spineCenterU + worldXProj / metersPerNormU;

      const uCrop = (uNorm - view.cropU0) / cropUSpan;
      const vCrop = (vNorm - view.cropV0) / cropVSpan;

      pxArr[i] = uCrop * (mapW - 1);
      pyArr[i] = vCrop * (mapH - 1);
      pzArr[i] = camDist;
    }

    const offset = c * perMap;
    for (let t = 0; t < indices.length; t += 3) {
      const i0 = indices[t];
      const i1 = indices[t + 1];
      const i2 = indices[t + 2];

      const x0 = pxArr[i0],
        y0 = pyArr[i0],
        z0 = pzArr[i0];
      const x1 = pxArr[i1],
        y1 = pyArr[i1],
        z1 = pzArr[i1];
      const x2 = pxArr[i2],
        y2 = pyArr[i2],
        z2 = pzArr[i2];

      const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
      const maxX = Math.min(mapW - 1, Math.ceil(Math.max(x0, x1, x2)));
      const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
      const maxY = Math.min(mapH - 1, Math.ceil(Math.max(y0, y1, y2)));

      if (minX > maxX || minY > maxY) continue;

      const area = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
      if (Math.abs(area) < 1e-4) continue;
      const invArea = 1 / area;

      for (let py = minY; py <= maxY; py++) {
        const cy = py + 0.5;
        for (let px = minX; px <= maxX; px++) {
          const cx = px + 0.5;
          const w0 = ((x1 - cx) * (y2 - cy) - (y1 - cy) * (x2 - cx)) * invArea;
          const w1 = ((x2 - cx) * (y0 - cy) - (y2 - cy) * (x0 - cx)) * invArea;
          const w2 = 1.0 - w0 - w1;
          if (w0 >= -0.01 && w1 >= -0.01 && w2 >= -0.01) {
            const d = w0 * z0 + w1 * z1 + w2 * z2;
            const idx = offset + py * mapW + px;
            if (d < depthMaps[idx]) {
              depthMaps[idx] = d;
            }
          }
        }
      }
    }
  }

  return depthMaps;
}

/**
 * Computes default calibrated camera params given segmented views.
 */
export function createCalibratedViews(
  specs: ViewSpec[],
  segmentations: SegmentationResult[],
  analysisWidth: number,
  analysisHeight: number,
): { views: CalibratedView[]; camParams: WorldCameraParams } {
  let avgSpanV = 0;
  for (const s of segmentations) {
    avgSpanV += (s.yBottom - s.yTop) / analysisHeight;
  }
  avgSpanV /= Math.max(1, segmentations.length);

  const subjectHeight = 1.78;
  const metersPerNormV = subjectHeight / Math.max(0.1, avgSpanV);

  const views: CalibratedView[] = specs.map((spec, idx) => {
    const seg = segmentations[idx];
    const sdf2d = compute2DSdf(seg.mask, analysisWidth, analysisHeight, metersPerNormV / analysisHeight);

    const padU = 0.03;
    const padV = 0.02;
    const cropU0 = Math.max(0, seg.minX / analysisWidth - padU);
    const cropU1 = Math.min(1, seg.maxX / analysisWidth + padU);
    const cropV0 = Math.max(0, seg.yTop / analysisHeight - padV);
    const cropV1 = Math.min(1, seg.yBottom / analysisHeight + padV);

    return {
      spec,
      analysisWidth,
      analysisHeight,
      mask: seg.mask,
      sdf2d,
      spineCenterU: seg.spineCenterX / analysisWidth,
      yTopV: seg.yTop / analysisHeight,
      yBottomV: seg.yBottom / analysisHeight,
      cropU0,
      cropU1,
      cropV0,
      cropV1,
      headCenterU: (seg.headCenterX ?? seg.spineCenterX) / analysisWidth,
      atlasIndex: Math.floor(idx / 2),
      atlasSlot: idx % 2,
    };
  });

  refineOppositeViewCenters(views);

  return {
    views,
    camParams: {
      subjectHeight,
      metersPerNormV,
      cameraDistance: 5.5,
    },
  };
}
