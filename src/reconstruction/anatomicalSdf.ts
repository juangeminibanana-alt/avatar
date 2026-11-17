import type { CalibratedView, WorldCameraParams } from './types';

export interface Interval1D {
  min: number;
  max: number;
}

export interface AnatomicalProfile {
  subjectHeight: number;
  sliceCount: number;
  headCenterX: number;
  headCenterZ: number;
  hasSeparatedArms: boolean;
  hasSeparatedLegs: boolean;
  // Head & cap bounds per slice
  headCx: Float32Array;
  headRx: Float32Array;
  headCz: Float32Array;
  headRz: Float32Array;
  visorTipZ: number;
  // Torso + shoulder/sleeve bounds per slice
  torsoCx: Float32Array;
  torsoRx: Float32Array;
  sleeveRx: Float32Array;
  torsoCz: Float32Array;
  torsoRz: Float32Array;
  // Arm bounds per slice
  rArmCx: Float32Array;
  rArmCz: Float32Array;
  rArmRx: Float32Array;
  rArmRz: Float32Array;
  lArmCx: Float32Array;
  lArmCz: Float32Array;
  lArmRx: Float32Array;
  lArmRz: Float32Array;
  // Leg & boot bounds per slice
  rLegCx: Float32Array;
  rLegRx: Float32Array;
  lLegCx: Float32Array;
  lLegRx: Float32Array;
  legCz: Float32Array;
  legRz: Float32Array;
  rBootX: number;
  lBootX: number;
  bootZCenter: number;
  bootBackZ: number;
  bootFrontZ: number;
}

export interface PartSdfSample {
  sdf: number;
  wHead: number;
  wTorso: number;
  wRightArm: number;
  wLeftArm: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function smoothMin(a: number, b: number, k: number): number {
  if (k <= 1e-6) return Math.min(a, b);
  const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1);
  return lerp(b, a, h) - k * h * (1 - h);
}

function smoothMax(a: number, b: number, k: number): number {
  return -smoothMin(-a, -b, k);
}

function angularDistanceDeg(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

function findClosestViewIndex(views: CalibratedView[], targetAzimuthDeg: number): number {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < views.length; i++) {
    const d = angularDistanceDeg(views[i].spec.azimuthDeg, targetAzimuthDeg);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function sampleRowIntervalsMeters(
  view: CalibratedView,
  camParams: WorldCameraParams,
  t: number,
  flipSign: number,
  perspShrink = 0.985,
): Interval1D[] {
  const w = view.analysisWidth;
  const h = view.analysisHeight;
  const vSpan = Math.max(0.1, view.yBottomV - view.yTopV);
  const vNorm = view.yTopV + clamp(t, 0, 1) * vSpan;
  const yCenter = clamp(Math.round(vNorm * (h - 1)), 0, h - 1);
  const metersPerNormU = camParams.metersPerNormV * (w / h);

  const rowRuns: Interval1D[][] = [];
  for (let dy = -1; dy <= 1; dy++) {
    const y = clamp(yCenter + dy, 0, h - 1);
    const rowOff = y * w;
    const rawRuns: Array<[number, number]> = [];
    let inRun = false;
    let startX = 0;
    for (let x = 0; x < w; x++) {
      const fg = view.mask[rowOff + x] > 0;
      if (fg && !inRun) {
        inRun = true;
        startX = x;
      } else if (!fg && inRun) {
        inRun = false;
        if (x - 1 - startX >= 1) rawRuns.push([startX, x - 1]);
      }
    }
    if (inRun && w - 1 - startX >= 1) rawRuns.push([startX, w - 1]);

    const merged: Array<[number, number]> = [];
    for (const run of rawRuns) {
      const prev = merged[merged.length - 1];
      if (prev && run[0] - prev[1] <= 2) {
        prev[1] = run[1];
      } else {
        merged.push([run[0], run[1]]);
      }
    }

    const intervals = merged
      .filter(([x0, x1]) => x1 - x0 >= 1)
      .map(([x0, x1]) => {
        const u0 = x0 / (w - 1);
        const u1 = x1 / (w - 1);
        const m0 = (u0 - view.spineCenterU) * metersPerNormU * flipSign * perspShrink;
        const m1 = (u1 - view.spineCenterU) * metersPerNormU * flipSign * perspShrink;
        return { min: Math.min(m0, m1), max: Math.max(m0, m1) };
      })
      .sort((a, b) => a.min - b.min);

    rowRuns.push(intervals);
  }

  return rowRuns[1].length >= rowRuns[0].length && rowRuns[1].length >= rowRuns[2].length
    ? rowRuns[1]
    : rowRuns[0].length >= rowRuns[2].length
      ? rowRuns[0]
      : rowRuns[2];
}

function spanInterval(intervals: Interval1D[]): Interval1D | null {
  if (intervals.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const iv of intervals) {
    if (iv.min < min) min = iv.min;
    if (iv.max > max) max = iv.max;
  }
  return { min, max };
}

function medianOf(values: number[], fallback: number): number {
  if (values.length === 0) return fallback;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.5)];
}

function smoothArray(arr: Float32Array, passes = 2): void {
  const n = arr.length;
  const tmp = new Float32Array(n);
  for (let p = 0; p < passes; p++) {
    for (let i = 0; i < n; i++) {
      const a = arr[Math.max(0, i - 1)];
      const b = arr[i];
      const c = arr[Math.min(n - 1, i + 1)];
      tmp[i] = a * 0.25 + b * 0.5 + c * 0.25;
    }
    arr.set(tmp);
  }
}

function sampleSlice(arr: Float32Array, t: number, sliceCount: number): number {
  const f = clamp(t, 0, 1) * (sliceCount - 1);
  const i0 = Math.floor(f);
  const i1 = Math.min(sliceCount - 1, i0 + 1);
  return lerp(arr[i0], arr[i1], f - i0);
}

/**
 * Extracts dense, silhouette-calibrated anatomical envelopes from the studio views.
 * - Lateral widths [cx, rx] are measured from 0° & 180° with strict arm/torso/leg isolation.
 * - Depth bounds [cz, rz] are measured from 90° & 270°, preserving natural chest/abdomen/pelvis curves.
 */
