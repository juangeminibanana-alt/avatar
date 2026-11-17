export const MAX_ATLAS_VIEWS = 36;

export interface ViewSpec {
  id: string;
  url: string;
  azimuthDeg: number;
  label: string;
  shortLabel: string;
  loadBlob?: (signal?: AbortSignal) => Promise<Blob>;
}

export const STUDIO_VIEWS: ViewSpec[] = [
  {
    id: 'vista_000',
    url: '/assets/aistudio/vista_000_83139bbb.png',
    azimuthDeg: 0,
    label: 'Frontal',
    shortLabel: '0°',
  },
  {
    id: 'vista_046',
    url: '/assets/aistudio/vista_046_7101a34c.png',
    azimuthDeg: 35.5,
    label: 'Diagonal Der.',
    shortLabel: '36°',
  },
  {
    id: 'vista_087',
    url: '/assets/aistudio/vista_087_7366bcdb.png',
    azimuthDeg: 90,
    label: 'Perfil Der.',
    shortLabel: '90°',
  },
  {
    id: 'vista_127',
    url: '/assets/aistudio/vista_127_1f931038.png',
    azimuthDeg: 137.4,
    label: 'Post. Der.',
    shortLabel: '137°',
  },
  {
    id: 'vista_163',
    url: '/assets/aistudio/vista_163_4b1df61c.png',
    azimuthDeg: 180,
    label: 'Espalda',
    shortLabel: '180°',
  },
  {
    id: 'vista_201',
    url: '/assets/aistudio/vista_201_15ac99d8.png',
    azimuthDeg: 223.3,
    label: 'Post. Izq.',
    shortLabel: '223°',
  },
  {
    id: 'vista_242',
    url: '/assets/aistudio/vista_242_3f101735.png',
    azimuthDeg: 270,
    label: 'Perfil Izq.',
    shortLabel: '270°',
  },
  {
    id: 'vista_278',
    url: '/assets/aistudio/vista_278_de015d9f.png',
    azimuthDeg: 311.5,
    label: 'Diagonal Izq.',
    shortLabel: '311°',
  },
];

export type RenderMode = 'textured' | 'clay' | 'wireframe' | 'normals';

export type LightingPreset = 'studio' | 'dramatic' | 'warm';

export type ResolutionTier = 'standard' | 'high';

export interface ReconstructionSettings {
  resolution: ResolutionTier;
  smoothingPasses: number;
  blendSharpness: number;
}

export interface CalibratedView {
  spec: ViewSpec;
  analysisWidth: number;
  analysisHeight: number;
  mask: Uint8Array;
  sdf2d: Float32Array;
  /** World-aligned projection parameters in image normalized [0..1] coords */
  spineCenterU: number;
  yTopV: number;
  yBottomV: number;
  /** Crop rectangle in source image normalized [0..1] coords for texture atlas */
  cropU0: number;
  cropU1: number;
  cropV0: number;
  cropV1: number;
  /** Normalized U midpoint of head silhouette [0..1] for per-view facial alignment */
  headCenterU?: number;
  /** Atlas slot index */
  atlasIndex: number;
  atlasSlot: number;
}

export interface WorldCameraParams {
  /** Subject physical height in world meters (y from 0 to subjectHeight) */
  subjectHeight: number;
  /** Horizontal world scale per unit image height */
  metersPerNormV: number;
  /** Virtual studio camera distance in meters for perspective correction */
  cameraDistance: number;
}

export interface ReconstructedMeshData {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  /** Per-vertex soft part weights [head, torso, rightArm, leftArm] (legs = 1 - sum) */
  partWeights?: Float32Array;
  /** Measured 3D head centerline offset in world meters */
  headCenter?: { x: number; z: number };
  vertexCount: number;
  triangleCount: number;
  bounds: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    minZ: number;
    maxZ: number;
  };
  depthMaps: Float32Array;
  depthMapWidth: number;
  depthMapHeight: number;
}
