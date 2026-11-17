import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { createProjectivePbrMaterial, type ProjectiveMaterialResources } from '../reconstruction/projectiveMaterial';
import type { LoadedDataset } from '../reconstruction/loaderAndAtlas';
import type {
  LightingPreset,
  ReconstructedMeshData,
  RenderMode,
} from '../reconstruction/types';

export interface Viewport3DProps {
  dataset: LoadedDataset | null;
  meshData: ReconstructedMeshData | null;
  renderMode: RenderMode;
  lightingPreset: LightingPreset;
  blendSharpness: number;
  turntable: boolean;
  targetAzimuthDeg: number | null;
  cameraCommandSeq: number;
  onWebglError?: (msg: string) => void;
}

function detectSoftwareGl(): boolean {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return true;
  }
}

function createPlinthStage(maxAniso: number): {
  group: THREE.Group;
  dispose: () => void;
} {
  const group = new THREE.Group();
  group.name = 'StudioPlinth';

  // Dial tick-mark ring texture (procedural, zero 404)
  const ringCanvas = document.createElement('canvas');
  ringCanvas.width = 1024;
  ringCanvas.height = 1024;
  const ctx = ringCanvas.getContext('2d')!;
  ctx.fillStyle = '#181b22';
  ctx.fillRect(0, 0, 1024, 1024);

  const cx = 512;
  const cy = 512;
  ctx.strokeStyle = 'rgba(245, 158, 11, 0.35)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, 465, 0, Math.PI * 2);
  ctx.stroke();

  for (let deg = 0; deg < 360; deg += 5) {
    const rad = (deg * Math.PI) / 180;
    const isMajor = deg % 45 === 0;
    const isMid = deg % 15 === 0;
    const r0 = isMajor ? 430 : isMid ? 445 : 454;
    const r1 = 464;
    ctx.strokeStyle = isMajor ? 'rgba(245, 158, 11, 0.75)' : 'rgba(255, 255, 255, 0.22)';
    ctx.lineWidth = isMajor ? 3 : 1.5;
    ctx.beginPath();
    ctx.moveTo(cx + Math.sin(rad) * r0, cy + Math.cos(rad) * r0);
    ctx.lineTo(cx + Math.sin(rad) * r1, cy + Math.cos(rad) * r1);
    ctx.stroke();
  }

  const ringTex = new THREE.CanvasTexture(ringCanvas);
  ringTex.colorSpace = THREE.SRGBColorSpace;
  ringTex.anisotropy = maxAniso;

  // Radial soft contact shadow disc directly beneath boots
  const shadowCanvas = document.createElement('canvas');
  shadowCanvas.width = 256;
  shadowCanvas.height = 256;
  const sCtx = shadowCanvas.getContext('2d')!;
  const grad = sCtx.createRadialGradient(128, 128, 12, 128, 128, 124);
  grad.addColorStop(0, 'rgba(0, 0, 0, 0.58)');
  grad.addColorStop(0.55, 'rgba(0, 0, 0, 0.24)');
  grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
  sCtx.fillStyle = grad;
  sCtx.fillRect(0, 0, 256, 256);
  const shadowTex = new THREE.CanvasTexture(shadowCanvas);

  // 1. Primary top turntable deck
  const topGeo = new THREE.CylinderGeometry(0.68, 0.70, 0.04, 64);
  const topMat = new THREE.MeshStandardMaterial({
    map: ringTex,
    roughness: 0.78,
    metalness: 0.08,
  });
  const topMesh = new THREE.Mesh(topGeo, topMat);
  topMesh.position.y = -0.02;
  topMesh.receiveShadow = true;
  group.add(topMesh);

  // 2. Secondary brushed dark-steel rim collar
  const collarGeo = new THREE.CylinderGeometry(0.73, 0.76, 0.05, 64);
  const collarMat = new THREE.MeshStandardMaterial({
    color: 0x2b303a,
    roughness: 0.34,
    metalness: 0.84,
  });
  const collarMesh = new THREE.Mesh(collarGeo, collarMat);
  collarMesh.position.y = -0.065;
  collarMesh.receiveShadow = true;
  group.add(collarMesh);

  // 3. Accent beveled brass/amber indicator ring
  const trimGeo = new THREE.TorusGeometry(0.705, 0.006, 12, 72);
  const trimMat = new THREE.MeshStandardMaterial({
    color: 0xd97706,
    roughness: 0.28,
    metalness: 0.88,
  });
  const trimMesh = new THREE.Mesh(trimGeo, trimMat);
  trimMesh.rotation.x = Math.PI / 2;
  trimMesh.position.y = -0.038;
  group.add(trimMesh);

  // 4. Studio floor plane with smooth radial fade into cyclorama backdrop (zero hard horizon line)
  const floorAlphaCanvas = document.createElement('canvas');
  floorAlphaCanvas.width = 512;
  floorAlphaCanvas.height = 512;
  const faCtx = floorAlphaCanvas.getContext('2d')!;
  const fGrad = faCtx.createRadialGradient(256, 256, 36, 256, 256, 252);
  fGrad.addColorStop(0, 'rgba(255, 255, 255, 1)');
  fGrad.addColorStop(0.28, 'rgba(220, 220, 220, 0.75)');
  fGrad.addColorStop(0.62, 'rgba(110, 110, 110, 0.24)');
  fGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
  faCtx.fillStyle = fGrad;
  faCtx.fillRect(0, 0, 512, 512);
  const floorAlphaTex = new THREE.CanvasTexture(floorAlphaCanvas);

  const floorGeo = new THREE.CircleGeometry(14, 64);
  const floorMat = new THREE.MeshStandardMaterial({
    color: 0x161a22,
    alphaMap: floorAlphaTex,
    transparent: true,
    roughness: 0.94,
    metalness: 0.02,
  });
  const floorMesh = new THREE.Mesh(floorGeo, floorMat);
  floorMesh.rotation.x = -Math.PI / 2;
  floorMesh.position.y = -0.092;
  floorMesh.receiveShadow = true;
  group.add(floorMesh);

  // 5. Contact shadow grounding disc directly under boots
  const contactGeo = new THREE.CircleGeometry(0.52, 48);
  const contactMat = new THREE.MeshBasicMaterial({
    map: shadowTex,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  const contactMesh = new THREE.Mesh(contactGeo, contactMat);
  contactMesh.rotation.x = -Math.PI / 2;
  contactMesh.position.y = 0.003;
  group.add(contactMesh);

  return {
    group,
    dispose: () => {
      ringTex.dispose();
      shadowTex.dispose();
      floorAlphaTex.dispose();
      topGeo.dispose();
      topMat.dispose();
      collarGeo.dispose();
      collarMat.dispose();
      trimGeo.dispose();
      trimMat.dispose();
      floorGeo.dispose();
      floorMat.dispose();
      contactGeo.dispose();
      contactMat.dispose();
    },
  };
}

export function Viewport3D({
  dataset,
  meshData,
  renderMode,
  lightingPreset,
  blendSharpness,
  turntable,
  targetAzimuthDeg,
  cameraCommandSeq,
  onWebglError,
}: Viewport3DProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);

  const propsRef = useRef({
    renderMode,
    lightingPreset,
    blendSharpness,
    turntable,
    onWebglError,
  });
  propsRef.current = {
    renderMode,
    lightingPreset,
    blendSharpness,
    turntable,
    onWebglError,
  };

  const sceneRefs = useRef<{
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    modelGroup: THREE.Group;
    subjectMesh: THREE.Mesh | null;
    wireOverlay: THREE.Mesh | null;
    projMat: ProjectiveMaterialResources | null;
    clayMat: THREE.MeshStandardMaterial;
    wireBaseMat: THREE.MeshStandardMaterial;
    wireLineMat: THREE.MeshBasicMaterial;
    normalMat: THREE.MeshNormalMaterial;
    keyLight: THREE.DirectionalLight;
    hemiLight: THREE.HemisphereLight;
    rimLight: THREE.DirectionalLight;
    requestRender: () => void;
    cameraAnim: {
      active: boolean;
      targetAzimuth: number;
      targetRadius: number;
      targetHeight: number;
      targetLook: THREE.Vector3;
    };
  } | null>(null);

  // One-time WebGL scene mount
  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const isSoftwareGl = detectSoftwareGl();
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: !isSoftwareGl,
        powerPreference: 'high-performance',
      });
    } catch {
      propsRef.current.onWebglError?.('WebGL no está disponible en este navegador.');
      return;
    }

    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = !isSoftwareGl;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setSize(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight);
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    container.appendChild(renderer.domElement);

    const onContextLost = (e: Event) => {
      e.preventDefault();
      propsRef.current.onWebglError?.('Se perdió el contexto WebGL.');
    };
    renderer.domElement.addEventListener('webglcontextlost', onContextLost);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x111318);
    scene.fog = new THREE.FogExp2(0x111318, 0.085);

    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    const roomEnv = new RoomEnvironment();
    const envTex = pmremGenerator.fromScene(roomEnv, 0.04).texture;
    scene.environment = envTex;
    roomEnv.dispose();
    pmremGenerator.dispose();

    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;
    const camera = new THREE.PerspectiveCamera(35, width / height, 0.1, 45);
    camera.position.set(0, 1.06, 4.08);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0.70, 0);
    controls.enableDamping = !isSoftwareGl;
    controls.dampingFactor = 0.07;
    controls.minDistance = 1.15;
    controls.maxDistance = 6.5;
    controls.minPolarAngle = 0.15;
    controls.maxPolarAngle = Math.PI * 0.51;
    controls.update();

    // 3-Point Studio Lighting Rig
    const hemiLight = new THREE.HemisphereLight(0xd4e2f7, 0x1a1d24, 0.85);
    scene.add(hemiLight);

    const keyLight = new THREE.DirectionalLight(0xfff3e0, 1.75);
    keyLight.position.set(2.4, 3.6, 2.8);
    keyLight.castShadow = !isSoftwareGl;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.camera.near = 0.5;
    keyLight.shadow.camera.far = 10;
    keyLight.shadow.camera.left = -1.3;
    keyLight.shadow.camera.right = 1.3;
    keyLight.shadow.camera.top = 2.2;
    keyLight.shadow.camera.bottom = -0.3;
    keyLight.shadow.bias = -0.0005;
    keyLight.shadow.normalBias = 0.02;
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0xc7dfff, 1.05);
    rimLight.position.set(-2.2, 2.5, -2.6);
    scene.add(rimLight);

    const maxAniso = renderer.capabilities.getMaxAnisotropy();
    const plinth = createPlinthStage(maxAniso);
    scene.add(plinth.group);

    const modelGroup = new THREE.Group();
    scene.add(modelGroup);

    const clayMat = new THREE.MeshStandardMaterial({
      color: 0xb5b2ac,
      roughness: 0.68,
      metalness: 0.04,
      envMapIntensity: 0.65,
    });
    const wireBaseMat = new THREE.MeshStandardMaterial({
      color: 0x1e222b,
      roughness: 0.85,
      metalness: 0.1,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    const wireLineMat = new THREE.MeshBasicMaterial({
      color: 0xf59e0b,
      wireframe: true,
      transparent: true,
      opacity: 0.72,
    });
    const normalMat = new THREE.MeshNormalMaterial();

    const cameraAnim = {
      active: false,
      targetAzimuth: 0,
      targetRadius: 4.02,
      targetHeight: 1.06,
      targetLook: new THREE.Vector3(0, 0.70, 0),
    };

    let frameId = 0;
    let renderBusy = false;
    let renderDirty = false;
    let lastTime = performance.now();
    let disposed = false;

    function afterDraw(cb: () => void) {
      const gl = renderer.getContext() as WebGL2RenderingContext;
      const sync = gl.fenceSync?.(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      if (!sync) {
        frameId = window.setTimeout(cb, 80);
        return;
      }
      gl.flush();
      const poll = () => {
        if (disposed) {
          gl.deleteSync(sync);
          return;
        }
        const state = gl.getSyncParameter(sync, gl.SYNC_STATUS);
        if (state === gl.UNSIGNALED) {
          frameId = window.setTimeout(poll, 5);
        } else {
          gl.deleteSync(sync);
          frameId = window.setTimeout(cb, 80);
        }
      };
      frameId = window.setTimeout(poll, 5);
    }

    function requestRender() {
      if (disposed) return;
      if (renderBusy) {
        renderDirty = true;
        return;
      }
      renderBusy = true;
      frameId = requestAnimationFrame(() => {
        if (disposed) return;
        renderDirty = false;

        const now = performance.now();
        const dt = Math.min(0.1, (now - lastTime) * 0.001);
        lastTime = now;

        let needsMore = false;

        if (cameraAnim.active) {
          const factor = isSoftwareGl ? 1.0 : 1 - Math.exp(-9 * dt);
          const dx = camera.position.x - controls.target.x;
          const dz = camera.position.z - controls.target.z;
          const curRadius = Math.hypot(dx, dz) || 3.65;
          const curAzimuth = Math.atan2(dx, dz);

          let dAz = cameraAnim.targetAzimuth - curAzimuth;
          while (dAz > Math.PI) dAz -= Math.PI * 2;
          while (dAz < -Math.PI) dAz += Math.PI * 2;

          const nextAz = curAzimuth + dAz * factor;
          const nextRad = THREE.MathUtils.lerp(curRadius, cameraAnim.targetRadius, factor);
          const nextY = THREE.MathUtils.lerp(camera.position.y, cameraAnim.targetHeight, factor);

          controls.target.lerp(cameraAnim.targetLook, factor);
          camera.position.set(
            controls.target.x + Math.sin(nextAz) * nextRad,
            nextY,
            controls.target.z + Math.cos(nextAz) * nextRad,
          );

          if (isSoftwareGl || (Math.abs(dAz) < 0.004 && Math.abs(nextRad - cameraAnim.targetRadius) < 0.005)) {
            controls.target.copy(cameraAnim.targetLook);
            camera.position.set(
              controls.target.x + Math.sin(cameraAnim.targetAzimuth) * cameraAnim.targetRadius,
              cameraAnim.targetHeight,
              controls.target.z + Math.cos(cameraAnim.targetAzimuth) * cameraAnim.targetRadius,
            );
            cameraAnim.active = false;
          } else {
            needsMore = true;
          }
        }

        if (propsRef.current.turntable && sceneRefs.current?.subjectMesh) {
          modelGroup.rotation.y += dt * 0.45;
          needsMore = true;
        }

        const ctrlChanged = controls.update();
        if (ctrlChanged && !isSoftwareGl) {
          needsMore = true;
        }

        renderer.render(scene, camera);

        const done = () => {
          renderBusy = false;
          if (disposed) return;
          if (renderDirty || needsMore) {
            requestRender();
          }
        };

        if (isSoftwareGl) {
          afterDraw(done);
        } else {
          done();
        }
      });
    }

    const onControlsStart = () => {
      cameraAnim.active = false;
    };
    const onControlsChange = () => {
      requestRender();
    };
    controls.addEventListener('start', onControlsStart);
    controls.addEventListener('change', onControlsChange);

    const onResize = () => {
      if (!container) return;
      const w = container.clientWidth || window.innerWidth;
      const h = container.clientHeight || window.innerHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      requestRender();
    };
    window.addEventListener('resize', onResize);

    if (!isSoftwareGl) {
      renderer.compile(scene, camera);
    }

    sceneRefs.current = {
      scene,
      camera,
      controls,
      modelGroup,
      subjectMesh: null,
      wireOverlay: null,
      projMat: null,
      clayMat,
      wireBaseMat,
      wireLineMat,
      normalMat,
      keyLight,
      hemiLight,
      rimLight,
      requestRender,
      cameraAnim,
    };

    requestRender();

    return () => {
      disposed = true;
      cancelAnimationFrame(frameId);
      clearTimeout(frameId);
      window.removeEventListener('resize', onResize);
      controls.removeEventListener('start', onControlsStart);
      controls.removeEventListener('change', onControlsChange);
      controls.dispose();
      renderer.domElement.removeEventListener('webglcontextlost', onContextLost);

      if (sceneRefs.current?.subjectMesh) {
        sceneRefs.current.subjectMesh.geometry.dispose();
      }
      sceneRefs.current?.projMat?.dispose();
      clayMat.dispose();
      wireBaseMat.dispose();
      wireLineMat.dispose();
      normalMat.dispose();
      plinth.dispose();
      envTex.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
      sceneRefs.current = null;
    };
  }, []);

  // Build or rebuild BufferGeometry & projective material when meshData changes
  useEffect(() => {
    const refs = sceneRefs.current;
    if (!refs || !meshData || !dataset) return;

    if (refs.subjectMesh) {
      refs.modelGroup.remove(refs.subjectMesh);
      refs.subjectMesh.geometry.dispose();
      refs.subjectMesh = null;
    }
    if (refs.wireOverlay) {
      refs.modelGroup.remove(refs.wireOverlay);
      refs.wireOverlay = null;
    }
    if (refs.projMat) {
      refs.projMat.dispose();
      refs.projMat = null;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(meshData.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(meshData.normals, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(meshData.uvs, 2));
    const partAttr =
      meshData.partWeights ?? new Float32Array(meshData.vertexCount * 4);
    geometry.setAttribute('aPartWeights', new THREE.BufferAttribute(partAttr, 4));
    geometry.setIndex(new THREE.BufferAttribute(meshData.indices, 1));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    const projMat = createProjectivePbrMaterial(
      dataset.textureViews,
      dataset.camParams,
      dataset.atlasTextures,
      meshData.depthMaps,
      meshData.depthMapWidth,
      meshData.depthMapHeight,
      propsRef.current.blendSharpness,
      meshData.headCenter,
      dataset.atlasCols,
      dataset.atlasRows,
    );
    refs.projMat = projMat;

    const yGroundOffset = Number.isFinite(meshData.bounds.minY) ? -meshData.bounds.minY : 0;

    const mesh = new THREE.Mesh(geometry, projMat.material);
    mesh.position.y = yGroundOffset;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = 'ReconstructedPerson';
    refs.modelGroup.add(mesh);
    refs.subjectMesh = mesh;

    const wireMesh = new THREE.Mesh(geometry, refs.wireLineMat);
    wireMesh.position.y = yGroundOffset;
    wireMesh.visible = propsRef.current.renderMode === 'wireframe';
    refs.modelGroup.add(wireMesh);
    refs.wireOverlay = wireMesh;

    // Apply current renderMode immediately
    applyRenderMode(refs, propsRef.current.renderMode);
    refs.requestRender();
  }, [meshData, dataset]);

  // Update render mode
  useEffect(() => {
    const refs = sceneRefs.current;
    if (!refs) return;
    applyRenderMode(refs, renderMode);
    refs.requestRender();
  }, [renderMode]);

  // Update blend sharpness
  useEffect(() => {
    const refs = sceneRefs.current;
    if (!refs?.projMat) return;
    refs.projMat.updateBlendSharpness(blendSharpness);
    refs.requestRender();
  }, [blendSharpness]);

  // Update lighting preset
  useEffect(() => {
    const refs = sceneRefs.current;
    if (!refs) return;
    if (lightingPreset === 'studio') {
      refs.keyLight.color.setHex(0xfff3e0);
      refs.keyLight.intensity = 1.75;
      refs.hemiLight.intensity = 0.78;
      refs.rimLight.color.setHex(0xc7dfff);
      refs.rimLight.intensity = 1.05;
    } else if (lightingPreset === 'dramatic') {
      refs.keyLight.color.setHex(0xffe8cc);
      refs.keyLight.intensity = 2.55;
      refs.hemiLight.intensity = 0.36;
      refs.rimLight.color.setHex(0x93c5fd);
      refs.rimLight.intensity = 1.75;
    } else {
      refs.keyLight.color.setHex(0xffd7a8);
      refs.keyLight.intensity = 2.05;
      refs.hemiLight.intensity = 0.65;
      refs.rimLight.color.setHex(0xfde68a);
      refs.rimLight.intensity = 0.95;
    }
    refs.requestRender();
  }, [lightingPreset]);

  // Trigger turntable animation loop when toggled on
  useEffect(() => {
    const refs = sceneRefs.current;
    if (!refs) return;
    if (turntable) {
      refs.requestRender();
    }
  }, [turntable]);

  // Smooth camera preset transition when user selects an angle preset
  useEffect(() => {
    const refs = sceneRefs.current;
    if (!refs || targetAzimuthDeg === null || cameraCommandSeq === 0) return;

    // Reset model rotation when snapping to a calibrated camera preset
    refs.modelGroup.rotation.y = 0;

    const phi = (-targetAzimuthDeg * Math.PI) / 180;
    refs.cameraAnim.targetAzimuth = phi;
    refs.cameraAnim.targetRadius = 4.02;
    refs.cameraAnim.targetHeight = 1.06;
    refs.cameraAnim.targetLook.set(0, 0.70, 0);
    refs.cameraAnim.active = true;
    refs.requestRender();
  }, [targetAzimuthDeg, cameraCommandSeq]);

  return (
    <div
      ref={mountRef}
      data-testid="viewport-3d"
      className="w-full h-full cursor-grab active:cursor-grabbing"
    />
  );
}

function applyRenderMode(
  refs: NonNullable<ReturnType<typeof useRef<{
    subjectMesh: THREE.Mesh | null;
    wireOverlay: THREE.Mesh | null;
    projMat: ProjectiveMaterialResources | null;
    clayMat: THREE.MeshStandardMaterial;
    wireBaseMat: THREE.MeshStandardMaterial;
    normalMat: THREE.MeshNormalMaterial;
  }>>['current']>,
  mode: RenderMode,
) {
  if (!refs.subjectMesh) return;
  if (refs.wireOverlay) {
    refs.wireOverlay.visible = mode === 'wireframe';
  }
  if (mode === 'textured' && refs.projMat) {
    refs.subjectMesh.material = refs.projMat.material;
  } else if (mode === 'clay') {
    refs.subjectMesh.material = refs.clayMat;
  } else if (mode === 'wireframe') {
    refs.subjectMesh.material = refs.wireBaseMat;
  } else if (mode === 'normals') {
    refs.subjectMesh.material = refs.normalMat;
  }
}