export function extractAnatomicalProfile(
  views: CalibratedView[],
  camParams: WorldCameraParams,
  sliceCount = 121,
): AnatomicalProfile {
  const idx0 = findClosestViewIndex(views, 0);
  const idx90 = findClosestViewIndex(views, 90);
  const idx180 = findClosestViewIndex(views, 180);
  const idx270 = findClosestViewIndex(views, 270);

  const v0 = views[idx0];
  const v90 = views[idx90];
  const v180 = views[idx180];
  const v270 = views[idx270];

  const headCx = new Float32Array(sliceCount);
  const headRx = new Float32Array(sliceCount);
  const headCz = new Float32Array(sliceCount);
  const headRz = new Float32Array(sliceCount);

  const torsoCx = new Float32Array(sliceCount);
  const torsoRx = new Float32Array(sliceCount);
  const sleeveRx = new Float32Array(sliceCount);
  const torsoCz = new Float32Array(sliceCount);
  const torsoRz = new Float32Array(sliceCount);

  const rArmCx = new Float32Array(sliceCount);
  const rArmCz = new Float32Array(sliceCount);
  const rArmRx = new Float32Array(sliceCount);
  const rArmRz = new Float32Array(sliceCount);
  const lArmCx = new Float32Array(sliceCount);
  const lArmCz = new Float32Array(sliceCount);
  const lArmRx = new Float32Array(sliceCount);
  const lArmRz = new Float32Array(sliceCount);

  const rLegCx = new Float32Array(sliceCount);
  const rLegRx = new Float32Array(sliceCount);
  const lLegCx = new Float32Array(sliceCount);
  const lLegRx = new Float32Array(sliceCount);
  const legCz = new Float32Array(sliceCount);
  const legRz = new Float32Array(sliceCount);

  let armTripleCount = 0;
  let legDoubleCount = 0;
  const headCxSamples: number[] = [];
  const headCzSamples: number[] = [];
  const visorTipSamples: number[] = [];
  const handZMaxSamples: number[] = [];
  const bootBackSamples: number[] = [];
  const bootFrontSamples: number[] = [];

  const validTorsoX = new Uint8Array(sliceCount);
  const validTorsoZ = new Uint8Array(sliceCount);
  const validLegX = new Uint8Array(sliceCount);

  for (let i = 0; i < sliceCount; i++) {
    const t = i / (sliceCount - 1);
    const iv0 = sampleRowIntervalsMeters(v0, camParams, t, 1);
    const iv180 = sampleRowIntervalsMeters(v180, camParams, t, -1);
    const iv90 = sampleRowIntervalsMeters(v90, camParams, t, 1);
    const iv270 = sampleRowIntervalsMeters(v270, camParams, t, -1);

    if (t >= 0.34 && t <= 0.54 && (iv0.length >= 3 || iv180.length >= 3)) armTripleCount++;
    if (t >= 0.62 && t <= 0.92 && (iv0.length >= 2 || iv180.length >= 2)) legDoubleCount++;

    const xSpan0 = spanInterval(iv0);
    const xSpan180 = spanInterval(iv180);
    const zSpan90 = spanInterval(iv90);
    const zSpan270 = spanInterval(iv270);

    // 1. Head + Cap + Neck envelope
    const hMinX = xSpan0 && xSpan180 ? (xSpan0.min + xSpan180.min) * 0.5 : (xSpan0?.min ?? xSpan180?.min ?? -0.085);
    const hMaxX = xSpan0 && xSpan180 ? (xSpan0.max + xSpan180.max) * 0.5 : (xSpan0?.max ?? xSpan180?.max ?? 0.085);
    const rawHeadCx = (hMinX + hMaxX) * 0.5;
    const rawHeadRx = (hMaxX - hMinX) * 0.5;
    const maxAllowedHeadRx = t < 0.025 ? 0.088 : t <= 0.128 ? 0.095 : 0.080;
    const minAllowedHeadRx = t <= 0.04 ? 0.068 : 0.066;
    headCx[i] = t <= 0.025 ? 0 : clamp(rawHeadCx, -0.022, 0.022);
    headRx[i] = clamp(rawHeadRx, minAllowedHeadRx, maxAllowedHeadRx);

    const zMinRaw = zSpan90 && zSpan270 ? (zSpan90.min + zSpan270.min) * 0.5 : (zSpan90?.min ?? zSpan270?.min ?? -0.088);
    const zMaxRaw = zSpan90 && zSpan270 ? (zSpan90.max + zSpan270.max) * 0.5 : (zSpan90?.max ?? zSpan270?.max ?? 0.108);

    if (t >= 0.036 && t <= 0.066) {
      visorTipSamples.push(zMaxRaw);
    }
    if (t >= 0.49 && t <= 0.56) {
      handZMaxSamples.push(zMaxRaw);
    }
    if (t >= 0.06 && t <= 0.125) {
      headCxSamples.push(headCx[i]);
    }
    if (t >= 0.085 && t <= 0.14) {
      headCzSamples.push((zMinRaw + Math.min(zMaxRaw, 0.124)) * 0.5);
    }

    const maxSkullZ = t < 0.088 ? 0.106 : t <= 0.135 ? 0.122 : 0.096;
    const hMinZ = clamp(zMinRaw, -0.112, -0.055);
    const hMaxZ = clamp(zMaxRaw, 0.055, maxSkullZ);
    headCz[i] = (hMinZ + hMaxZ) * 0.5;
    headRz[i] = clamp((hMaxZ - hMinZ) * 0.5, 0.072, 0.110);

    // 2. Torso & Unified Shoulder/Sleeve Span
    const fullSpanMin = xSpan0 && xSpan180 ? (xSpan0.min + xSpan180.min) * 0.5 : (xSpan0?.min ?? xSpan180?.min ?? -0.18);
    const fullSpanMax = xSpan0 && xSpan180 ? (xSpan0.max + xSpan180.max) * 0.5 : (xSpan0?.max ?? xSpan180?.max ?? 0.18);
    const fullHalf = clamp((fullSpanMax - fullSpanMin) * 0.5, 0.065, 0.345);
    sleeveRx[i] = fullHalf;

    let foundMidTorso = false;
    if (t >= 0.335 && t <= 0.56) {
      const central0 = iv0.find(
        (iv) => iv.max - iv.min >= 0.12 && iv.max - iv.min <= 0.41 && Math.abs((iv.min + iv.max) * 0.5) <= 0.055,
      );
      const central180 = iv180.find(
        (iv) => iv.max - iv.min >= 0.12 && iv.max - iv.min <= 0.41 && Math.abs((iv.min + iv.max) * 0.5) <= 0.055,
      );
      if (central0 || central180) {
        const cMin = central0 && central180 ? (central0.min + central180.min) * 0.5 : (central0?.min ?? central180!.min);
        const cMax = central0 && central180 ? (central0.max + central180.max) * 0.5 : (central0?.max ?? central180!.max);
        const maxTorsoHalf = t >= 0.42 ? 0.194 : 0.205;
        torsoCx[i] = clamp((cMin + cMax) * 0.5, -0.018, 0.018);
        torsoRx[i] = clamp((cMax - cMin) * 0.5, 0.115, maxTorsoHalf);
        validTorsoX[i] = 1;
        foundMidTorso = true;
      }
    }
    if (!foundMidTorso && t < 0.185) {
      torsoCx[i] = clamp((fullSpanMin + fullSpanMax) * 0.5, -0.018, 0.018);
      torsoRx[i] = Math.min(0.145, fullHalf);
      validTorsoX[i] = 1;
    }

    // Torso Z sampled across chest & upper abdomen (t <= 0.47) and pelvis (0.58..0.66); hands only protrude in t ~ 0.48..0.57
    if ((t >= 0.16 && t <= 0.47) || (t >= 0.58 && t <= 0.66)) {
      const tMinZ = clamp(zMinRaw, -0.154, -0.065);
      const maxFrontZ = t <= 0.47 ? 0.142 : 0.105;
      const tMaxZ = clamp(zMaxRaw, 0.055, maxFrontZ);
      torsoCz[i] = (tMinZ + tMaxZ) * 0.5;
      torsoRz[i] = clamp((tMaxZ - tMinZ) * 0.5, 0.075, 0.142);
      validTorsoZ[i] = 1;
    }

    // 3. Arms: average 0° and 180° outer arm intervals for balanced bicep/forearm thickness
    if (t >= 0.34 && t <= 0.58) {
      const rInt0 = iv0.find((iv) => iv.max <= -0.175 && iv.max - iv.min >= 0.025 && iv.max - iv.min <= 0.135);
      const rInt180 = iv180.find((iv) => iv.max <= -0.175 && iv.max - iv.min >= 0.025 && iv.max - iv.min <= 0.135);
      const lInt0 = [...iv0].reverse().find((iv) => iv.min >= 0.175 && iv.max - iv.min >= 0.025 && iv.max - iv.min <= 0.135);
      const lInt180 = [...iv180].reverse().find((iv) => iv.min >= 0.175 && iv.max - iv.min >= 0.025 && iv.max - iv.min <= 0.135);

      if (rInt0 || rInt180) {
        const cMin = rInt0 && rInt180 ? (rInt0.min + rInt180.min) * 0.5 : (rInt0?.min ?? rInt180!.min);
        const cMax = rInt0 && rInt180 ? (rInt0.max + rInt180.max) * 0.5 : (rInt0?.max ?? rInt180!.max);
        rArmCx[i] = (cMin + cMax) * 0.5;
        rArmRx[i] = clamp((cMax - cMin) * 0.5, 0.030, 0.058);
      }
      if (lInt0 || lInt180) {
        const cMin = lInt0 && lInt180 ? (lInt0.min + lInt180.min) * 0.5 : (lInt0?.min ?? lInt180!.min);
        const cMax = lInt0 && lInt180 ? (lInt0.max + lInt180.max) * 0.5 : (lInt0?.max ?? lInt180!.max);
        lArmCx[i] = (cMin + cMax) * 0.5;
        lArmRx[i] = clamp((cMax - cMin) * 0.5, 0.030, 0.058);
      }
    }

    // 4. Legs & Boots
    const legMaxAbs = t <= 0.60 ? 0.225 : 0.32;
    const legRuns0 = iv0.filter((iv) => iv.min > -legMaxAbs && iv.max < legMaxAbs && iv.max - iv.min >= 0.036);
    const legRuns180 = iv180.filter((iv) => iv.min > -legMaxAbs && iv.max < legMaxAbs && iv.max - iv.min >= 0.036);
    if (t >= 0.59 && (legRuns0.length >= 2 || legRuns180.length >= 2)) {
      const r0 = legRuns0.length >= 2 ? legRuns0[0] : legRuns180[0];
      const r180 = legRuns180.length >= 2 ? legRuns180[0] : legRuns0[0];
      const l0 = legRuns0.length >= 2 ? legRuns0[legRuns0.length - 1] : legRuns180[legRuns180.length - 1];
      const l180 = legRuns180.length >= 2 ? legRuns180[legRuns180.length - 1] : legRuns0[legRuns0.length - 1];

      const rMin = (r0.min + r180.min) * 0.5;
      const rMax = (r0.max + r180.max) * 0.5;
      const lMin = (l0.min + l180.min) * 0.5;
      const lMax = (l0.max + l180.max) * 0.5;

      rLegCx[i] = (rMin + rMax) * 0.5;
      rLegRx[i] = clamp((rMax - rMin) * 0.5, 0.042, 0.102);
      lLegCx[i] = (lMin + lMax) * 0.5;
      lLegRx[i] = clamp((lMax - lMin) * 0.5, 0.042, 0.102);
      validLegX[i] = 1;
    }

    if (t >= 0.60 && t <= 0.89) {
      const lMinZ = clamp(zMinRaw, -0.122, -0.052);
      const maxFrontCap = t >= 0.76 ? lerp(0.066, 0.038, smoothstep(0.76, 0.89, t)) : 0.088;
      const lMaxZ = clamp(zMaxRaw, -0.010, maxFrontCap);
      legCz[i] = (lMinZ + lMaxZ) * 0.5;
      const maxCalfRz = t >= 0.74 ? lerp(0.074, 0.052, smoothstep(0.74, 0.90, t)) : 0.094;
      legRz[i] = clamp((lMaxZ - lMinZ) * 0.5, 0.048, maxCalfRz);
    } else if (t > 0.89) {
      legCz[i] = legCz[Math.max(0, i - 1)] || -0.036;
      legRz[i] = 0.052;
      if (t >= 0.915 && t <= 0.975) {
        bootBackSamples.push(clamp(zMinRaw, -0.125, -0.075));
        bootFrontSamples.push(clamp(zMaxRaw, 0.105, 0.165));
      }
    } else {
      legCz[i] = -0.015;
      legRz[i] = 0.088;
    }
  }

  // Fill upper leg slices (t < 0.60) smoothly from top valid thigh slice
  let firstValidLeg = -1;
  let lastValidLeg = -1;
  for (let i = 0; i < sliceCount; i++) {
    if (validLegX[i]) {
      if (firstValidLeg === -1) firstValidLeg = i;
      lastValidLeg = i;
    }
  }
  for (let i = 0; i < sliceCount; i++) {
    if (validLegX[i]) continue;
    if (firstValidLeg >= 0 && i < firstValidLeg) {
      const hipT = smoothstep(Math.max(0, firstValidLeg - 12), firstValidLeg, i);
      const baseRx = Math.max(0.088, rLegRx[firstValidLeg]);
      const baseLx = Math.max(0.088, lLegRx[firstValidLeg]);
      rLegCx[i] = lerp(rLegCx[firstValidLeg] * 0.95, rLegCx[firstValidLeg], hipT);
      lLegCx[i] = lerp(lLegCx[firstValidLeg] * 0.95, lLegCx[firstValidLeg], hipT);
      rLegRx[i] = lerp(baseRx + 0.008, rLegRx[firstValidLeg], hipT);
      lLegRx[i] = lerp(baseLx + 0.008, lLegRx[firstValidLeg], hipT);
    } else if (lastValidLeg >= 0 && i > lastValidLeg) {
      rLegCx[i] = rLegCx[lastValidLeg];
      rLegRx[i] = rLegRx[lastValidLeg];
      lLegCx[i] = lLegCx[lastValidLeg];
      lLegRx[i] = lLegRx[lastValidLeg];
    } else {
      rLegCx[i] = -0.112;
      rLegRx[i] = 0.082;
      lLegCx[i] = 0.112;
      lLegRx[i] = 0.082;
    }
  }

  // Smooth out fabric-fold pinches along thigh/knee zone
  const iHip = Math.round(0.58 * (sliceCount - 1));
  const iKnee = Math.round(0.76 * (sliceCount - 1));
  for (let i = iHip; i <= iKnee; i++) {
    const f = (i - iHip) / Math.max(1, iKnee - iHip);
    const minOuterR = lerp(rLegCx[iHip] - rLegRx[iHip], rLegCx[iKnee] - rLegRx[iKnee], f);
    const maxOuterL = lerp(lLegCx[iHip] + lLegRx[iHip], lLegCx[iKnee] + lLegRx[iKnee], f);
    const curOuterR = rLegCx[i] - rLegRx[i];
    if (curOuterR > minOuterR + 0.004) {
      const targetOuter = lerp(curOuterR, minOuterR, 0.78);
      const innerR = rLegCx[i] + rLegRx[i];
      rLegCx[i] = (targetOuter + innerR) * 0.5;
      rLegRx[i] = (innerR - targetOuter) * 0.5;
    }
    const curOuterL = lLegCx[i] + lLegRx[i];
    if (curOuterL < maxOuterL - 0.004) {
      const targetOuter = lerp(curOuterL, maxOuterL, 0.78);
      const innerL = lLegCx[i] - lLegRx[i];
      lLegCx[i] = (innerL + targetOuter) * 0.5;
      lLegRx[i] = (targetOuter - innerL) * 0.5;
    }
  }

  // Interpolate core torso X smoothly across upper chest / shoulder zone (t in 0.18..0.34)
  for (let i = 0; i < sliceCount; i++) {
    const t = i / (sliceCount - 1);
    if (!validTorsoX[i]) {
      let prev = i - 1;
      while (prev >= 0 && !validTorsoX[prev]) prev--;
      let next = i + 1;
      while (next < sliceCount && !validTorsoX[next]) next++;

      if (prev >= 0 && next < sliceCount) {
        const f = smoothstep(prev, next, i);
        torsoCx[i] = lerp(torsoCx[prev], torsoCx[next], f);
        torsoRx[i] = lerp(torsoRx[prev], torsoRx[next], f);
      } else if (prev >= 0) {
        torsoCx[i] = torsoCx[prev];
        torsoRx[i] = torsoRx[prev];
      } else if (next < sliceCount) {
        torsoCx[i] = torsoCx[next];
        torsoRx[i] = torsoRx[next];
      } else {
        torsoRx[i] = 0.185;
      }
    }
    // Natural deltoid/pectoral broaden toward shoulder seam without bridging into sleeve cuffs
    if (t >= 0.175 && t <= 0.315) {
      const shFrac = smoothstep(0.175, 0.225, t) * (1 - smoothstep(0.255, 0.315, t));
      const targetCore = Math.max(torsoRx[i], lerp(torsoRx[i], Math.min(0.205, sleeveRx[i] * 0.65), shFrac));
      torsoRx[i] = Math.min(0.205, targetCore);
    }
  }

  // Smoothly interpolate torso Z across hand-overlap zone (t in 0.47..0.58)
  for (let i = 0; i < sliceCount; i++) {
    if (!validTorsoZ[i]) {
      let prev = i - 1;
      while (prev >= 0 && !validTorsoZ[prev]) prev--;
      let next = i + 1;
      while (next < sliceCount && !validTorsoZ[next]) next++;
      if (prev >= 0 && next < sliceCount) {
        const f = smoothstep(prev, next, i);
        torsoCz[i] = lerp(torsoCz[prev], torsoCz[next], f);
        torsoRz[i] = lerp(torsoRz[prev], torsoRz[next], f);
      } else if (prev >= 0) {
        torsoCz[i] = torsoCz[prev];
        torsoRz[i] = torsoRz[prev];
      } else if (next < sliceCount) {
        torsoCz[i] = torsoCz[next];
        torsoRz[i] = torsoRz[next];
      } else {
        torsoCz[i] = -0.005;
        torsoRz[i] = 0.125;
      }
    }
  }

  // Fill upper & lower arm slices coaxially into deltoid socket (smooth diagonal path from shoulder to bicep)
  const fillArmSide = (cxArr: Float32Array, rxArr: Float32Array, sign: number) => {
    for (let i = 0; i < sliceCount; i++) {
      const t = i / (sliceCount - 1);
      if (rxArr[i] > 0.001) continue;
      let prev = i - 1;
      while (prev >= 0 && rxArr[prev] <= 0.001) prev--;
      let next = i + 1;
      while (next < sliceCount && rxArr[next] <= 0.001) next++;

      if (prev >= 0 && next < sliceCount) {
        const f = smoothstep(prev, next, i);
        cxArr[i] = lerp(cxArr[prev], cxArr[next], f);
        rxArr[i] = lerp(rxArr[prev], rxArr[next], f);
      } else if (prev >= 0) {
        cxArr[i] = cxArr[prev];
        rxArr[i] = Math.max(0.024, rxArr[prev] * 0.94);
      } else if (next < sliceCount) {
        // Angle smoothly inward from bicep cuff up into deltoid shoulder socket (~0.168m)
        const nextT = next / (sliceCount - 1);
        const shF = smoothstep(0.20, nextT, t);
        const shoulderX = sign * Math.max(0.155, Math.abs(cxArr[next]) * 0.72);
        cxArr[i] = lerp(shoulderX, cxArr[next], shF);
        rxArr[i] = lerp(0.056, rxArr[next], shF);
      } else {
        cxArr[i] = sign * 0.255;
        rxArr[i] = 0.048;
      }
    }
  };
  fillArmSide(rArmCx, rArmRx, -1);
  fillArmSide(lArmCx, lArmRx, 1);

  const hasSeparatedArms = armTripleCount >= 3;
  const hasSeparatedLegs = legDoubleCount >= 4;
  const headCenterX = medianOf(headCxSamples, 0);
  const headCenterZ = clamp(medianOf(headCzSamples, 0.005), -0.025, 0.025);
  const visorTipZ = clamp(medianOf(visorTipSamples, 0.178), 0.155, 0.194);
  const handForwardZ = medianOf(handZMaxSamples, 0.108);
  const targetHandCz = clamp(handForwardZ - 0.054, 0.035, 0.088);

  // Forearm volume & natural elbow-to-hand forward sweep (calibrated from side silhouette front extent)
  for (let i = 0; i < sliceCount; i++) {
    const t = i / (sliceCount - 1);
    const upperToElbow = smoothstep(0.24, 0.39, t);
    const forearmForward = smoothstep(0.37, 0.535, t);
    const elbowCzR = lerp(-0.016, -0.002, upperToElbow);
    const elbowCzL = lerp(-0.008, 0.018, upperToElbow);
    const isHandZone = smoothstep(0.518, 0.565, t);
    const tipTaper = 1.0 - 0.42 * smoothstep(0.558, 0.592, t);

    const broadFrame = Math.abs(rArmCx[i]) > 0.235 || Math.abs(lArmCx[i]) > 0.235;
    const minForearmRx = broadFrame && t < 0.51 ? lerp(0.042, 0.028, smoothstep(0.35, 0.49, t)) : 0.024;
    const baseRxR = Math.max(minForearmRx, rArmRx[i]);
    const baseRxL = Math.max(minForearmRx, lArmRx[i]);

    rArmRz[i] = lerp(Math.max(0.045, baseRxR * 1.24), clamp(baseRxR * 1.38, 0.042, 0.052), isHandZone) * tipTaper;
    lArmRz[i] = lerp(Math.max(0.045, baseRxL * 1.24), clamp(baseRxL * 1.38, 0.042, 0.052), isHandZone) * tipTaper;
    rArmRx[i] = Math.max(0.022, baseRxR * lerp(1.0, 0.84, isHandZone) * tipTaper);
    lArmRx[i] = Math.max(0.022, baseRxL * lerp(1.0, 0.84, isHandZone) * tipTaper);

    // Ensure clean air-gap between bare arms and torso below sleeve cuff
    if (hasSeparatedArms && t >= 0.345 && t <= 0.585) {
      const minGapCxR = torsoCx[i] - torsoRx[i] - rArmRx[i] - 0.024;
      const minGapCxL = torsoCx[i] + torsoRx[i] + lArmRx[i] + 0.024;
      rArmCx[i] = Math.min(rArmCx[i], minGapCxR);
      lArmCx[i] = Math.max(lArmCx[i], minGapCxL);
    }

    const rZ = lerp(elbowCzR, targetHandCz, forearmForward);
    const lZ = lerp(elbowCzL, targetHandCz, forearmForward);
    rArmCz[i] = rZ;
    lArmCz[i] = lZ;
    // Compensate forward Z perspective in 0° silhouette so inner arm edge stays inside 0° mask
    if (t >= 0.36 && t <= 0.58) {
      rArmCx[i] *= camParams.cameraDistance / Math.max(1, camParams.cameraDistance - Math.max(0, rZ) * 0.45);
      lArmCx[i] *= camParams.cameraDistance / Math.max(1, camParams.cameraDistance - Math.max(0, lZ) * 0.45);
    }
  }

  smoothArray(headCx, 4);
  smoothArray(headRx, 3);
  smoothArray(headCz, 3);
  smoothArray(headRz, 3);
  smoothArray(torsoCx, 5);
  smoothArray(torsoRx, 5);
  smoothArray(sleeveRx, 4);
  smoothArray(torsoCz, 5);
  smoothArray(torsoRz, 5);
  smoothArray(rArmCx, 5);
  smoothArray(rArmRx, 4);
  smoothArray(rArmRz, 4);
  smoothArray(lArmCx, 5);
  smoothArray(lArmRx, 4);
  smoothArray(lArmRz, 4);
  smoothArray(rLegCx, 6);
  smoothArray(rLegRx, 6);
  smoothArray(lLegCx, 6);
  smoothArray(lLegRx, 6);
  smoothArray(legCz, 5);
  smoothArray(legRz, 5);

  const ankleSlice = Math.round(0.92 * (sliceCount - 1));
  const rBootX = clamp(rLegCx[ankleSlice], -0.23, -0.095);
  const lBootX = clamp(lLegCx[ankleSlice], 0.095, 0.23);
  const bootBackZ = clamp(medianOf(bootBackSamples, -0.102), -0.125, -0.075);
  const bootFrontZ = clamp(medianOf(bootFrontSamples, 0.138), 0.105, 0.165);
  const bootZCenter = legCz[ankleSlice];

  return {
    subjectHeight: camParams.subjectHeight,
    sliceCount,
    headCenterX,
    headCenterZ,
    hasSeparatedArms,
    hasSeparatedLegs,
    headCx,
    headRx,
    headCz,
    headRz,
    visorTipZ,
    torsoCx,
    torsoRx,
    sleeveRx,
    torsoCz,
    torsoRz,
    rArmCx,
    rArmCz,
    rArmRx,
    rArmRz,
    lArmCx,
    lArmCz,
    lArmRx,
    lArmRz,
    rLegCx,
    rLegRx,
    lLegCx,
    lLegRx,
    legCz,
    legRz,
    rBootX,
    lBootX,
    bootZCenter,
    bootBackZ,
    bootFrontZ,
  };
}

