import * as THREE from 'three';
import { MAX_ATLAS_VIEWS, type CalibratedView, type WorldCameraParams } from './types';

export interface ProjectiveMaterialResources {
  material: THREE.MeshStandardMaterial;
  depthTexture: THREE.DataTexture;
  updateBlendSharpness: (sharpness: number) => void;
  updateDepthMap: (depthMaps: Float32Array, mapW: number, mapH: number) => void;
  dispose: () => void;
}

function encodeDepthMapsToTextureData(
  depthMaps: Float32Array,
  mapW: number,
  mapH: number,
  viewCount: number,
  depthCols: number,
  depthRows: number,
): Uint8Array {
  const texW = mapW * depthCols;
  const texH = mapH * depthRows;
  const data = new Uint8Array(texW * texH * 4);
  const perMap = mapW * mapH;

  for (let c = 0; c < viewCount; c++) {
    const col = c % depthCols;
    const row = Math.floor(c / depthCols);
    const srcOff = c * perMap;
    for (let y = 0; y < mapH; y++) {
      const dstY = row * mapH + y;
      for (let x = 0; x < mapW; x++) {
        const dstX = col * mapW + x;
        const d = depthMaps[srcOff + y * mapW + x];
        const norm = Math.max(0, Math.min(1, d / 10.0));
        const q = Math.round(norm * 65535);
        const idx = (dstY * texW + dstX) * 4;
        data[idx] = (q >> 8) & 0xff;
        data[idx + 1] = q & 0xff;
        data[idx + 2] = 0;
        data[idx + 3] = 255;
      }
    }
  }
  return data;
}

