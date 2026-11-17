import type { ReconstructedMeshData } from './types';

export function buildObjString(mesh: ReconstructedMeshData): string {
  const lines: string[] = [
    '# Estudio 3D Fotogramétrico - Modelo Reconstruido',
    `# Vértices: ${mesh.vertexCount} | Triángulos: ${mesh.triangleCount}`,
    'o Persona_3D',
  ];

  const { positions, normals, uvs, indices, bounds } = mesh;
  const yGroundOffset = Number.isFinite(bounds.minY) ? -bounds.minY : 0;
  for (let i = 0; i < positions.length; i += 3) {
    lines.push(
      `v ${positions[i].toFixed(5)} ${(positions[i + 1] + yGroundOffset).toFixed(5)} ${positions[i + 2].toFixed(5)}`,
    );
  }
  for (let i = 0; i < uvs.length; i += 2) {
    lines.push(`vt ${uvs[i].toFixed(5)} ${(1 - uvs[i + 1]).toFixed(5)}`);
  }
  for (let i = 0; i < normals.length; i += 3) {
    lines.push(
      `vn ${normals[i].toFixed(5)} ${normals[i + 1].toFixed(5)} ${normals[i + 2].toFixed(5)}`,
    );
  }
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] + 1;
    const b = indices[t + 1] + 1;
    const c = indices[t + 2] + 1;
    lines.push(`f ${a}/${a}/${a} ${b}/${b}/${b} ${c}/${c}/${c}`);
  }
  return lines.join('\n');
}

function pad4(n: number): number {
  return (n + 3) & ~3;
}

/**
 * Builds a valid self-contained binary glTF 2.0 (.glb) buffer containing the
 * reconstructed 3D mesh (positions, normals, UVs, indices) and an optional embedded PNG texture.
 */
export function buildGlbBuffer(
  mesh: ReconstructedMeshData,
  pngBytes?: Uint8Array,
): ArrayBuffer {
  const { positions, normals, uvs, indices, bounds } = mesh;

  const idxBytes = indices.byteLength;
  const posBytes = positions.byteLength;
  const normBytes = normals.byteLength;
  const uvBytes = uvs.byteLength;
  const imgBytes = pngBytes ? pngBytes.byteLength : 0;

  const idxOffset = 0;
  const posOffset = pad4(idxOffset + idxBytes);
  const normOffset = pad4(posOffset + posBytes);
  const uvOffset = pad4(normOffset + normBytes);
  const imgOffset = pad4(uvOffset + uvBytes);
  const binLength = pad4(imgOffset + imgBytes);

  const binBuf = new Uint8Array(binLength);
  binBuf.set(new Uint8Array(indices.buffer, indices.byteOffset, idxBytes), idxOffset);
  binBuf.set(new Uint8Array(positions.buffer, positions.byteOffset, posBytes), posOffset);
  binBuf.set(new Uint8Array(normals.buffer, normals.byteOffset, normBytes), normOffset);
  binBuf.set(new Uint8Array(uvs.buffer, uvs.byteOffset, uvBytes), uvOffset);
  if (pngBytes && imgBytes > 0) {
    binBuf.set(pngBytes, imgOffset);
  }

  const bufferViews: Record<string, unknown>[] = [
    { buffer: 0, byteOffset: idxOffset, byteLength: idxBytes, target: 34963 },
    { buffer: 0, byteOffset: posOffset, byteLength: posBytes, target: 34962 },
    { buffer: 0, byteOffset: normOffset, byteLength: normBytes, target: 34962 },
    { buffer: 0, byteOffset: uvOffset, byteLength: uvBytes, target: 34962 },
  ];

  if (pngBytes && imgBytes > 0) {
    bufferViews.push({
      buffer: 0,
      byteOffset: imgOffset,
      byteLength: imgBytes,
    });
  }

  const gltf: Record<string, unknown> = {
    asset: {
      version: '2.0',
      generator: 'Estudio 3D Fotogrametrico',
    },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      {
        mesh: 0,
        name: 'Modelo_3D_Reconstruido',
        translation: [0, Number.isFinite(bounds.minY) ? -bounds.minY : 0, 0],
      },
    ],
    meshes: [
      {
        name: 'Persona_3D',
        primitives: [
          {
            attributes: {
              POSITION: 1,
              NORMAL: 2,
              TEXCOORD_0: 3,
            },
            indices: 0,
            material: 0,
          },
        ],
      },
    ],
    materials: [
      {
        name: 'Material_Multivista_PBR',
        pbrMetallicRoughness: {
          ...(pngBytes && imgBytes > 0
            ? { baseColorTexture: { index: 0 } }
            : { baseColorFactor: [0.85, 0.85, 0.87, 1] }),
          metallicFactor: 0.04,
          roughnessFactor: 0.82,
        },
      },
    ],
    buffers: [{ byteLength: binLength }],
    bufferViews,
    accessors: [
      {
        bufferView: 0,
        componentType: 5125, // UNSIGNED_INT
        count: indices.length,
        type: 'SCALAR',
      },
      {
        bufferView: 1,
        componentType: 5126, // FLOAT
        count: mesh.vertexCount,
        type: 'VEC3',
        min: [bounds.minX, bounds.minY, bounds.minZ],
        max: [bounds.maxX, bounds.maxY, bounds.maxZ],
      },
      {
        bufferView: 2,
        componentType: 5126, // FLOAT
        count: mesh.vertexCount,
        type: 'VEC3',
      },
      {
        bufferView: 3,
        componentType: 5126, // FLOAT
        count: mesh.vertexCount,
        type: 'VEC2',
      },
    ],
  };

  if (pngBytes && imgBytes > 0) {
    gltf.samplers = [
      {
        magFilter: 9729,
        minFilter: 9987,
        wrapS: 33071,
        wrapT: 33071,
      },
    ];
    gltf.images = [
      {
        bufferView: 4,
        mimeType: 'image/png',
      },
    ];
    gltf.textures = [{ sampler: 0, source: 0 }];
  }

  const jsonEncoder = new TextEncoder();
  const rawJson = jsonEncoder.encode(JSON.stringify(gltf));
  const jsonLength = pad4(rawJson.byteLength);
  const jsonChunk = new Uint8Array(jsonLength);
  jsonChunk.fill(0x20); // space padding required by glTF spec
  jsonChunk.set(rawJson, 0);

  const totalLength = 12 + 8 + jsonLength + 8 + binLength;
  const out = new ArrayBuffer(totalLength);
  const view = new DataView(out);
  const bytes = new Uint8Array(out);

  // Header
  view.setUint32(0, 0x46546c67, true); // 'glTF'
  view.setUint32(4, 2, true);
  view.setUint32(8, totalLength, true);

  // JSON Chunk
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true); // 'JSON'
  bytes.set(jsonChunk, 20);

  // BIN Chunk
  const binChunkStart = 20 + jsonLength;
  view.setUint32(binChunkStart, binLength, true);
  view.setUint32(binChunkStart + 4, 0x004e4942, true); // 'BIN\0'
  bytes.set(binBuf, binChunkStart + 8);

  return out;
}

export function triggerFileDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
