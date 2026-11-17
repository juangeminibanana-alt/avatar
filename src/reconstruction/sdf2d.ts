import type { CalibratedView, WorldCameraParams } from './types';

function edt1d(
  f: Float32Array,
  d: Float32Array,
  v: Int32Array,
  z: Float32Array,
  n: number,
): void {
  let k = 0;
  v[0] = 0;
  z[0] = -1e20;
  z[1] = 1e20;

  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = 1e20;
  }

  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dx = q - v[k];
    d[q] = dx * dx + f[v[k]];
  }
}

function computeSquaredEdt2D(
  binary: Uint8Array,
  targetVal: number,
  w: number,
  h: number,
): Float32Array {
  const INF = 1e12;
  const grid = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    grid[i] = binary[i] === targetVal ? 0 : INF;
  }

  const maxDim = Math.max(w, h);
  const f = new Float32Array(maxDim);
  const d = new Float32Array(maxDim);
  const v = new Int32Array(maxDim);
  const z = new Float32Array(maxDim + 1);

  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    edt1d(f, d, v, z, h);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }

  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) f[x] = grid[row + x];
    edt1d(f, d, v, z, w);
    for (let x = 0; x < w; x++) grid[row + x] = d[x];
  }

  return grid;
}

/**
 * Computes an exact 2D Signed Distance Field in world meters.
 * Negative values are inside the foreground silhouette; positive values are outside.
 */
export function compute2DSdf(
  mask: Uint8Array,
  width: number,
  height: number,
  metersPerPixel: number,
): Float32Array {
  const distOutsideSq = computeSquaredEdt2D(mask, 1, width, height);
  const distInsideSq = computeSquaredEdt2D(mask, 0, width, height);

  const sdf = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    if (mask[i]) {
      sdf[i] = -(Math.max(0, Math.sqrt(distInsideSq[i]) - 0.5)) * metersPerPixel;
    } else {
      sdf[i] = Math.max(0, Math.sqrt(distOutsideSq[i]) - 0.5) * metersPerPixel;
    }
  }
  return sdf;
}

export interface ViewProjectionCache {
  cosT: number;
  sinT: number;
  w: number;
  h: number;
  spineCenterU: number;
  yTopV: number;
  vSpan: number;
  sdf2d: Float32Array;
  metersPerNormU: number;
  headShiftU: number;
  azimuthDeg: number;
}

export function buildViewProjectionCache(
  views: CalibratedView[],
  camParams?: WorldCameraParams,
  headCenter?: { x: number; z: number },
): ViewProjectionCache[] {
  const D = camParams?.cameraDistance ?? 5.5;
  const hCx = headCenter?.x ?? 0;
  const hCz = headCenter?.z ?? 0;

  return views.map((v) => {
    const phi = (-v.spec.azimuthDeg * Math.PI) / 180;
    const cosT = Math.cos(phi);
    const sinT = Math.sin(phi);
    const metersPerNormU = camParams
      ? camParams.metersPerNormV * (v.analysisWidth / v.analysisHeight)
      : v.analysisWidth / v.analysisHeight;

    let headShiftU = 0;
    if (camParams && v.headCenterU !== undefined) {
      const xCam = hCx * cosT - hCz * sinT;
      const zCam = hCx * sinT + hCz * cosT;
      const persp = D / Math.max(1.0, D - zCam);
      const expectedHeadU = v.spineCenterU + (xCam * persp) / metersPerNormU;
      headShiftU = Math.max(-0.025, Math.min(0.025, v.headCenterU - expectedHeadU));
    }

    return {
      cosT,
      sinT,
      w: v.analysisWidth,
      h: v.analysisHeight,
      spineCenterU: v.spineCenterU,
      yTopV: v.yTopV,
      vSpan: Math.max(0.1, v.yBottomV - v.yTopV),
      sdf2d: v.sdf2d,
      metersPerNormU,
      headShiftU,
      azimuthDeg: v.spec.azimuthDeg,
    };
  });
}

export function sampleSdfBilinear(
  sdf: Float32Array,
  w: number,
  h: number,
  uNorm: number,
  vNorm: number,
): number {
  const px = uNorm * (w - 1);
  const py = vNorm * (h - 1);

  if (px < 0 || px > w - 1 || py < 0 || py > h - 1) {
    const cx = Math.max(0, Math.min(w - 1, px));
    const cy = Math.max(0, Math.min(h - 1, py));
    const outDist = Math.hypot(px - cx, py - cy) * 0.005;
    return sdf[Math.round(cy) * w + Math.round(cx)] + outDist;
  }

  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const fx = px - x0;
  const fy = py - y0;

  const d00 = sdf[y0 * w + x0];
  const d10 = sdf[y0 * w + x1];
  const d01 = sdf[y1 * w + x0];
  const d11 = sdf[y1 * w + x1];

  return (d00 * (1 - fx) + d10 * fx) * (1 - fy) + (d01 * (1 - fx) + d11 * fx) * fy;
}

export function projectAndSampleViewSdf(
  x: number,
  y: number,
  z: number,
  c: ViewProjectionCache,
  camParams: WorldCameraParams,
  overrideSdf?: Float32Array,
  uShift = 0,
): number {
  const yMid = camParams.subjectHeight * 0.5;
  const D = camParams.cameraDistance;
  const invSpanMeters = 1 / camParams.subjectHeight;

  const xCam = x * c.cosT - z * c.sinT;
  const zCam = x * c.sinT + z * c.cosT;
  const persp = D / Math.max(1.0, D - zCam);

  const worldYProj = (y - yMid) * persp + yMid;
  const worldXProj = xCam * persp;

  const tY = 1.0 - worldYProj * invSpanMeters;
  const vNorm = c.yTopV + tY * c.vSpan;

  const metersPerNormU = camParams.metersPerNormV * (c.w / c.h);
  const uNorm = c.spineCenterU + worldXProj / metersPerNormU + uShift;

  return sampleSdfBilinear(overrideSdf ?? c.sdf2d, c.w, c.h, uNorm, vNorm);
}

/**
 * Evaluates the 8-view smooth Visual Hull SDF at 3D world coordinate (x, y, z).
 * Negative values are inside the reconstructed 3D person; positive values are outside.
 */
export function evaluateVisualHullSdf(
  x: number,
  y: number,
  z: number,
  caches: ViewProjectionCache[],
  camParams: WorldCameraParams,
  smoothness = 0.009,
): number {
  let maxD = -1e6;
  const ds = new Float64Array(caches.length);

  for (let i = 0; i < caches.length; i++) {
    const d = projectAndSampleViewSdf(x, y, z, caches[i], camParams);
    ds[i] = d;
    if (d > maxD) maxD = d;
  }

  if (smoothness <= 0.0001) return maxD;

  let sumExp = 0;
  for (let i = 0; i < caches.length; i++) {
    const diff = (ds[i] - maxD) / smoothness;
    if (diff > -12) {
      sumExp += Math.exp(diff);
    }
  }
  return maxD + smoothness * Math.log(sumExp) - smoothness * 1.05;
}