export function createProjectivePbrMaterial(
  views: CalibratedView[],
  camParams: WorldCameraParams,
  atlasTextures: THREE.CanvasTexture[],
  depthMaps: Float32Array,
  depthMapW: number,
  depthMapH: number,
  initialBlendSharpness = 3.2,
  headCenter?: { x: number; z: number },
  atlasCols = 2,
  atlasRows = 1,
): ProjectiveMaterialResources {
  const activeCount = Math.max(1, Math.min(views.length, MAX_ATLAS_VIEWS));
  const depthCols = activeCount <= 8 ? 4 : 6;
  const depthRows = Math.max(1, Math.ceil(activeCount / depthCols));
  const viewsPerAtlas = Math.max(1, atlasCols * atlasRows);

  const texW = depthMapW * depthCols;
  const texH = depthMapH * depthRows;
  const encoded = encodeDepthMapsToTextureData(
    depthMaps,
    depthMapW,
    depthMapH,
    activeCount,
    depthCols,
    depthRows,
  );

  const depthTexture = new THREE.DataTexture(
    encoded,
    texW,
    texH,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  depthTexture.minFilter = THREE.NearestFilter;
  depthTexture.magFilter = THREE.NearestFilter;
  depthTexture.generateMipmaps = false;
  depthTexture.flipY = false;
  depthTexture.needsUpdate = true;

  const headCx = headCenter?.x ?? 0;
  const headCz = headCenter?.z ?? 0;
  const D = camParams.cameraDistance;
  const headY = camParams.subjectHeight * 0.9;

  // Pad per-view uniform arrays to fixed MAX_ATLAS_VIEWS (36) for WebGL2 compatibility
  const viewTrig: THREE.Vector4[] = [];
  const viewSpanAndCrop: THREE.Vector4[] = [];
  const viewCropV: THREE.Vector4[] = [];

  for (let i = 0; i < MAX_ATLAS_VIEWS; i++) {
    if (i < activeCount) {
      const v = views[i];
      const phi = (-v.spec.azimuthDeg * Math.PI) / 180;
      const cosT = Math.cos(phi);
      const sinT = Math.sin(phi);
      viewTrig.push(new THREE.Vector4(cosT, sinT, v.spineCenterU, v.yTopV));

      const vSpan = Math.max(0.1, v.yBottomV - v.yTopV);
      const metersPerNormU =
        camParams.metersPerNormV * (v.analysisWidth / v.analysisHeight);
      viewSpanAndCrop.push(
        new THREE.Vector4(vSpan, metersPerNormU, v.cropU0, v.cropU1 - v.cropU0),
      );

      const xCam = headCx * cosT - headCz * sinT;
      const zCam = headCx * sinT + headCz * cosT;
      const persp = D / Math.max(1.0, D - zCam);
      const expectedHeadU = v.spineCenterU + (xCam * persp) / metersPerNormU;
      const measuredHeadU = v.headCenterU ?? expectedHeadU;
      const headShiftU = Math.max(-0.025, Math.min(0.025, measuredHeadU - expectedHeadU));
      viewCropV.push(new THREE.Vector4(v.cropV0, v.cropV1 - v.cropV0, v.atlasSlot, headShiftU));
    } else {
      viewTrig.push(new THREE.Vector4(1, 0, 0.5, 0));
      viewSpanAndCrop.push(new THREE.Vector4(1, 1, 0, 1));
      viewCropV.push(new THREE.Vector4(0, 1, 0, 0));
    }
  }

  const uniforms = {
    uAtlas0: { value: atlasTextures[0] },
    uAtlas1: { value: atlasTextures[1] ?? atlasTextures[0] },
    uAtlas2: { value: atlasTextures[2] ?? atlasTextures[0] },
    uAtlas3: { value: atlasTextures[3] ?? atlasTextures[0] },
    uDepthTex: { value: depthTexture },
    uViewCount: { value: activeCount },
    uAtlasGrid: { value: new THREE.Vector2(atlasCols, atlasRows) },
    uDepthGrid: { value: new THREE.Vector2(depthCols, depthRows) },
    uViewsPerAtlas: { value: viewsPerAtlas },
    uViewTrig: { value: viewTrig },
    uViewCropU: { value: viewSpanAndCrop },
    uViewCropV: { value: viewCropV },
    uCamParams: {
      value: new THREE.Vector4(
        camParams.subjectHeight,
        camParams.cameraDistance,
        initialBlendSharpness,
        headY,
      ),
    },
    uHeadCenter: {
      value: new THREE.Vector2(headCx, headCz),
    },
    uDepthTexSize: {
      value: new THREE.Vector2(depthMapW, depthMapH),
    },
  };

  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.84,
    metalness: 0.04,
    envMapIntensity: 0.65,
  });

  material.customProgramCacheKey = () => 'projective-36view-pbr-v4';

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec4 aPartWeights;
varying vec3 vProjWorldPos;
varying vec3 vProjWorldNormal;
varying vec4 vPartWeights;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vProjWorldPos = transformed;
vProjWorldNormal = normalize(objectNormal);
vPartWeights = aPartWeights;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform sampler2D uAtlas0;
uniform sampler2D uAtlas1;
uniform sampler2D uAtlas2;
uniform sampler2D uAtlas3;
uniform sampler2D uDepthTex;
uniform int uViewCount;
uniform vec2 uAtlasGrid;
uniform vec2 uDepthGrid;
uniform float uViewsPerAtlas;
uniform vec4 uViewTrig[36];
uniform vec4 uViewCropU[36];
uniform vec4 uViewCropV[36];
uniform vec4 uCamParams;
uniform vec2 uHeadCenter;
uniform vec2 uDepthTexSize;

varying vec3 vProjWorldPos;
varying vec3 vProjWorldNormal;
varying vec4 vPartWeights;

vec4 sampleAtlasByIndex(int idx, vec2 uv) {
  int atlasIdx = int(floor(float(idx) / max(1.0, uViewsPerAtlas)));
  if (atlasIdx == 0) return texture2D(uAtlas0, uv);
  if (atlasIdx == 1) return texture2D(uAtlas1, uv);
  if (atlasIdx == 2) return texture2D(uAtlas2, uv);
  return texture2D(uAtlas3, uv);
}

