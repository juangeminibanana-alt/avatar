import type { User } from 'firebase/auth';
import { HardDrive } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ControlDock } from './components/ControlDock';
import { DriveDrawer } from './components/DriveDrawer';
import { ReferenceDrawer } from './components/ReferenceDrawer';
import { Viewport3D } from './components/Viewport3D';
import { googleSignIn, initAuth, logout } from './drive/googleDriveAuth';
import { buildGlbBuffer, buildObjString, triggerFileDownload } from './reconstruction/exporters';
import {
  bakeUvTextureCanvas,
  loadAndCalibrateViews,
  reconstructMeshFromDataset,
  type LoadedDataset,
} from './reconstruction/loaderAndAtlas';
import {
  STUDIO_VIEWS,
  type LightingPreset,
  type ReconstructedMeshData,
  type ReconstructionSettings,
  type RenderMode,
  type ViewSpec,
} from './reconstruction/types';

export default function App() {
  const [dataset, setDataset] = useState<LoadedDataset | null>(null);
  const [meshData, setMeshData] = useState<ReconstructedMeshData | null>(null);
  const [progress, setProgress] = useState(0);
  const [stageText, setStageText] = useState('Inicializando motor fotogramétrico...');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [renderMode, setRenderMode] = useState<RenderMode>('textured');
  const [lightingPreset, setLightingPreset] = useState<LightingPreset>('studio');
  const [turntable, setTurntable] = useState(false);
  const [dockCollapsed, setDockCollapsed] = useState(false);
  const [showReference, setShowReference] = useState(false);
  const [showDrive, setShowDrive] = useState(false);

  const [activeViews, setActiveViews] = useState<ViewSpec[]>(STUDIO_VIEWS);
  const [totalGeometryViews, setTotalGeometryViews] = useState<number>(STUDIO_VIEWS.length);
  const [customViewsActive, setCustomViewsActive] = useState(false);

  const [needsAuth, setNeedsAuth] = useState(true);
  const [driveToken, setDriveToken] = useState<string | null>(null);
  const [driveUser, setDriveUser] = useState<User | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [activeViewIndex, setActiveViewIndex] = useState(0);
  const [cameraCommandSeq, setCameraCommandSeq] = useState(0);

  const [settings, setSettings] = useState<ReconstructionSettings>({
    resolution: 'high',
    smoothingPasses: 1,
    blendSharpness: 6.0,
  });

  const [isRebuilding, setIsRebuilding] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  const datasetRef = useRef<LoadedDataset | null>(null);
  const prevGeoSettingsRef = useRef<{ res: string; smooth: number }>({
    res: settings.resolution,
    smooth: settings.smoothingPasses,
  });

  // Initialize Firebase Google Auth listener (in-memory token only)
  useEffect(() => {
    const unsubscribe = initAuth(
      (user, token) => {
        setDriveUser(user);
        setDriveToken(token);
        setNeedsAuth(false);
        setAuthError(null);
      },
      (user) => {
        setDriveUser(user);
        setDriveToken(null);
        setNeedsAuth(true);
      },
    );
    return unsubscribe;
  }, []);

  // Initial load & 3D Visual Hull reconstruction from the 8 4K profile images
  useEffect(() => {
    let cancelled = false;
    document.body.dataset.state = 'loading';

    (async () => {
      try {
        const loaded = await loadAndCalibrateViews(STUDIO_VIEWS, (p, stage) => {
          if (!cancelled) {
            setProgress(p);
            setStageText(stage);
          }
        });
        if (cancelled) {
          loaded.atlasTextures.forEach((t) => t.dispose());
          return;
        }
        setProgress(0.84);
        setStageText('Esculpiendo malla 3D (Marching Cubes + SDF)...');

        // Yield one frame so progress bar paints cleanly before Marching Cubes
        await new Promise((r) => setTimeout(r, 20));
        if (cancelled) return;

        const mesh = reconstructMeshFromDataset(loaded, {
          resolution: 'high',
          smoothingPasses: 1,
          blendSharpness: 6.0,
        });

        datasetRef.current = loaded;
        setDataset(loaded);
        setMeshData(mesh);
        setProgress(1);
        document.body.dataset.state = 'ready';
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : 'Error al reconstruir el modelo 3D.';
          setErrorMsg(msg);
          document.body.dataset.state = 'error';
        }
      }
    })();

    return () => {
      cancelled = true;
      datasetRef.current?.atlasTextures.forEach((t) => t.dispose());
    };
  }, []);

  // Rebuild geometry when voxel resolution or smoothing changes
  useEffect(() => {
    if (!dataset) return;
    if (
      prevGeoSettingsRef.current.res === settings.resolution &&
      prevGeoSettingsRef.current.smooth === settings.smoothingPasses
    ) {
      return;
    }
    prevGeoSettingsRef.current = {
      res: settings.resolution,
      smooth: settings.smoothingPasses,
    };

    setIsRebuilding(true);
    const id = window.setTimeout(() => {
      const rebuilt = reconstructMeshFromDataset(dataset, settings);
      setMeshData(rebuilt);
      setIsRebuilding(false);
    }, 16);

    return () => clearTimeout(id);
  }, [dataset, settings]);

  // Keyboard shortcut 'H' to toggle controls (Zen / Cinema Mode)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'h' || e.key === 'H') {
        setDockCollapsed((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const handleSelectView = useCallback((idx: number) => {
    setActiveViewIndex(idx);
    setTurntable(false);
    setCameraCommandSeq((s) => s + 1);
  }, []);

  const generateObjBlob = useCallback((): Blob | null => {
    if (!meshData) return null;
    const objStr = buildObjString(meshData);
    return new Blob([objStr], { type: 'text/plain;charset=utf-8' });
  }, [meshData]);

  const generateGlbBlob = useCallback(async (): Promise<Blob | null> => {
    if (!meshData || !dataset) return null;
    await new Promise((r) => setTimeout(r, 16));
    const uvCanvas = bakeUvTextureCanvas(meshData, dataset, settings.blendSharpness, 1024);
    const pngBlob = await new Promise<Blob | null>((resolve) =>
      uvCanvas.toBlob(resolve, 'image/png'),
    );
    const pngBytes = pngBlob ? new Uint8Array(await pngBlob.arrayBuffer()) : undefined;
    const glbBuffer = buildGlbBuffer(meshData, pngBytes);
    return new Blob([glbBuffer], { type: 'model/gltf-binary' });
  }, [meshData, dataset, settings.blendSharpness]);

  const handleExportObj = useCallback(() => {
    const blob = generateObjBlob();
    if (!blob) return;
    triggerFileDownload(blob, 'modelo_3d_reconstruido.obj');
  }, [generateObjBlob]);

  const handleExportGlb = useCallback(async () => {
    if (!meshData || !dataset) return;
    setIsExporting(true);
    try {
      const blob = await generateGlbBlob();
      if (blob) {
        triggerFileDownload(blob, 'modelo_3d_reconstruido.glb');
      }
    } finally {
      setIsExporting(false);
    }
  }, [meshData, dataset, generateGlbBlob]);

  const handleDriveSignIn = useCallback(async () => {
    setIsLoggingIn(true);
    setAuthError(null);
    try {
      const result = await googleSignIn();
      setDriveUser(result.user);
      setDriveToken(result.accessToken);
      setNeedsAuth(false);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'No se pudo iniciar sesión con Google.';
      setAuthError(msg);
      setNeedsAuth(true);
    } finally {
      setIsLoggingIn(false);
    }
  }, []);

  const handleDriveSignOut = useCallback(async () => {
    await logout();
    setDriveUser(null);
    setDriveToken(null);
    setNeedsAuth(true);
  }, []);

  const activeViewsRef = useRef<ViewSpec[]>(STUDIO_VIEWS);
  activeViewsRef.current = activeViews;

  useEffect(() => {
    return () => {
      for (const view of activeViewsRef.current) {
        if (view.url.startsWith('blob:')) {
          URL.revokeObjectURL(view.url);
        }
      }
    };
  }, []);

  const rebuildDatasetFromViews = useCallback(
    async (
      viewsToLoad: ViewSpec[],
      isCustom: boolean,
      onProgress?: (p: number, stage: string) => void,
      signal?: AbortSignal,
    ) => {
      setIsRebuilding(true);
      try {
        const loaded = await loadAndCalibrateViews(viewsToLoad, onProgress, signal);
        if (signal?.aborted) {
          loaded.atlasTextures.forEach((t) => t.dispose());
          for (const pv of loaded.previewViews) {
            if (pv.url.startsWith('blob:')) URL.revokeObjectURL(pv.url);
          }
          throw new DOMException('Reconstrucción cancelada.', 'AbortError');
        }
        onProgress?.(0.84, `Esculpiendo malla 3D (${loaded.views.length} vistas)...`);
        await new Promise((r) => setTimeout(r, 20));
        if (signal?.aborted) {
          loaded.atlasTextures.forEach((t) => t.dispose());
          for (const pv of loaded.previewViews) {
            if (pv.url.startsWith('blob:')) URL.revokeObjectURL(pv.url);
          }
          throw new DOMException('Reconstrucción cancelada.', 'AbortError');
        }

        const rebuilt = reconstructMeshFromDataset(loaded, settings);
        const previousViews = activeViewsRef.current;
        datasetRef.current?.atlasTextures.forEach((t) => t.dispose());
        datasetRef.current = loaded;
        setDataset(loaded);
        setMeshData(rebuilt);
        setActiveViews(loaded.previewViews);
        setTotalGeometryViews(loaded.views.length);
        setActiveViewIndex(0);
        setCustomViewsActive(isCustom);
        onProgress?.(1, 'Modelo 3D reconstruido.');
        for (const view of previousViews) {
          if (view.url.startsWith('blob:') && !loaded.previewViews.some((v) => v.url === view.url)) {
            URL.revokeObjectURL(view.url);
          }
        }
      } finally {
        setIsRebuilding(false);
      }
    },
    [settings],
  );

  const handleReconstructFromDriveViews = useCallback(
    async (
      viewsFromDrive: ViewSpec[],
      onProgress?: (p: number, stage: string) => void,
      signal?: AbortSignal,
    ) => {
      await rebuildDatasetFromViews(viewsFromDrive, true, onProgress, signal);
    },
    [rebuildDatasetFromViews],
  );

  const handleResetDefaultViews = useCallback(async () => {
    await rebuildDatasetFromViews(STUDIO_VIEWS, false);
  }, [rebuildDatasetFromViews]);

  const targetAzimuthDeg = activeViews[activeViewIndex]?.azimuthDeg ?? 0;

  return (
    <main className="relative w-screen h-screen overflow-hidden bg-[#111318] select-none">
      {/* Unobstructed 100% 3D Studio Viewport */}
      <Viewport3D
        dataset={dataset}
        meshData={meshData}
        renderMode={renderMode}
        lightingPreset={lightingPreset}
        blendSharpness={settings.blendSharpness}
        turntable={turntable}
        targetAzimuthDeg={targetAzimuthDeg}
        cameraCommandSeq={cameraCommandSeq}
        onWebglError={(msg) => setErrorMsg(msg)}
      />

      {/* Minimal Top-Left Header Spec (Unboxed Typography, Zero Pills, Zero Pulsing Dots) */}
      <header className="fixed top-4 left-5 z-10 pointer-events-none max-w-[min(560px,80vw)]">
        <h1 className="text-base sm:text-lg font-semibold tracking-tight text-zinc-100">
          Estudio 3D Fotogramétrico
        </h1>
        <p className="mt-0.5 text-xs text-zinc-400 font-mono-tabular flex flex-wrap items-center gap-x-2">
          <span>
            {totalGeometryViews} {totalGeometryViews === 1 ? 'perfil' : 'perfiles'} 4K
            {activeViews.length !== totalGeometryViews
              ? ` · ${activeViews.length} texturas`
              : ''}
          </span>
          <span aria-hidden="true">·</span>
          <span>2160×3840</span>
          {meshData && (
            <>
              <span aria-hidden="true">·</span>
              <span data-testid="mesh-stats">
                {meshData.vertexCount.toLocaleString('es-ES')} vértices ·{' '}
                {meshData.triangleCount.toLocaleString('es-ES')} triángulos
              </span>
            </>
          )}
          {isRebuilding && (
            <>
              <span aria-hidden="true">·</span>
              <span className="text-amber-400">Actualizando malla...</span>
            </>
          )}
        </p>
      </header>

      {/* Reconstruction Loading Overlay (disappears once 3D mesh is ready) */}
      {!meshData && !errorMsg && (
        <div
          role="status"
          aria-live="polite"
          className="fixed inset-0 z-30 flex items-center justify-center bg-[#111318]/92 px-6"
        >
          <div className="w-full max-w-md rounded-xl bg-[#181c24] border border-white/10 p-6 space-y-4">
            <div className="space-y-1">
              <h2 className="text-base font-semibold text-zinc-100">
                Construyendo modelo 3D multivista
              </h2>
              <p className="text-xs text-zinc-400">{stageText}</p>
            </div>
            <div className="h-1.5 w-full rounded-full bg-white/10 overflow-hidden">
              <div
                className="h-full bg-amber-500 transition-all duration-200"
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
            <div className="flex justify-between text-[11px] font-mono-tabular text-zinc-400">
              <span>Casco visual SDF · Marching Cubes</span>
              <span>{Math.round(progress * 100)}%</span>
            </div>
          </div>
        </div>
      )}

      {/* Error State */}
      {errorMsg && (
        <div
          role="alert"
          className="fixed inset-0 z-40 flex items-center justify-center bg-[#111318]/95 px-6"
        >
          <div className="max-w-md rounded-xl bg-[#181c24] border border-red-500/30 p-6 space-y-3">
            <h2 className="text-base font-semibold text-red-300">
              No se pudo iniciar la escena 3D
            </h2>
            <p className="text-sm text-zinc-300">{errorMsg}</p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="px-4 py-2 rounded-lg text-xs font-semibold bg-amber-500 text-zinc-950 hover:bg-amber-400 cursor-pointer"
            >
              Reintentar
            </button>
          </div>
        </div>
      )}

      {/* Quick Google Drive Entry Button in Top-Right when drawers are closed */}
      {meshData && !showDrive && !showReference && (
        <button
          type="button"
          onClick={() => setShowDrive(true)}
          aria-label="Abrir panel de Google Drive"
          className="fixed top-4 right-4 z-20 inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#161920]/96 border border-white/12 text-xs font-medium text-zinc-200 hover:text-white hover:bg-[#1f242e] shadow-lg transition-colors cursor-pointer"
        >
          <HardDrive className="w-3.5 h-3.5 text-amber-400" />
          <span>{driveToken && !needsAuth ? 'Google Drive' : 'Conectar Google Drive'}</span>
        </button>
      )}

      {/* Optional 4K Photo Reference Drawer */}
      <ReferenceDrawer
        open={showReference}
        views={activeViews}
        activeViewIndex={activeViewIndex}
        onSelectView={handleSelectView}
        onClose={() => setShowReference(false)}
      />

      {/* Google Drive Studio Drawer */}
      <DriveDrawer
        open={showDrive}
        onClose={() => setShowDrive(false)}
        user={driveUser}
        accessToken={driveToken}
        needsAuth={needsAuth}
        isLoggingIn={isLoggingIn}
        authError={authError}
        onSignIn={handleDriveSignIn}
        onSignOut={handleDriveSignOut}
        onAuthExpired={() => {
          setDriveToken(null);
          setNeedsAuth(true);
        }}
        onGenerateGlbBlob={generateGlbBlob}
        onGenerateObjBlob={generateObjBlob}
        hasMesh={Boolean(meshData)}
        customViewsActive={customViewsActive}
        onReconstructFromViews={handleReconstructFromDriveViews}
        onResetDefaultViews={handleResetDefaultViews}
      />

      {/* Unified Collapsible Bottom Control Dock */}
      {meshData && (
        <ControlDock
          collapsed={dockCollapsed}
          onToggleCollapse={() => setDockCollapsed((c) => !c)}
          views={activeViews}
          activeViewIndex={activeViewIndex}
          onSelectView={handleSelectView}
          renderMode={renderMode}
          onChangeRenderMode={setRenderMode}
          lightingPreset={lightingPreset}
          onChangeLighting={setLightingPreset}
          turntable={turntable}
          onToggleTurntable={() => setTurntable((t) => !t)}
          showReference={showReference}
          onToggleReference={() => {
            setShowReference((r) => {
              if (!r) setShowDrive(false);
              return !r;
            });
          }}
          showDrive={showDrive}
          onToggleDrive={() => {
            setShowDrive((d) => {
              if (!d) setShowReference(false);
              return !d;
            });
          }}
          settings={settings}
          onChangeSettings={setSettings}
          onExportGlb={handleExportGlb}
          onExportObj={handleExportObj}
          isExporting={isExporting}
          isRebuilding={isRebuilding}
        />
      )}
    </main>
  );
}