function superEllipse2D(dx: number, dz: number, rx: number, rz: number, p: number): number {
  const ax = Math.abs(dx) / Math.max(0.004, rx);
  const az = Math.abs(dz) / Math.max(0.004, rz);
  const s = Math.pow(ax, p) + Math.pow(az, p);
  const r = Math.pow(s, 1 / p);
  return (r - 1.0) * Math.min(rx, rz);
}

/**
 * Head + sculpted facial features + solid muscular neck + fitted NY baseball cap crown & curved visor.
 */
function evaluateHeadAndCapSdf(
  x: number,
  y: number,
  z: number,
  t: number,
  profile: AnatomicalProfile,
): number {
  const H = profile.subjectHeight;
  const n = profile.sliceCount;
  if (y < H * 0.78 || y > H + 0.03 || Math.abs(x) > 0.19 || Math.abs(z) > 0.25) {
    return 0.5;
  }

  const cx = sampleSlice(profile.headCx, t, n);
  const rx = sampleSlice(profile.headRx, t, n);
  const cz = sampleSlice(profile.headCz, t, n);
  const rz = sampleSlice(profile.headRz, t, n);

  const dx = x - cx;
  const dz = z - cz;

  const jawSquare = smoothstep(0.08, 0.12, t) * (1 - smoothstep(0.135, 0.165, t));
  const pHead = lerp(2.08, 2.38, jawSquare);
  let dSkull = superEllipse2D(dx, dz, rx, rz, pHead);

  const topCap = y - H * 0.996;
  const domeRound = (1.0 - smoothstep(0.0, 0.032, t)) * 0.022;
  dSkull = smoothMax(dSkull + domeRound, topCap, 0.015);
  dSkull = Math.max(dSkull, H * 0.805 - y);

  // Subtle anatomical facial relief (brow, eyes, nose bridge/tip, chin)
  if (dz > 0.02 && y > H - 0.25 && y < H - 0.105) {
    const faceX = dx;
    const browBand = Math.exp(-Math.pow((y - (H - 0.132)) / 0.012, 2)) * Math.exp(-Math.pow(faceX / 0.048, 2));
    const eyeL = Math.exp(-Math.pow((y - (H - 0.152)) / 0.011, 2)) * Math.exp(-Math.pow((faceX - 0.029) / 0.014, 2));
    const eyeR = Math.exp(-Math.pow((y - (H - 0.152)) / 0.011, 2)) * Math.exp(-Math.pow((faceX + 0.029) / 0.014, 2));
    const noseV = smoothstep(H - 0.196, H - 0.180, y) * (1 - smoothstep(H - 0.146, H - 0.126, y));
    const noseTip = Math.exp(-Math.pow((y - (H - 0.178)) / 0.014, 2));
    const noseW = lerp(0.010, 0.014, noseTip);
    const noseRelief = noseV * Math.exp(-Math.pow(faceX / noseW, 2)) * (0.003 + 0.005 * noseTip);
    const chinMass = Math.exp(-Math.pow((y - (H - 0.242)) / 0.018, 2)) * Math.exp(-Math.pow(faceX / 0.035, 2));

    dSkull -= browBand * 0.0025 - (eyeL + eyeR) * 0.0045 + noseRelief + chinMass * 0.0025;
  }

  // Ears on sides of head
  const earY = H - 0.162;
  const earZ = cz - 0.016;
  const earDx = Math.abs(dx) - (rx - 0.003);
  const earDy = (y - earY) / 0.024;
  const earDz = (z - earZ) / 0.013;
  const dEar = Math.hypot(Math.max(0, earDx), earDy * 0.013, earDz * 0.013) - 0.009;
  dSkull = smoothMin(dSkull, dEar, 0.005);

  // Fitted 6-panel baseball cap crown
  const crownBot = H - 0.098 - 0.010 * smoothstep(0.03, 0.08, Math.abs(dx)) + 0.010 * smoothstep(-0.04, -0.07, dz);
  if (y >= crownBot - 0.015) {
    const capExpand = 0.004 * smoothstep(crownBot - 0.004, crownBot + 0.014, y);
    let dCrown = superEllipse2D(dx, dz, rx + capExpand, rz + capExpand, 2.12);
    dCrown = smoothMax(dCrown + domeRound, y - H * 0.999, 0.015);
    dCrown = smoothMax(dCrown, crownBot - y, 0.004);
    if (dz < -0.055 && y < H - 0.085 && Math.abs(dx) < 0.042) {
      dCrown += 0.005;
    }
    dSkull = smoothMin(dSkull, dCrown, 0.0035);
  }

  // Natural curved NY cap visor projecting cleanly at measured brow height (y ~ 1.673..1.712m)
  const visorZStart = cz + 0.072;
  const visorZEnd = Math.max(cz + 0.168, profile.visorTipZ);
  if (z >= visorZStart - 0.015 && y >= H - 0.125 && y <= H - 0.045) {
    const zClamped = clamp(z, visorZStart, visorZEnd);
    const zp = (zClamped - visorZStart) / (visorZEnd - visorZStart);
    const halfW = lerp(rx + 0.003, 0.056, Math.pow(zp, 1.55));
    const xClamped = clamp(dx, -halfW, halfW);
    const archDrop = xClamped * xClamped * 1.15;
    const visorY = H - 0.074 - zp * 0.014 - archDrop;
    const dVisor = Math.hypot(dx - xClamped, y - visorY, z - zClamped) - 0.0046;
    dSkull = smoothMin(dSkull, dVisor, 0.0025);
  }

  return dSkull;
}