float decodeDepthTexel(vec2 dUv) {
  vec4 enc = texture2D(uDepthTex, dUv);
  float hi = floor(enc.r * 255.0 + 0.5);
  float lo = floor(enc.g * 255.0 + 0.5);
  return ((hi * 256.0 + lo) / 65535.0) * 10.0;
}

float readDepthAtView(int idx, vec2 cropUv) {
  float col = mod(float(idx), uDepthGrid.x);
  float row = floor(float(idx) / uDepthGrid.x);
  float u0 = (col + clamp(cropUv.x, 0.005, 0.995)) / uDepthGrid.x;
  float v0 = (row + clamp(cropUv.y, 0.005, 0.995)) / uDepthGrid.y;
  return decodeDepthTexel(vec2(u0, v0));
}`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
vec3 nWorld = normalize(vProjWorldNormal);
vec2 nHoriz = length(nWorld.xz) > 0.001 ? normalize(nWorld.xz) : vec2(0.0, 1.0);
float yMid = uCamParams.x * 0.5;
float camDistBase = uCamParams.y;
float blendPow = uCamParams.z;
float invSubjH = 1.0 / max(0.1, uCamParams.x);

float wHead = vPartWeights.x;
float wTorso = vPartWeights.y;
float wRightArm = vPartWeights.z;
float wLeftArm = vPartWeights.w;
float wLegs = max(0.0, 1.0 - (wHead + wTorso + wRightArm + wLeftArm));

vec3 accumColor = vec3(0.0);
float accumWeight = 0.0;
vec3 fallbackColor = vec3(0.0);
float fallbackWeight = 0.0;

for (int i = 0; i < 36; i++) {
  if (i >= uViewCount) break;
  vec4 trig = uViewTrig[i];
  vec4 cropU = uViewCropU[i];
  vec4 cropV = uViewCropV[i];

  // Camera direction in XZ = (sin(phi), cos(phi)) = (trig.y, trig.x)
  float facing = max(0.0, dot(nHoriz, vec2(trig.y, trig.x)));
  if (facing > 0.04) {
    // Part-locked view gating:
    // 1. Torso excludes pure side profiles (90° & 270°) where arms block torso flanks
    float torsoSideBlock = 1.0 - smoothstep(0.25, 0.65, wTorso) * smoothstep(0.76, 0.92, abs(trig.y));
    // 2. Right Arm (-X) excludes left-side views; Left Arm (+X) excludes right-side views
    float armSideBlock =
      (1.0 - smoothstep(0.20, 0.54, wRightArm) * smoothstep(0.10, 0.34, trig.y)) *
      (1.0 - smoothstep(0.20, 0.54, wLeftArm) * smoothstep(0.10, 0.34, -trig.y));
    // 3. Legs exclude opposite-side views so legs never cross-project onto each other
    float legSideBlock =
      1.0 - smoothstep(0.25, 0.60, wLegs) *
            smoothstep(0.02, 0.06, vProjWorldPos.x * (-sign(trig.y))) *
            smoothstep(0.20, 0.45, abs(trig.y));
    // 4. Center face sharpness: attenuate diagonal views across center face so 0° dominates features cleanly
    float isDiag = smoothstep(0.30, 0.45, abs(trig.x * trig.y));
    float centerFace =
      smoothstep(0.35, 0.70, wHead) *
      step(uHeadCenter.y + 0.015, vProjWorldPos.z) *
      step(1.44, vProjWorldPos.y) * (1.0 - step(1.678, vProjWorldPos.y)) *
      (1.0 - smoothstep(0.030, 0.072, abs(vProjWorldPos.x - uHeadCenter.x)));
    float faceLock = 1.0 - isDiag * centerFace * 0.94;
    // 5. Attenuate diagonal cross-torso rays where far arm can overlap opposite torso flank
    float inTorsoBand = step(0.76, vProjWorldPos.y) * (1.0 - step(1.36, vProjWorldPos.y)) * (1.0 - smoothstep(0.16, 0.21, abs(vProjWorldPos.x)));
    float crossTorso = smoothstep(-0.01, -0.05, vProjWorldPos.x * trig.y);
    float diagFarGuard = 1.0 - isDiag * inTorsoBand * crossTorso * 0.96;

    // 6. On bare arm inner faces below sleeve cuff, let front/back (0°/180°) dominate over grazing oblique views
    float belowSleeve = 1.0 - step(1.16, vProjWorldPos.y);
    float innerArmFace = belowSleeve * max(
      smoothstep(0.45, 0.78, wRightArm) * smoothstep(0.22, 0.55, nHoriz.x),
      smoothstep(0.45, 0.78, wLeftArm) * smoothstep(0.22, 0.55, -nHoriz.x)
    );
    float innerArmGuard = 1.0 - innerArmFace * smoothstep(0.22, 0.48, abs(trig.y)) * 0.94;

    float partGate = torsoSideBlock * armSideBlock * legSideBlock * faceLock * diagFarGuard * innerArmGuard;

    if (partGate > 0.01) {
      float xCam = vProjWorldPos.x * trig.x - vProjWorldPos.z * trig.y;
      float zCam = vProjWorldPos.x * trig.y + vProjWorldPos.z * trig.x;
      float camDist = max(1.0, camDistBase - zCam);
      float persp = camDistBase / camDist;

      float worldYProj = (vProjWorldPos.y - yMid) * persp + yMid;
      float worldXProj = xCam * persp;
      float tY = 1.0 - worldYProj * invSubjH;
      float vNorm = trig.w + tY * cropU.x;
      float uNorm = trig.z + worldXProj / cropU.y + cropV.w * wHead;

      float uCrop = (uNorm - cropU.z) / cropU.w;
      float vCrop = (vNorm - cropV.x) / cropV.y;

      if (uCrop >= 0.0 && uCrop <= 1.0 && vCrop >= 0.0 && vCrop <= 1.0) {
        float slotCol = mod(cropV.z, uAtlasGrid.x);
        float slotRow = floor(cropV.z / uAtlasGrid.x);
        vec2 atlasUv = vec2(
          (slotCol + clamp(uCrop, 0.002, 0.998)) / uAtlasGrid.x,
          (slotRow + clamp(vCrop, 0.002, 0.998)) / uAtlasGrid.y
        );
        vec4 texSample = sampleAtlasByIndex(i, atlasUv);
        float maskA = texSample.a;

        if (maskA > 0.05) {
          vec3 sampleRgb = texSample.rgb;
          float lum = dot(sampleRgb, vec3(0.299, 0.587, 0.114));
          float maxC = max(sampleRgb.r, max(sampleRgb.g, sampleRgb.b));
          float minC = min(sampleRgb.r, min(sampleRgb.g, sampleRgb.b));
          float chroma = maxC - minC;

          // Strip residual bright neutral gray studio background near silhouette edges (white graphics are strictly interior where maskA == 1.0)
          bool rejectStudioBg = maskA < 0.92 && lum > 0.45 && chroma < 0.08;
          bool rejectBootFloor = (wLegs > 0.45 && vProjWorldPos.y < 0.12 && lum > 0.25);
          // Reject dark black t-shirt/denim samples bleeding onto bare arms from grazing views
          bool rejectArmCloth = max(wRightArm, wLeftArm) > 0.45 && vProjWorldPos.y < 1.16 && vProjWorldPos.y > 0.72 && facing < 0.62 && lum < 0.095 && chroma < 0.025;

          if (!rejectStudioBg && !rejectBootFloor && !rejectArmCloth) {
            // Keep cap visor brim clean black fabric ONLY suppressing actual warm forehead skin bleed
            float isCapVisor = step(0.35, wHead) * step(uHeadCenter.y + 0.088, vProjWorldPos.z) * step(1.668, vProjWorldPos.y) * (1.0 - step(1.735, vProjWorldPos.y));
            float isWarmSkinTone = smoothstep(0.032, 0.100, sampleRgb.r - sampleRgb.b) * step(0.11, sampleRgb.r);
            float visorClean = 1.0 - isCapVisor * isWarmSkinTone * 0.94;

            // Skip hand/arm skin samples overlapping black denim or shirt cloth
            float onPants = smoothstep(0.22, 0.48, wLegs) * step(0.45, vProjWorldPos.y);
            float onShirtCloth = smoothstep(0.24, 0.50, wTorso) * (1.0 - step(1.44, vProjWorldPos.y));
            bool rejectClothSkin = max(onPants, onShirtCloth) * isWarmSkinTone > 0.16;

            if (!rejectClothSkin) {
              vec3 cleanRgb = mix(sampleRgb, vec3(0.016, 0.016, 0.018), isCapVisor * smoothstep(0.28, 0.72, isWarmSkinTone));

              float zBuf = readDepthAtView(i, vec2(uCrop, vCrop));
              float occ = camDist - zBuf;
              float vis = 1.0 - smoothstep(0.015, 0.030, occ);
              float angWeight = max(0.04, smoothstep(0.16, 0.50, facing));
              float edgeConfidence = smoothstep(0.25, 0.85, maskA);

              if (maskA > 0.55) {
                float w = pow(facing, blendPow) * angWeight * partGate * edgeConfidence * vis * visorClean;
                accumColor += cleanRgb * w;
                accumWeight += w;
              }

              float visClean = 1.0 - smoothstep(0.022, 0.038, occ);
              float wf = facing * partGate * max(0.08, maskA) * visClean;
              fallbackColor += cleanRgb * wf;
              fallbackWeight += wf;
            }
          }
        }
      }
    }
  }
}

// Part-aware fallback in Linear RGB space (warm skin for face/neck/arms, charcoal for garments/cap)
float isSkinPart = max(
  (wRightArm + wLeftArm) * (1.0 - smoothstep(0.35, 0.62, wTorso + wLegs)),
  wHead * (1.0 - step(1.65, vProjWorldPos.y))
);
vec3 darkPartFallback = mix(vec3(0.020, 0.020, 0.023), vec3(0.34, 0.175, 0.115), smoothstep(0.24, 0.52, isSkinPart));

vec3 projAlbedo = accumWeight > 0.001
  ? accumColor / accumWeight
  : (fallbackWeight > 0.001 ? fallbackColor / fallbackWeight : darkPartFallback);

// Clean matte black leather finish along lower Chelsea boot outsole & welt (y < 0.024m)
float isBootSole = (1.0 - smoothstep(0.012, 0.024, vProjWorldPos.y)) * step(0.4, wLegs);
diffuseColor.rgb = mix(projAlbedo, vec3(0.016, 0.016, 0.018), isBootSole);`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
// Adaptive PBR roughness: warm skin tones & Chelsea leather boots get natural specular sheen; matte cotton stays soft
float isSkin = smoothstep(0.04, 0.14, diffuseColor.r - diffuseColor.b) * step(0.12, diffuseColor.r);
float isBoot = (1.0 - smoothstep(0.08, 0.12, vProjWorldPos.y));
roughnessFactor = mix(mix(0.86, 0.56, isSkin), 0.48, isBoot);`,
      );
  };

  return {
    material,
    depthTexture,
    updateBlendSharpness: (sharpness: number) => {
      uniforms.uCamParams.value.z = sharpness;
    },
    updateDepthMap: (newDepthMaps: Float32Array, mapW: number, mapH: number) => {
      const nextData = encodeDepthMapsToTextureData(
        newDepthMaps,
        mapW,
        mapH,
        activeCount,
        depthCols,
        depthRows,
      );
      (depthTexture.image.data as Uint8Array).set(nextData);
      depthTexture.needsUpdate = true;
    },
    dispose: () => {
      material.dispose();
      depthTexture.dispose();
    },
  };
}

