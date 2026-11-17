import * as THREE from 'three';
import {
  buildVisualHullMesh,
  compute2DSdf,
  createCalibratedViews,
  segmentStudioForeground,
  type SegmentationResult,
} from './sdfAndHull';
import {
  MAX_ATLAS_VIEWS,
  type CalibratedView,
  type ReconstructedMeshData,
  type ReconstructionSettings,
  type ViewSpec,
  type WorldCameraParams,
} from './types';

export interface LoadedDataset {
  views: CalibratedView[];
  textureViews: CalibratedView[];
  previewViews: ViewSpec[];
  camParams: WorldCameraParams;
  atlasTextures: THREE.CanvasTexture[];
  atlasCanvases: HTMLCanvasElement[];
  atlasCols: number;
  atlasRows: number;
  slotW: number;
  slotH: number;
}

type DecodedSource = HTMLImageElement | ImageBitmap | HTMLCanvasElement;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`No se pudo cargar la imagen: ${url}`));
    img.src = url;
  });
}

async function decodeViewSource(
  spec: ViewSpec,
  signal?: AbortSignal,
): Promise<{ source: DecodedSource; cleanup: () => void; width: number; height: number }> {
  if (spec.loadBlob) {
    const blob = await spec.loadBlob(signal);
    if (typeof createImageBitmap === 'function') {
      const bitmap = await createImageBitmap(blob);
      return {
        source: bitmap,
        cleanup: () => bitmap.close(),
        width: bitmap.width,
        height: bitmap.height,
      };
    }
    const objUrl = URL.createObjectURL(blob);
    try {
      const img = await loadImage(objUrl);
      return {
        source: img,
        cleanup: () => URL.revokeObjectURL(objUrl),
        width: img.naturalWidth,
        height: img.naturalHeight,
      };
    } catch (err) {
      URL.revokeObjectURL(objUrl);
      throw err;
    }
  }

  const img = await loadImage(spec.url);
  return {
    source: img,
    cleanup: () => {},
    width: img.naturalWidth,
    height: img.naturalHeight,
  };
}

function selectEvenIndices(total: number, maxCount: number): number[] {
  if (total <= maxCount) {
    return Array.from({ length: total }, (_, i) => i);
  }
  const indices: number[] = [];
  for (let i = 0; i < maxCount; i++) {
    indices.push(Math.floor((i * total) / maxCount));
  }
  return indices;
}

function sampleSdfNormalized(
  sdf: Float32Array,
  w: number,
  h: number,
  u: number,
  v: number,
): number {
  const px = Math.max(0, Math.min(w - 1, u * (w - 1)));
  const py = Math.max(0, Math.min(h - 1, v * (h - 1)));
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const fx = px - x0;
  const fy = py - y0;
  return (
    (sdf[y0 * w + x0] * (1 - fx) + sdf[y0 * w + x1] * fx) * (1 - fy) +
    (sdf[y1 * w + x0] * (1 - fx) + sdf[y1 * w + x1] * fx) * fy
  );
}

/**
 * Loads N studio/Drive images (8 up to 360) with bounded concurrency & immediate downscaling,
 * extracts calibrated silhouettes for all N views, and packs up to 36 evenly-spaced views into 4 atlases.
 */