/**
 * Core torso + clean dropped-shoulder slope + coaxially draped short sleeves (no boxy armpit shelf!).
 */
function evaluateTorsoAndSleevesSdf(
  x: number,
  y: number,
  z: number,
  t: number,
  profile: AnatomicalProfile,
): number {
  const H = profile.subjectHeight;
  const n = profile.sliceCount;
  if (y < H * 0.42 || y > H * 0.87 || Math.abs(x) > 0.39 || Math.abs(z) > 0.25) {
    return 0.5;
  }

  const cx = sampleSlice(profile.torsoCx, t, n);
  const rx = sampleSlice(profile.torsoRx, t, n);
  const cz = sampleSlice(profile.torsoCz, t, n);
  const rz = sampleSlice(profile.torsoRz, t, n);

  const dx = x - cx;
  const dz = z - cz;

  const chestSquare = smoothstep(0.18, 0.28, t) * (1 - smoothstep(0.35, 0.52, t));
  const pTorso = lerp(2.08, 2.28, chestSquare);
  const theta = Math.atan2(dx, dz);
  const clothFold =
    smoothstep(0.24, 0.42, t) * (1 - smoothstep(0.51, 0.555, t)) * 0.0020 * Math.sin(theta * 5.0 + y * 4.0);

  let dTorso = superEllipse2D(dx, dz, rx + clothFold, rz + clothFold, pTorso);

  const hemY = H * 0.456;
  const hemRim = Math.exp(-Math.pow((y - hemY) / 0.011, 2)) * 0.0025;
  dTorso -= hemRim;

  const topCap = y - H * 0.845;
  const botCap = H * 0.448 - y;
  dTorso = smoothMax(dTorso, Math.max(topCap, botCap), 0.014);

  // Coaxial dropped-shoulder sleeves: follow natural sloped trapezius-to-deltoid contour (zero flat horns!)
  if (t >= 0.165 && t <= 0.355) {
    const sleeveHalf = sampleSlice(profile.sleeveRx, t, n);

    // 1. Upper shoulder trap/collar bridge (t in 0.165..0.265) sloping downward with |x|
    if (t <= 0.265 && sleeveHalf > rx + 0.005) {
      const collarDrop = smoothstep(0.165, 0.235, t);
      const bridgeRx = lerp(rx, Math.min(sleeveHalf, rx + 0.102), collarDrop);
      const lateralFrac = clamp((Math.abs(dx) - rx * 0.35) / Math.max(0.05, bridgeRx - rx * 0.35), 0, 1);
      const bridgeRz = lerp(rz * 0.92, 0.072, lateralFrac);
      const bridgeZ = lerp(cz, -0.010, lateralFrac * collarDrop);
      let dShoulder = superEllipse2D(dx, z - bridgeZ, bridgeRx, bridgeRz, 2.15);
      const shTopY = lerp(H * 0.836, H * 0.766, lateralFrac);
      dShoulder = smoothMax(dShoulder, Math.max(y - shTopY, H * 0.742 - y), 0.018);
      dTorso = smoothMin(dTorso, dShoulder, 0.016);
    }

    // 2. Coaxial cylindrical sleeve tubes (right -X and left +X) hugging the upper arms below the shoulder slope
    if (profile.hasSeparatedArms) {
      for (const side of [-1, 1] as const) {
        if (side === -1 && x > -0.05) continue;
        if (side === 1 && x < 0.05) continue;

        const armCx = sampleSlice(side === -1 ? profile.rArmCx : profile.lArmCx, t, n);
        const armCz = sampleSlice(side === -1 ? profile.rArmCz : profile.lArmCz, t, n);
        const armRx = sampleSlice(side === -1 ? profile.rArmRx : profile.lArmRx, t, n);
        const armRz = sampleSlice(side === -1 ? profile.rArmRz : profile.lArmRz, t, n);

        // Measure outer sleeve extent from full-span profile so sleeve matches actual draped tee width
        const outerEdge = Math.max(Math.abs(armCx) + armRx + 0.014, sleeveHalf * 0.985);
        const sleeveRadiusX = clamp((outerEdge - (Math.abs(armCx) - armRx * 0.95)) * 0.56, armRx + 0.014, 0.095);
        const sleeveCenterX = side * (outerEdge - sleeveRadiusX);
        const sleeveRadiusZ = clamp(Math.max(armRz + 0.020, sleeveRadiusX * 0.96), 0.064, 0.092);

        let dSleeveTube = superEllipse2D(x - sleeveCenterX, z - armCz, sleeveRadiusX, sleeveRadiusZ, 2.08);
        // Natural tilted sleeve cuff & sloped top so outer deltoid never spikes above shoulder line
        const outerBias = clamp((Math.abs(x) - (Math.abs(armCx) - 0.04)) / 0.10, 0, 1);
        const cuffY = lerp(H * 0.650, H * 0.668, outerBias);
        const xSlopeFrac = smoothstep(0.11, 0.30, Math.abs(x));
        const sleeveTopY = lerp(H * 0.816, H * 0.722, xSlopeFrac);
        dSleeveTube = smoothMax(dSleeveTube, y - sleeveTopY, 0.020);
        dSleeveTube = smoothMax(dSleeveTube, cuffY - y, 0.010);

        dTorso = smoothMin(dTorso, dSleeveTube, 0.018);
      }
    }
  }

  return dTorso;
}

/**
 * Continuous muscular arm emerging coaxially from inside the sleeve down to elbow, forearm, and rounded hand.
 */
function evaluateArmSdf(
  x: number,
  y: number,
  z: number,
  t: number,
  profile: AnatomicalProfile,
  side: 'right' | 'left',
): number {
  const H = profile.subjectHeight;
  const n = profile.sliceCount;
  if (!profile.hasSeparatedArms || y < H * 0.402 || y > H * 0.77) {
    return 0.5;
  }
  if (side === 'right' && x > -0.08) return 0.5;
  if (side === 'left' && x < 0.08) return 0.5;

  const cx = sampleSlice(side === 'right' ? profile.rArmCx : profile.lArmCx, t, n);
  const cz = sampleSlice(side === 'right' ? profile.rArmCz : profile.lArmCz, t, n);
  const rx = sampleSlice(side === 'right' ? profile.rArmRx : profile.lArmRx, t, n);
  const rz = sampleSlice(side === 'right' ? profile.rArmRz : profile.lArmRz, t, n);

  const dx = x - cx;
  const dz = z - cz;
  let dArm = superEllipse2D(dx, dz, rx, rz, 2.04);

  const forearmSwell = Math.exp(-Math.pow((t - 0.425) / 0.045, 2)) * 0.0022;
  dArm -= forearmSwell;

  const botLimit = H * 0.418;
  const topLimit = H * 0.75;
  dArm = smoothMax(dArm, Math.max(botLimit - y, y - topLimit), 0.012);

  return dArm;
}