export async function loadAndCalibrateViews(
  specs: ViewSpec[],
  onProgress?: (progress: number, stage: string) => void,
  signal?: AbortSignal,
): Promise<LoadedDataset> {
  const total = specs.length;
  const isDenseSet = total > 8;
  const analysisW = total > 72 ? 270 : total > 16 ? 360 : 540;
  const analysisH = total > 72 ? 480 : total > 16 ? 640 : 960;

  const textureIndices = selectEvenIndices(total, MAX_ATLAS_VIEWS);
  const textureIndexToPos = new Map<number, number>();
  textureIndices.forEach((idx, pos) => textureIndexToPos.set(idx, pos));

  const atlasCols = isDenseSet ? 5 : 2;
  const atlasRows = isDenseSet ? 2 : 1;
  const slotW = isDenseSet ? 512 : 1024;
  const slotH = isDenseSet ? 1024 : 2048;
  const atlasW = atlasCols * slotW;
  const atlasH = atlasRows * slotH;
  const viewsPerAtlas = atlasCols * atlasRows;

  const segmentations: SegmentationResult[] = new Array(total);
  const texSources: Array<HTMLCanvasElement | null> = new Array(textureIndices.length).fill(null);
  const previewSpecs: ViewSpec[] = textureIndices.map((idx) => specs[idx]);

  onProgress?.(0.03, `Cargando 0/${total} perfiles fotográficos...`);

  const concurrency = isDenseSet ? 5 : 8;
  let nextIdx = 0;
  let completed = 0;

  const workers = Array.from({ length: Math.min(concurrency, total) }, async () => {
    const analysisCanvas = document.createElement('canvas');
    analysisCanvas.width = analysisW;
    analysisCanvas.height = analysisH;
    const analysisCtx = analysisCanvas.getContext('2d', { willReadFrequently: true })!;

    while (true) {
      if (signal?.aborted) {
        throw new DOMException('Reconstrucción cancelada.', 'AbortError');
      }
      const idx = nextIdx++;
      if (idx >= total) break;

      const spec = specs[idx];
      const decoded = await decodeViewSource(spec, signal);
      try {
        analysisCtx.clearRect(0, 0, analysisW, analysisH);
        analysisCtx.drawImage(decoded.source, 0, 0, analysisW, analysisH);
        const imgData = analysisCtx.getImageData(0, 0, analysisW, analysisH);
        segmentations[idx] = segmentStudioForeground(imgData.data, analysisW, analysisH);

        const texPos = textureIndexToPos.get(idx);
        if (texPos !== undefined) {
          // Retain a compact downscaled RGB copy (at most 1024x2048 for 8 views, 768x1366 for 36 views)
          const storeW = isDenseSet ? 768 : Math.min(2048, decoded.width);
          const storeH = isDenseSet ? 1366 : Math.min(3640, decoded.height);
          const texCanvas = document.createElement('canvas');
          texCanvas.width = storeW;
          texCanvas.height = storeH;
          const texCtx = texCanvas.getContext('2d')!;
          texCtx.drawImage(decoded.source, 0, 0, storeW, storeH);
          texSources[texPos] = texCanvas;

          if (!spec.url) {
            const previewBlob = await new Promise<Blob | null>((resolve) =>
              texCanvas.toBlob(resolve, 'image/jpeg', 0.84),
            );
            if (previewBlob) {
              previewSpecs[texPos] = {
                ...spec,
                url: URL.createObjectURL(previewBlob),
              };
            }
          }
        }
      } finally {
        decoded.cleanup();
      }

      completed++;
      const frac = completed / total;
      onProgress?.(
        0.04 + frac * 0.56,
        `Descargando y segmentando vista ${completed}/${total}...`,
      );
    }
  });

  try {
    await Promise.all(workers);
  } catch (err) {
    for (const ps of previewSpecs) {
      if (ps.url.startsWith('blob:')) URL.revokeObjectURL(ps.url);
    }
    throw err;
  }

  onProgress?.(0.62, `Calibrando ejes en ${total} vistas...`);
  const { views, camParams } = createCalibratedViews(specs, segmentations, analysisW, analysisH);

  const textureViews: CalibratedView[] = textureIndices.map((viewIdx, pos) => {
    const base = views[viewIdx];
    return {
      ...base,
      atlasIndex: Math.floor(pos / viewsPerAtlas),
      atlasSlot: pos % viewsPerAtlas,
    };
  });

  onProgress?.(0.68, `Generando atlas de texturas (${textureViews.length} vistas)...`);
  const atlasCanvases: HTMLCanvasElement[] = [];
  const atlasTextures: THREE.CanvasTexture[] = [];
  const numAtlases = Math.max(1, Math.min(4, Math.ceil(textureViews.length / viewsPerAtlas)));

  for (let a = 0; a < 4; a++) {
    const canvas = document.createElement('canvas');
    if (a >= numAtlases) {
      // Minimal 4x4 placeholder for unused atlas samplers so WebGL always binds valid textures
      canvas.width = 4;
      canvas.height = 4;
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      atlasCanvases.push(canvas);
      atlasTextures.push(tex);
      continue;
    }

    canvas.width = atlasW;
    canvas.height = atlasH;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

    for (let s = 0; s < viewsPerAtlas; s++) {
      const texPos = a * viewsPerAtlas + s;
      if (texPos >= textureViews.length) break;

      const view = textureViews[texPos];
      const srcCanvas = texSources[texPos];
      if (!srcCanvas) continue;

      const col = s % atlasCols;
      const row = Math.floor(s / atlasCols);
      const dx = col * slotW;
      const dy = row * slotH;

      const sx = view.cropU0 * srcCanvas.width;
      const sy = view.cropV0 * srcCanvas.height;
      const sw = (view.cropU1 - view.cropU0) * srcCanvas.width;
      const sh = (view.cropV1 - view.cropV0) * srcCanvas.height;

      ctx.drawImage(srcCanvas, sx, sy, sw, sh, dx, dy, slotW, slotH);

      // Cleanly bake foreground silhouette alpha strictly inside the subject so studio gray never bleeds
      const slotData = ctx.getImageData(dx, dy, slotW, slotH);
      const px = slotData.data;
      for (let py = 0; py < slotH; py++) {
        const vNorm = view.cropV0 + (py / (slotH - 1)) * (view.cropV1 - view.cropV0);
        for (let x = 0; x < slotW; x++) {
          const uNorm = view.cropU0 + (x / (slotW - 1)) * (view.cropU1 - view.cropU0);
          const sdfVal = sampleSdfNormalized(
            view.sdf2d,
            view.analysisWidth,
            view.analysisHeight,
            uNorm,
            vNorm,
          );
          const idx4 = (py * slotW + x) * 4;
          const r = px[idx4];
          const g = px[idx4 + 1];
          const b = px[idx4 + 2];
          const lum = r * 0.299 + g * 0.587 + b * 0.114;
          const chroma = Math.max(r, g, b) - Math.min(r, g, b);

          let alpha = 255;
          if (sdfVal > -0.0045) {
            const t = Math.max(0, Math.min(1, (-0.0012 - sdfVal) / 0.0033));
            alpha = Math.round(t * 255);
          }
          if (sdfVal > -0.007 && lum > 152 && chroma < 20) {
            alpha = 0;
          }
          px[idx4 + 3] = alpha;
        }
      }

      // Dilate valid foreground RGB outward by 6 pixels into transparent border texels
      const rgbCopy = new Uint8ClampedArray(px);
      for (let pass = 0; pass < 6; pass++) {
        for (let py = 1; py < slotH - 1; py++) {
          for (let x = 1; x < slotW - 1; x++) {
            const idx4 = (py * slotW + x) * 4;
            if (rgbCopy[idx4 + 3] >= 210) continue;
            let sr = 0;
            let sg = 0;
            let sb = 0;
            let cnt = 0;
            const nIdx = [idx4 - 4, idx4 + 4, idx4 - slotW * 4, idx4 + slotW * 4];
            for (let k = 0; k < 4; k++) {
              const ni = nIdx[k];
              if (rgbCopy[ni + 3] >= 210) {
                sr += rgbCopy[ni];
                sg += rgbCopy[ni + 1];
                sb += rgbCopy[ni + 2];
                cnt++;
              }
            }
            if (cnt > 0) {
              px[idx4] = Math.round(sr / cnt);
              px[idx4 + 1] = Math.round(sg / cnt);
              px[idx4 + 2] = Math.round(sb / cnt);
              if (pass === 0) rgbCopy[idx4 + 3] = 209;
            }
          }
        }
        for (let i = 0; i < px.length; i += 4) {
          rgbCopy[i] = px[i];
          rgbCopy[i + 1] = px[i + 1];
          rgbCopy[i + 2] = px[i + 2];
          if (px[i + 3] >= 210) rgbCopy[i + 3] = px[i + 3];
        }
      }

      ctx.putImageData(slotData, dx, dy);
      // Free intermediate slot canvas immediately
      texSources[texPos] = null;
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.flipY = false;
    tex.needsUpdate = true;

    atlasCanvases.push(canvas);
    atlasTextures.push(tex);
  }

  return {
    views,
    textureViews,
    previewViews: previewSpecs,
    camParams,
    atlasTextures,
    atlasCanvases,
    atlasCols,
    atlasRows,
    slotW,
    slotH,
  };
}

export function reconstructMeshFromDataset(
  dataset: LoadedDataset,
  settings: ReconstructionSettings,
): ReconstructedMeshData {
  const gridRes =
    settings.resolution === 'high'
      ? { nx: 112, ny: 216, nz: 100 }
      : { nx: 84, ny: 164, nz: 76 };

  return buildVisualHullMesh(
    dataset.views,
    dataset.camParams,
    gridRes,
    settings.smoothingPasses,
    dataset.textureViews,
  );
}

/**
 * Re-computes 2D SDF if threshold is tuned (kept modular for future tweaks).
 */
export function recomputeViewSdf(
  mask: Uint8Array,
  w: number,
  h: number,
  metersPerPixel: number,
): Float32Array {
  return compute2DSdf(mask, w, h, metersPerPixel);
}

/**
 * Bakes a standalone UV-mapped PNG texture canvas (e.g. 1024x1024) from the packed atlas views
 * using visibility-checked multi-view blending so exported .GLB files contain full photo textures.
 */
export function bakeUvTextureCanvas(
  mesh: ReconstructedMeshData,
  dataset: LoadedDataset,
  blendSharpness: number,
  texSize = 1024,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = texSize;
  canvas.height = texSize;
  const ctx = canvas.getContext('2d')!;
  const outImg = ctx.createImageData(texSize, texSize);
  const outPx = outImg.data;
  for (let i = 0; i < outPx.length; i += 4) {
    outPx[i] = 34;
    outPx[i + 1] = 34;
    outPx[i + 2] = 36;
    outPx[i + 3] = 255;
  }

  const { slotW, slotH, atlasCols } = dataset;
  const atlasW = atlasCols * slotW;
  const atlasPixels = dataset.atlasCanvases.map((c) => {
    const cctx = c.getContext('2d', { willReadFrequently: true })!;
    return cctx.getImageData(0, 0, c.width, c.height).data;
  });

  const { positions, normals, uvs, indices, depthMaps, depthMapWidth, depthMapHeight, partWeights, headCenter } = mesh;
  const { textureViews: views, camParams } = dataset;
  const yMid = camParams.subjectHeight * 0.5;
  const D = camParams.cameraDistance;
  const invH = 1 / camParams.subjectHeight;
  const perDepthMap = depthMapWidth * depthMapHeight;
  const headCx = headCenter?.x ?? 0;
  const headCz = headCenter?.z ?? 0;

  const camCos = views.map((v) => Math.cos((-v.spec.azimuthDeg * Math.PI) / 180));
  const camSin = views.map((v) => Math.sin((-v.spec.azimuthDeg * Math.PI) / 180));
  const camDirX = views.map((v) => Math.sin((-v.spec.azimuthDeg * Math.PI) / 180));
  const camDirZ = views.map((v) => Math.cos((-v.spec.azimuthDeg * Math.PI) / 180));
  const headShiftUs = views.map((v, c) => {
    const xCam = headCx * camCos[c] - headCz * camSin[c];
    const zCam = headCx * camSin[c] + headCz * camCos[c];
    const persp = D / Math.max(1.0, D - zCam);
    const metersPerNormU = camParams.metersPerNormV * (v.analysisWidth / v.analysisHeight);
    const expectedHeadU = v.spineCenterU + (xCam * persp) / metersPerNormU;
    const measuredHeadU = v.headCenterU ?? expectedHeadU;
    return Math.max(-0.025, Math.min(0.025, measuredHeadU - expectedHeadU));
  });

  const smoothstepCpu = (e0: number, e1: number, x: number) => {
    const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };

  for (let t = 0; t < indices.length; t += 3) {
    const i0 = indices[t];
    const i1 = indices[t + 1];
    const i2 = indices[t + 2];

    const u0 = uvs[i0 * 2] * (texSize - 1);
    const v0 = (1 - uvs[i0 * 2 + 1]) * (texSize - 1);
    const u1 = uvs[i1 * 2] * (texSize - 1);
    const v1 = (1 - uvs[i1 * 2 + 1]) * (texSize - 1);
    const u2 = uvs[i2 * 2] * (texSize - 1);
    const v2 = (1 - uvs[i2 * 2 + 1]) * (texSize - 1);

    const minX = Math.max(0, Math.floor(Math.min(u0, u1, u2)));
    const maxX = Math.min(texSize - 1, Math.ceil(Math.max(u0, u1, u2)));
    const minY = Math.max(0, Math.floor(Math.min(v0, v1, v2)));
    const maxY = Math.min(texSize - 1, Math.ceil(Math.max(v0, v1, v2)));

    const area = (u1 - u0) * (v2 - v0) - (v1 - v0) * (u2 - u0);
    if (Math.abs(area) < 1e-4) continue;
    const invArea = 1 / area;

    for (let py = minY; py <= maxY; py++) {
      const cy = py + 0.5;
      for (let px = minX; px <= maxX; px++) {
        const cx = px + 0.5;
        const w0 = ((u1 - cx) * (v2 - cy) - (v1 - cy) * (u2 - cx)) * invArea;
        const w1 = ((u2 - cx) * (v0 - cy) - (v2 - cy) * (u0 - cx)) * invArea;
        const w2 = 1 - w0 - w1;
        if (w0 < -0.05 || w1 < -0.05 || w2 < -0.05) continue;

        const wx = w0 * positions[i0 * 3] + w1 * positions[i1 * 3] + w2 * positions[i2 * 3];
        const wy = w0 * positions[i0 * 3 + 1] + w1 * positions[i1 * 3 + 1] + w2 * positions[i2 * 3 + 1];
        const wz = w0 * positions[i0 * 3 + 2] + w1 * positions[i1 * 3 + 2] + w2 * positions[i2 * 3 + 2];

        const nx = w0 * normals[i0 * 3] + w1 * normals[i1 * 3] + w2 * normals[i2 * 3];
        const nz = w0 * normals[i0 * 3 + 2] + w1 * normals[i1 * 3 + 2] + w2 * normals[i2 * 3 + 2];
        const nLen = Math.hypot(nx, nz) || 1;
        const nxh = nx / nLen;
        const nzh = nz / nLen;

        const wHead = partWeights ? w0 * partWeights[i0 * 4] + w1 * partWeights[i1 * 4] + w2 * partWeights[i2 * 4] : 0;
        const wTorso = partWeights ? w0 * partWeights[i0 * 4 + 1] + w1 * partWeights[i1 * 4 + 1] + w2 * partWeights[i2 * 4 + 1] : 0;
        const wRightArm = partWeights ? w0 * partWeights[i0 * 4 + 2] + w1 * partWeights[i1 * 4 + 2] + w2 * partWeights[i2 * 4 + 2] : 0;
        const wLeftArm = partWeights ? w0 * partWeights[i0 * 4 + 3] + w1 * partWeights[i1 * 4 + 3] + w2 * partWeights[i2 * 4 + 3] : 0;
        const wLegs = partWeights ? Math.max(0, 1 - (wHead + wTorso + wRightArm + wLeftArm)) : 0;

        let sumR = 0;
        let sumG = 0;
        let sumB = 0;
        let sumW = 0;

        for (let c = 0; c < views.length; c++) {
          const facing = Math.max(0, nxh * camDirX[c] + nzh * camDirZ[c]);
          if (facing <= 0.10) continue;

          const torsoSideBlock = 1 - smoothstepCpu(0.25, 0.65, wTorso) * smoothstepCpu(0.76, 0.92, Math.abs(camSin[c]));
          const armSideBlock =
            (1 - smoothstepCpu(0.20, 0.54, wRightArm) * smoothstepCpu(0.10, 0.34, camSin[c])) *
            (1 - smoothstepCpu(0.20, 0.54, wLeftArm) * smoothstepCpu(0.10, 0.34, -camSin[c]));
          const signDir = camSin[c] === 0 ? 0 : camSin[c] > 0 ? 1 : -1;
          const legSideBlock =
            1 - smoothstepCpu(0.25, 0.60, wLegs) * smoothstepCpu(0.02, 0.06, wx * -signDir) * smoothstepCpu(0.20, 0.45, Math.abs(camSin[c]));
          const isDiag = smoothstepCpu(0.30, 0.45, Math.abs(camCos[c] * camSin[c]));
          const centerFace =
            wz > headCz + 0.015 && wy > 1.44 && wy < 1.678
              ? smoothstepCpu(0.35, 0.70, wHead) * (1 - smoothstepCpu(0.030, 0.072, Math.abs(wx - headCx)))
              : 0;
          const faceLock = 1 - isDiag * centerFace * 0.94;
          const inTorsoBand = wy >= 0.76 && wy <= 1.36 ? Math.max(0, 1 - Math.max(0, (Math.abs(wx) - 0.16) / 0.05)) : 0;
          const crossTorso = Math.min(1, Math.max(0, (-0.01 - wx * camSin[c]) / 0.04));
          const diagFarGuard = 1 - isDiag * inTorsoBand * crossTorso * 0.96;

          const belowSleeve = wy < 1.16 ? 1 : 0;
          const innerArmFace = belowSleeve * Math.max(
            smoothstepCpu(0.45, 0.78, wRightArm) * smoothstepCpu(0.22, 0.55, nxh),
            smoothstepCpu(0.45, 0.78, wLeftArm) * smoothstepCpu(0.22, 0.55, -nxh),
          );
          const innerArmGuard = 1 - innerArmFace * smoothstepCpu(0.22, 0.48, Math.abs(camSin[c])) * 0.94;

          const partGate = torsoSideBlock * armSideBlock * legSideBlock * faceLock * diagFarGuard * innerArmGuard;
          if (partGate <= 0.01) continue;

          const view = views[c];
          const xCam = wx * camCos[c] - wz * camSin[c];
          const zCam = wx * camSin[c] + wz * camCos[c];
          const camDist = Math.max(1.0, D - zCam);
          const persp = D / camDist;

          const worldYProj = (wy - yMid) * persp + yMid;
          const worldXProj = xCam * persp;
          const tY = 1.0 - worldYProj * invH;
          const vNorm = view.yTopV + tY * (view.yBottomV - view.yTopV);
          const metersPerNormU = camParams.metersPerNormV * (view.analysisWidth / view.analysisHeight);
          const uNorm = view.spineCenterU + worldXProj / metersPerNormU + headShiftUs[c] * wHead;

          const uCrop = (uNorm - view.cropU0) / (view.cropU1 - view.cropU0);
          const vCrop = (vNorm - view.cropV0) / (view.cropV1 - view.cropV0);
          if (uCrop < 0 || uCrop > 1 || vCrop < 0 || vCrop > 1) continue;

          const dx = Math.min(depthMapWidth - 1, Math.max(0, Math.round(uCrop * (depthMapWidth - 1))));
          const dy = Math.min(depthMapHeight - 1, Math.max(0, Math.round(vCrop * (depthMapHeight - 1))));
          const zBuf = depthMaps[c * perDepthMap + dy * depthMapWidth + dx];
          if (camDist > zBuf + 0.024) continue;

          const slotCol = view.atlasSlot % atlasCols;
          const slotRow = Math.floor(view.atlasSlot / atlasCols);
          const ax = slotCol * slotW + Math.min(slotW - 1, Math.max(0, Math.round(uCrop * (slotW - 1))));
          const ay = slotRow * slotH + Math.min(slotH - 1, Math.max(0, Math.round(vCrop * (slotH - 1))));
          const aIdx = (ay * atlasW + ax) * 4;
          const texData = atlasPixels[view.atlasIndex];
          const alpha = texData[aIdx + 3] / 255;
          if (alpha < 0.40) continue;

          const r = texData[aIdx] / 255;
          const g = texData[aIdx + 1] / 255;
          const b = texData[aIdx + 2] / 255;
          const lum = r * 0.299 + g * 0.587 + b * 0.114;
          const chroma = Math.max(r, g, b) - Math.min(r, g, b);
          if (lum > 0.68 && chroma < 0.11 && alpha < 0.92) continue;
          if (wLegs > 0.45 && wy < 0.12 && lum > 0.40) continue;
          if (Math.max(wRightArm, wLeftArm) > 0.45 && wy < 1.16 && wy > 0.72 && facing < 0.62 && lum < 0.24 && chroma < 0.04) continue;

          const isCapVisor = wHead >= 0.35 && wz >= headCz + 0.088 && wy >= 1.668 && wy <= 1.735 ? 1 : 0;
          const isWarmSkin = smoothstepCpu(0.032, 0.100, r - b) * (r >= 0.16 ? 1 : 0);
          const visorClean = 1 - isCapVisor * isWarmSkin * 0.94;
          const onPants = smoothstepCpu(0.22, 0.48, wLegs) * (wy >= 0.45 ? 1 : 0);
          const onShirtCloth = smoothstepCpu(0.24, 0.50, wTorso) * (wy < 1.44 ? 1 : 0);
          if (Math.max(onPants, onShirtCloth) * isWarmSkin > 0.16) continue;
          const visorBlend = isCapVisor * smoothstepCpu(0.28, 0.72, isWarmSkin);
          const cr = texData[aIdx] * (1 - visorBlend) + 18 * visorBlend;
          const cg = texData[aIdx + 1] * (1 - visorBlend) + 18 * visorBlend;
          const cb = texData[aIdx + 2] * (1 - visorBlend) + 20 * visorBlend;

          const angWeight = Math.min(1, Math.max(0.05, (facing - 0.16) / 0.35));
          const weight = Math.pow(facing, blendSharpness) * angWeight * partGate * (alpha * alpha) * visorClean;
          sumR += cr * weight;
          sumG += cg * weight;
          sumB += cb * weight;
          sumW += weight;
        }

        if (sumW > 0.001) {
          const outIdx = (py * texSize + px) * 4;
          outPx[outIdx] = Math.round(sumR / sumW);
          outPx[outIdx + 1] = Math.round(sumG / sumW);
          outPx[outIdx + 2] = Math.round(sumB / sumW);
          outPx[outIdx + 3] = 255;
        } else {
          const outIdx = (py * texSize + px) * 4;
          const isSkinFallback = Math.max(
            (wRightArm + wLeftArm) * (1 - smoothstepCpu(0.28, 0.55, wTorso + wLegs)),
            wHead * (wy < 1.65 ? 1 : 0),
          );
          const skinMix = smoothstepCpu(0.20, 0.50, isSkinFallback);
          outPx[outIdx] = Math.round(28 * (1 - skinMix) + 158 * skinMix);
          outPx[outIdx + 1] = Math.round(28 * (1 - skinMix) + 114 * skinMix);
          outPx[outIdx + 2] = Math.round(31 * (1 - skinMix) + 92 * skinMix);
          outPx[outIdx + 3] = 255;
        }
      }
    }
  }

  ctx.putImageData(outImg, 0, 0);
  return canvas;
}