/**
 * Sleek Chelsea boot SDF anchored directly below the ankle shaft.
 */
function evaluateChelseaBootSdf(
  x: number,
  y: number,
  z: number,
  footX: number,
  footZ: number,
  yawRad: number,
  _backZ: number,
  frontZ: number,
): number {
  if (y > 0.165 || y < -0.02) return 0.5;
  const rx = x - footX;
  const rz = z - footZ;
  const cosA = Math.cos(yawRad);
  const sinA = Math.sin(yawRad);
  const lx = rx * cosA - rz * sinA;
  const lz = rx * sinA + rz * cosA;

  let dShaft = superEllipse2D(lx, lz, 0.042, 0.049, 2.05);
  dShaft = smoothMax(dShaft, Math.max(0.032 - y, y - 0.145), 0.008);

  const zStart = -0.048;
  const zEnd = clamp(frontZ - footZ, 0.145, 0.175);
  const zClamped = clamp(lz, zStart, zEnd);
  const toeFrac = clamp((zClamped - zStart) / (zEnd - zStart), 0, 1);

  const halfW = lerp(0.038, 0.044, Math.sin(toeFrac * Math.PI * 0.72)) * (1 - 0.34 * Math.pow(toeFrac, 3.0));
  const topY = lerp(0.064, 0.022, smoothstep(0.18, 0.94, toeFrac));
  const botY = 0.006;

  const yClamped = clamp(y, botY, topY);
  const xClamped = clamp(lx, -halfW * 0.54, halfW * 0.54);
  const distCore = Math.hypot(lx - xClamped, y - yClamped, lz - zClamped);
  const radius = lerp(0.017, 0.013, toeFrac);
  let dFoot = distCore - radius;

  if (y < 0.014 && toeFrac > 0.24 && toeFrac < 0.44) {
    const archDepth = Math.sin(((toeFrac - 0.24) / 0.20) * Math.PI) * 0.005;
    dFoot = Math.max(dFoot, archDepth - y);
  }

  const dBoot = smoothMin(dShaft, dFoot, 0.014);
  return Math.max(dBoot, -y);
}

/**
 * Slim black jeans legs + organic pelvis bridge above crotch + grounded Chelsea boots.
 */
function evaluateLegsAndBootsSdf(
  x: number,
  y: number,
  z: number,
  t: number,
  profile: AnatomicalProfile,
): number {
  const H = profile.subjectHeight;
  const n = profile.sliceCount;
  if (y > H * 0.505 || y < -0.02) return 0.5;

  const rCx = sampleSlice(profile.rLegCx, t, n);
  const rRx = sampleSlice(profile.rLegRx, t, n);
  const lCx = sampleSlice(profile.lLegCx, t, n);
  const lRx = sampleSlice(profile.lLegRx, t, n);
  const cz = sampleSlice(profile.legCz, t, n);
  const rz = sampleSlice(profile.legRz, t, n);

  const pLeg = 2.08;
  let dRLeg = superEllipse2D(x - rCx, z - cz, rRx, rz, pLeg);
  let dLLeg = superEllipse2D(x - lCx, z - cz, lRx, rz, pLeg);

  const legTop = y - H * 0.476;
  const cuffBot = 0.092 - y;
  dRLeg = smoothMax(dRLeg, Math.max(legTop, cuffBot), 0.012);
  dLLeg = smoothMax(dLLeg, Math.max(legTop, cuffBot), 0.012);

  if (y < 0.165) {
    const rBoot = evaluateChelseaBootSdf(
      x,
      y,
      z,
      profile.rBootX,
      profile.bootZCenter,
      -0.24,
      profile.bootBackZ,
      profile.bootFrontZ,
    );
    const lBoot = evaluateChelseaBootSdf(
      x,
      y,
      z,
      profile.lBootX,
      profile.bootZCenter,
      0.24,
      profile.bootBackZ,
      profile.bootFrontZ,
    );
    dRLeg = smoothMin(dRLeg, rBoot, 0.014);
    dLLeg = smoothMin(dLLeg, lBoot, 0.014);
  }

  let dLegs = profile.hasSeparatedLegs ? Math.min(dRLeg, dLLeg) : smoothMin(dRLeg, dLLeg, 0.025);
  if (y > H * 0.398) {
    const pelvisSmooth = smoothstep(H * 0.398, H * 0.445, y) * 0.036;
    dLegs = smoothMin(dRLeg, dLLeg, pelvisSmooth);
  }

  return dLegs;
}

/**
 * Evaluates the Silhouette-Calibrated Anatomical SDF + soft part weights at (x, y, z).
 */
export function evaluateAnatomicalPartSdfs(
  x: number,
  y: number,
  z: number,
  profile: AnatomicalProfile,
): PartSdfSample {
  const H = profile.subjectHeight;
  if (x < -0.40 || x > 0.40 || z < -0.28 || z > 0.28 || y < -0.02 || y > H + 0.03) {
    return { sdf: 0.18, wHead: 0, wTorso: 0, wRightArm: 0, wLeftArm: 0 };
  }

  const t = clamp(1.0 - y / H, 0, 1);

  const dHead = evaluateHeadAndCapSdf(x, y, z, t, profile);
  const dTorso = evaluateTorsoAndSleevesSdf(x, y, z, t, profile);
  const dRightArm = evaluateArmSdf(x, y, z, t, profile, 'right');
  const dLeftArm = evaluateArmSdf(x, y, z, t, profile, 'left');
  const dLegs = evaluateLegsAndBootsSdf(x, y, z, t, profile);

  let dBody = smoothMin(dHead, dTorso, 0.016);
  const shoulderBlend = smoothstep(H * 0.640, H * 0.720, y) * 0.020;
  dBody = smoothMin(dBody, dRightArm, shoulderBlend);
  dBody = smoothMin(dBody, dLeftArm, shoulderBlend);
  const hipBlend = smoothstep(H * 0.435, H * 0.470, y) * 0.020;
  const sdf = smoothMin(dBody, dLegs, hipBlend);

  const invTemp = y < H * 0.65 ? 1 / 0.015 : 1 / 0.022;
  const m = Math.min(dHead, dTorso, dRightArm, dLeftArm, dLegs);
  const eHead = Math.exp(clamp(-(dHead - m) * invTemp, -20, 0));
  const eTorso = Math.exp(clamp(-(dTorso - m) * invTemp, -20, 0));
  const eRArm = Math.exp(clamp(-(dRightArm - m) * invTemp, -20, 0));
  const eLArm = Math.exp(clamp(-(dLeftArm - m) * invTemp, -20, 0));
  const eLegs = Math.exp(clamp(-(dLegs - m) * invTemp, -20, 0));
  const sum = eHead + eTorso + eRArm + eLArm + eLegs + 1e-8;

  return {
    sdf,
    wHead: eHead / sum,
    wTorso: eTorso / sum,
    wRightArm: eRArm / sum,
    wLeftArm: eLArm / sum,
  };
}
