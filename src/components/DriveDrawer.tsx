import type { User } from 'firebase/auth';
import {
  ArrowLeft,
  Check,
  Download,
  ExternalLink,
  Folder,
  FolderOpen,
  HardDrive,
  Image as ImageIcon,
  Link2,
  LogOut,
  RefreshCw,
  Replace,
  RotateCcw,
  Search,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DRIVE_FOLDER_MIME_TYPE,
  LINKED_DRIVE_FOLDER_ID,
  LINKED_DRIVE_FOLDER_URL,
  deleteDriveFile,
  downloadDriveFileBlob,
  extractDriveFolderId,
  formatFileSize,
  getDriveFileMetadata,
  listAllDriveImagesInFolder,
  listDriveFiles,
  orderAndAssign360Degrees,
  orderImagesForStudioViews,
  overwriteDriveFile,
  sampleDriveCatalogViews,
  uploadFileToDrive,
  type DriveCatalogViewItem,
  type DriveFileCategory,
  type DriveFileItem,
} from '../drive/googleDriveApi';
import { clearAccessToken } from '../drive/googleDriveAuth';
import { triggerFileDownload } from '../reconstruction/exporters';
import { STUDIO_VIEWS, type ViewSpec } from '../reconstruction/types';
import { GoogleSignInButton } from './GoogleSignInButton';

interface DriveDrawerProps {
  open: boolean;
  onClose: () => void;
  user: User | null;
  accessToken: string | null;
  needsAuth: boolean;
  isLoggingIn: boolean;
  authError: string | null;
  onSignIn: () => Promise<void>;
  onSignOut: () => Promise<void>;
  onAuthExpired: () => void;
  onGenerateGlbBlob: () => Promise<Blob | null>;
  onGenerateObjBlob: () => Blob | null;
  hasMesh: boolean;
  customViewsActive: boolean;
  onReconstructFromViews: (
    views: ViewSpec[],
    onProgress?: (progress: number, stage: string) => void,
    signal?: AbortSignal,
  ) => Promise<void>;
  onResetDefaultViews: () => Promise<void>;
}

type PendingConfirmation =
  | { kind: 'delete'; file: DriveFileItem }
  | { kind: 'overwrite'; file: DriveFileItem; format: 'glb' | 'obj' };

const CATEGORY_TABS: ReadonlyArray<{ id: DriveFileCategory; label: string }> = [
  { id: 'all', label: 'Todos' },
  { id: 'models', label: 'Modelos 3D' },
  { id: 'images', label: 'Imágenes' },
];

export function DriveDrawer({
  open,
  onClose,
  user,
  accessToken,
  needsAuth,
  isLoggingIn,
  authError,
  onSignIn,
  onSignOut,
  onAuthExpired,
  onGenerateGlbBlob,
  onGenerateObjBlob,
  hasMesh,
  customViewsActive,
  onReconstructFromViews,
  onResetDefaultViews,
}: DriveDrawerProps) {
  const [files, setFiles] = useState<DriveFileItem[]>([]);
  const [searchText, setSearchText] = useState('');
  const [category, setCategory] = useState<DriveFileCategory>('all');
  const [activeFolderId, setActiveFolderId] = useState<string | null>(LINKED_DRIVE_FOLDER_ID);
  const [folderHistory, setFolderHistory] = useState<string[]>([]);
  const [folderMeta, setFolderMeta] = useState<DriveFileItem | null>(null);
  const [showFolderInput, setShowFolderInput] = useState(false);
  const [folderInput, setFolderInput] = useState('');
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [isUploading, setIsUploading] = useState<'glb' | 'obj' | null>(null);
  const [isMutating, setIsMutating] = useState(false);
  const [fileBaseName, setFileBaseName] = useState('modelo_3d_reconstruido');
  const [statusMessage, setStatusMessage] = useState<{
    type: 'success' | 'error';
    text: string;
    link?: string;
  } | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirmation | null>(null);
  const [selectedDriveImages, setSelectedDriveImages] = useState<DriveFileItem[]>([]);
  const [isImportingViews, setIsImportingViews] = useState(false);
  const [importProgress, setImportProgress] = useState(0);
  const [importStage, setImportStage] = useState('');
  const [folderCatalog, setFolderCatalog] = useState<DriveCatalogViewItem[]>([]);
  const [isScanningCatalog, setIsScanningCatalog] = useState(false);
  const [catalogScanCount, setCatalogScanCount] = useState(0);
  const [densityTarget, setDensityTarget] = useState(36);

  const catalogReqRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  const orderedFolderImages = useMemo(() => orderImagesForStudioViews(files), [files]);

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  const fetchFiles = useCallback(async () => {
    if (!accessToken) return;
    const reqId = ++catalogReqRef.current;
    setIsLoadingFiles(true);
    if (activeFolderId) {
      setIsScanningCatalog(true);
      setCatalogScanCount(0);
    } else {
      setFolderCatalog([]);
      setIsScanningCatalog(false);
    }

    try {
      const [listRes, metaRes] = await Promise.all([
        listDriveFiles(accessToken, searchText, category, 50, activeFolderId),
        activeFolderId
          ? getDriveFileMetadata(accessToken, activeFolderId).catch(() => null)
          : Promise.resolve(null),
      ]);
      if (catalogReqRef.current !== reqId) return;
      setFiles(listRes.files);
      setFolderMeta(metaRes);

      if (activeFolderId) {
        const allImages = await listAllDriveImagesInFolder(accessToken, activeFolderId, (c) => {
          if (catalogReqRef.current === reqId) setCatalogScanCount(c);
        });
        if (catalogReqRef.current !== reqId) return;
        const catalog = orderAndAssign360Degrees(allImages);
        setFolderCatalog(catalog);
        setDensityTarget((prev) => {
          if (catalog.length === 0) return 36;
          if (catalog.length >= 36 && (prev === 36 || prev === 72 || prev === catalog.length)) {
            return prev;
          }
          return catalog.length >= 36 ? 36 : catalog.length;
        });
      }
    } catch (err) {
      if (err instanceof Error && err.message === 'AUTH_EXPIRED') {
        clearAccessToken();
        onAuthExpired();
        setStatusMessage({
          type: 'error',
          text: 'Tu sesión de Google Drive expiró. Inicia sesión nuevamente.',
        });
      } else {
        setStatusMessage({
          type: 'error',
          text: err instanceof Error ? err.message : 'Error al consultar Google Drive.',
        });
      }
    } finally {
      if (catalogReqRef.current === reqId) {
        setIsLoadingFiles(false);
        setIsScanningCatalog(false);
      }
    }
  }, [accessToken, searchText, category, activeFolderId, onAuthExpired]);

  useEffect(() => {
    if (open && accessToken && !needsAuth) {
      void fetchFiles();
    }
  }, [open, accessToken, needsAuth, fetchFiles]);

  if (!open) return null;

  const activeFolderLabel = activeFolderId
    ? folderMeta?.name ||
      (activeFolderId === LINKED_DRIVE_FOLDER_ID ? 'Carpeta vinculada' : 'Carpeta de Drive')
    : 'Toda mi unidad';

  const activeFolderLink =
    folderMeta?.webViewLink ||
    (activeFolderId === LINKED_DRIVE_FOLDER_ID
      ? LINKED_DRIVE_FOLDER_URL
      : activeFolderId
        ? `https://drive.google.com/drive/folders/${encodeURIComponent(activeFolderId)}`
        : undefined);

  const handleOpenFolderFromInput = () => {
    const parsedId = extractDriveFolderId(folderInput);
    if (!parsedId) {
      setStatusMessage({
        type: 'error',
        text: 'Pega un enlace válido de carpeta de Google Drive o su ID.',
      });
      return;
    }
    setStatusMessage(null);
    setFolderHistory([]);
    setSelectedDriveImages([]);
    setActiveFolderId(parsedId);
    setShowFolderInput(false);
    setFolderInput('');
  };

  const handleOpenSubfolder = (folder: DriveFileItem) => {
    setStatusMessage(null);
    setFolderHistory((prev) => (activeFolderId ? [...prev, activeFolderId] : prev));
    setSelectedDriveImages([]);
    setActiveFolderId(folder.id);
  };

  const handleGoUpFolder = () => {
    setStatusMessage(null);
    setSelectedDriveImages([]);
    setFolderHistory((prev) => {
      if (prev.length === 0) {
        setActiveFolderId(null);
        return prev;
      }
      const next = [...prev];
      const parentId = next.pop() ?? null;
      setActiveFolderId(parentId);
      return next;
    });
  };

  const handleUploadNew = async (format: 'glb' | 'obj') => {
    if (!accessToken || !hasMesh) return;
    setIsUploading(format);
    setStatusMessage(null);
    try {
      const cleanBase = (fileBaseName.trim() || 'modelo_3d_reconstruido').replace(
        /\.(glb|obj)$/i,
        '',
      );
      const fullName = `${cleanBase}.${format}`;
      const mimeType = format === 'glb' ? 'model/gltf-binary' : 'text/plain';
      const blob = format === 'glb' ? await onGenerateGlbBlob() : onGenerateObjBlob();
      if (!blob) {
        throw new Error('No se pudo preparar el archivo 3D para subir.');
      }

      const uploaded = await uploadFileToDrive(accessToken, {
        name: fullName,
        mimeType,
        blob,
        parentId: activeFolderId,
      });

      setStatusMessage({
        type: 'success',
        text: `Archivo "${uploaded.name}" guardado en ${activeFolderLabel}.`,
        link: uploaded.webViewLink,
      });
      await fetchFiles();
    } catch (err) {
      if (err instanceof Error && err.message === 'AUTH_EXPIRED') {
        clearAccessToken();
        onAuthExpired();
      }
      setStatusMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'No se pudo subir el modelo a Google Drive.',
      });
    } finally {
      setIsUploading(null);
    }
  };

  const handleDownload = async (file: DriveFileItem) => {
    if (!accessToken) return;
    setStatusMessage(null);
    try {
      const blob = await downloadDriveFileBlob(accessToken, file.id);
      triggerFileDownload(blob, file.name);
    } catch (err) {
      if (err instanceof Error && err.message === 'AUTH_EXPIRED') {
        clearAccessToken();
        onAuthExpired();
      }
      setStatusMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'No se pudo descargar el archivo.',
      });
    }
  };

  const handleConfirmPendingAction = async () => {
    if (!pendingConfirm || !accessToken) return;
    setIsMutating(true);
    setStatusMessage(null);
    try {
      if (pendingConfirm.kind === 'delete') {
        await deleteDriveFile(accessToken, pendingConfirm.file.id);
        setSelectedDriveImages((prev) =>
          prev.filter((item) => item.id !== pendingConfirm.file.id),
        );
        setStatusMessage({
          type: 'success',
          text: `Archivo "${pendingConfirm.file.name}" eliminado de Google Drive.`,
        });
      } else {
        const mimeType = pendingConfirm.format === 'glb' ? 'model/gltf-binary' : 'text/plain';
        const blob =
          pendingConfirm.format === 'glb' ? await onGenerateGlbBlob() : onGenerateObjBlob();
        if (!blob) {
          throw new Error('No se pudo generar la geometría actual para sobrescribir.');
        }
        const updated = await overwriteDriveFile(
          accessToken,
          pendingConfirm.file.id,
          blob,
          mimeType,
        );
        setStatusMessage({
          type: 'success',
          text: `Archivo "${updated.name}" actualizado en Google Drive.`,
          link: updated.webViewLink,
        });
      }
      setPendingConfirm(null);
      await fetchFiles();
    } catch (err) {
      if (err instanceof Error && err.message === 'AUTH_EXPIRED') {
        clearAccessToken();
        onAuthExpired();
      }
      setStatusMessage({
        type: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'Error al modificar el archivo en Google Drive.',
      });
      setPendingConfirm(null);
    } finally {
      setIsMutating(false);
    }
  };

  const toggleSelectDriveImage = (file: DriveFileItem) => {
    setSelectedDriveImages((prev) => {
      const exists = prev.some((item) => item.id === file.id);
      if (exists) return prev.filter((item) => item.id !== file.id);
      if (prev.length >= STUDIO_VIEWS.length) return prev;
      return [...prev, file];
    });
  };

  const handleCancelImport = () => {
    abortControllerRef.current?.abort();
  };

  const handleBuildFromDriveImages = async (imagesToBuild = selectedDriveImages) => {
    if (!accessToken || imagesToBuild.length !== STUDIO_VIEWS.length) return;
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setIsImportingViews(true);
    setImportProgress(0.02);
    setImportStage('Preparando descarga de 8 vistas...');
    setStatusMessage(null);
    try {
      const nextViews: ViewSpec[] = imagesToBuild.map((driveItem, i) => {
        const base = STUDIO_VIEWS[i];
        return {
          ...base,
          url: '',
          loadBlob: (sig) => downloadDriveFileBlob(accessToken, driveItem.id, sig),
        };
      });
      await onReconstructFromViews(
        nextViews,
        (p, stage) => {
          setImportProgress(p);
          setImportStage(stage);
        },
        controller.signal,
      );
      setSelectedDriveImages(imagesToBuild);
      setStatusMessage({
        type: 'success',
        text: 'Modelo 3D reconstruido a partir de las 8 imágenes de Google Drive.',
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        setStatusMessage({
          type: 'error',
          text: 'Reconstrucción cancelada por el usuario.',
        });
      } else {
        if (err instanceof Error && err.message === 'AUTH_EXPIRED') {
          clearAccessToken();
          onAuthExpired();
        }
        setStatusMessage({
          type: 'error',
          text:
            err instanceof Error
              ? err.message
              : 'No se pudieron procesar las imágenes seleccionadas desde Google Drive.',
        });
      }
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
      setIsImportingViews(false);
    }
  };

  const handleBuild360FromCatalog = async (targetCount: number) => {
    if (!accessToken || folderCatalog.length === 0) return;
    const picked = sampleDriveCatalogViews(folderCatalog, targetCount);
    if (picked.length < 4) return;

    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setIsImportingViews(true);
    setImportProgress(0.02);
    setImportStage(`Preparando ${picked.length} vistas 4K desde Drive...`);
    setStatusMessage(null);

    try {
      const nextViews: ViewSpec[] = picked.map((item, idx) => ({
        id: `drive360_${idx}_${item.file.id}`,
        url: '',
        azimuthDeg: item.azimuthDeg,
        label: item.label,
        shortLabel: item.shortLabel,
        loadBlob: (sig) => downloadDriveFileBlob(accessToken, item.file.id, sig),
      }));

      await onReconstructFromViews(
        nextViews,
        (p, stage) => {
          setImportProgress(p);
          setImportStage(stage);
        },
        controller.signal,
      );
      setStatusMessage({
        type: 'success',
        text: `Modelo 3D reconstruido con ${picked.length} vistas (${folderCatalog.length} disponibles en la carpeta).`,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        setStatusMessage({
          type: 'error',
          text: 'Reconstrucción cancelada por el usuario.',
        });
      } else {
        if (err instanceof Error && err.message === 'AUTH_EXPIRED') {
          clearAccessToken();
          onAuthExpired();
        }
        setStatusMessage({
          type: 'error',
          text:
            err instanceof Error
              ? err.message
              : 'No se pudieron procesar las imágenes 360° desde Google Drive.',
        });
      }
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
      setIsImportingViews(false);
    }
  };

  const showSignInView = needsAuth || !accessToken;

  return (
    <>
      <aside
        aria-label="Panel de Google Drive"
        className="fixed top-4 right-4 z-30 w-[min(420px,92vw)] max-h-[calc(100vh-120px)] flex flex-col rounded-xl bg-[#161920]/96 border border-white/12 shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-white/10">
          <div className="flex items-center gap-2 min-w-0">
            <HardDrive className="w-4 h-4 text-amber-400 shrink-0" />
            <h2 className="text-sm font-semibold text-zinc-100 truncate">Google Drive</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar panel de Google Drive"
            className="p-1 rounded-md text-zinc-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 overflow-y-auto space-y-3.5 text-xs">
          {showSignInView ? (
            <div className="space-y-4 py-1">
              <div className="space-y-1.5">
                <p className="text-sm font-medium text-zinc-100">
                  Conecta tu cuenta de Google Drive
                </p>
                <p className="text-xs text-zinc-400 leading-relaxed">
                  Al iniciar sesión con tu permiso, el estudio abrirá directamente tu carpeta
                  vinculada para importar todas tus vistas 4K (360°) o guardar tus modelos .GLB y .OBJ.
                </p>
              </div>

              <div className="rounded-lg bg-[#101217] border border-white/10 p-3 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-amber-300">
                    <FolderOpen className="w-3.5 h-3.5" />
                    <span>Carpeta vinculada lista al conectar</span>
                  </span>
                  <a
                    href={LINKED_DRIVE_FOLDER_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-[11px] text-zinc-300 hover:text-white underline"
                  >
                    <span>Ver</span>
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
                <p className="text-[11px] font-mono text-zinc-400 truncate">
                  ID: {LINKED_DRIVE_FOLDER_ID}
                </p>
              </div>

              {(authError || statusMessage?.type === 'error') && (
                <div
                  role="alert"
                  className="rounded-lg bg-red-500/15 border border-red-500/30 px-3 py-2 text-xs text-red-200"
                >
                  {authError || statusMessage?.text}
                </div>
              )}

              <div className="pt-1">
                <GoogleSignInButton onClick={() => void onSignIn()} disabled={isLoggingIn} />
              </div>
            </div>
          ) : (
            <>
              {/* Account Bar */}
              <div className="flex items-center justify-between gap-2 rounded-lg bg-[#101217] border border-white/8 px-3 py-2">
                <div className="min-w-0">
                  <div className="font-medium text-zinc-100 truncate">
                    {user?.displayName || 'Cuenta de Google conectada'}
                  </div>
                  {user?.email && (
                    <div className="text-[11px] text-zinc-400 truncate">{user.email}</div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => void onSignOut()}
                  aria-label="Cerrar sesión de Google"
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-[#1f242e] text-zinc-300 hover:text-white hover:bg-[#272d39] transition-colors shrink-0 cursor-pointer"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span>Salir</span>
                </button>
              </div>

              {/* Active Folder Bar */}
              <section className="rounded-lg bg-[#101217] border border-white/8 p-2.5 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <FolderOpen className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                    <span className="font-medium text-zinc-100 truncate" title={activeFolderLabel}>
                      {activeFolderLabel}
                    </span>
                    {activeFolderLink && (
                      <a
                        href={activeFolderLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label="Abrir carpeta actual en Google Drive"
                        title="Abrir carpeta en Google Drive"
                        className="text-zinc-400 hover:text-amber-300 shrink-0"
                      >
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {folderHistory.length > 0 && (
                      <button
                        type="button"
                        onClick={handleGoUpFolder}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded bg-[#1f242e] text-[11px] text-zinc-300 hover:text-white cursor-pointer"
                      >
                        <ArrowLeft className="w-3 h-3" />
                        <span>Volver</span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setShowFolderInput((s) => !s)}
                      aria-expanded={showFolderInput}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded bg-[#1f242e] text-[11px] text-zinc-300 hover:text-white cursor-pointer"
                    >
                      <Link2 className="w-3 h-3" />
                      <span>Enlace</span>
                    </button>
                  </div>
                </div>

                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      setFolderHistory([]);
                      setSelectedDriveImages([]);
                      setActiveFolderId(LINKED_DRIVE_FOLDER_ID);
                    }}
                    className={`flex-1 py-1 px-2 rounded text-[11px] font-medium transition-colors cursor-pointer ${
                      activeFolderId === LINKED_DRIVE_FOLDER_ID
                        ? 'bg-amber-500/20 text-amber-200 border border-amber-500/40'
                        : 'bg-[#181c24] text-zinc-400 hover:text-white border border-white/6'
                    }`}
                  >
                    Carpeta vinculada
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setFolderHistory([]);
                      setSelectedDriveImages([]);
                      setActiveFolderId(null);
                    }}
                    className={`flex-1 py-1 px-2 rounded text-[11px] font-medium transition-colors cursor-pointer ${
                      activeFolderId === null
                        ? 'bg-zinc-200 text-zinc-950'
                        : 'bg-[#181c24] text-zinc-400 hover:text-white border border-white/6'
                    }`}
                  >
                    Toda mi unidad
                  </button>
                </div>

                {showFolderInput && (
                  <div className="flex items-center gap-1.5 pt-1">
                    <input
                      type="text"
                      value={folderInput}
                      onChange={(e) => setFolderInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleOpenFolderFromInput();
                      }}
                      placeholder="https://drive.google.com/drive/folders/..."
                      aria-label="Enlace o ID de carpeta de Google Drive"
                      className="flex-1 min-w-0 px-2.5 py-1.5 rounded bg-[#181c24] border border-white/12 text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-amber-500"
                    />
                    <button
                      type="button"
                      onClick={handleOpenFolderFromInput}
                      className="px-2.5 py-1.5 rounded font-semibold bg-amber-500 text-zinc-950 hover:bg-amber-400 shrink-0 cursor-pointer"
                    >
                      Abrir
                    </button>
                  </div>
                )}
              </section>

              {/* Status Banner */}
              {statusMessage && (
                <div
                  role={statusMessage.type === 'error' ? 'alert' : 'status'}
                  className={`rounded-lg border px-3 py-2 flex items-start justify-between gap-2 ${
                    statusMessage.type === 'error'
                      ? 'bg-red-500/15 border-red-500/30 text-red-200'
                      : 'bg-emerald-500/15 border-emerald-500/30 text-emerald-200'
                  }`}
                >
                  <div className="space-y-1 min-w-0">
                    <p>{statusMessage.text}</p>
                    {statusMessage.link && (
                      <a
                        href={statusMessage.link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-amber-300 hover:text-amber-200 underline"
                      >
                        <span>Abrir en Google Drive</span>
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setStatusMessage(null)}
                    aria-label="Cerrar mensaje"
                    className="text-zinc-400 hover:text-white cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}

              {/* Upload Current 3D Model */}
              <section className="space-y-2 rounded-lg bg-[#101217] border border-white/8 p-3">
                <label className="block space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-medium text-zinc-300">
                      Guardar modelo 3D actual
                    </span>
                    <span className="text-[10px] text-zinc-400 truncate max-w-[170px]">
                      En: {activeFolderLabel}
                    </span>
                  </div>
                  <input
                    type="text"
                    value={fileBaseName}
                    onChange={(e) => setFileBaseName(e.target.value)}
                    placeholder="modelo_3d_reconstruido"
                    className="w-full px-2.5 py-1.5 rounded-md bg-[#181c24] border border-white/12 text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-amber-500"
                  />
                </label>

                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    disabled={!hasMesh || isUploading !== null}
                    onClick={() => void handleUploadNew('glb')}
                    className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md font-semibold bg-amber-500 text-zinc-950 hover:bg-amber-400 disabled:opacity-50 transition-colors cursor-pointer"
                  >
                    <Upload className="w-3.5 h-3.5" />
                    <span>{isUploading === 'glb' ? 'Subiendo...' : 'Subir .GLB'}</span>
                  </button>
                  <button
                    type="button"
                    disabled={!hasMesh || isUploading !== null}
                    onClick={() => void handleUploadNew('obj')}
                    className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md font-medium bg-[#1f242e] border border-white/12 text-zinc-200 hover:bg-[#272d39] disabled:opacity-50 transition-colors cursor-pointer"
                  >
                    <Upload className="w-3.5 h-3.5" />
                    <span>{isUploading === 'obj' ? 'Subiendo...' : 'Subir .OBJ'}</span>
                  </button>
                </div>
              </section>

              {/* 360° Full-Folder Reconstruction or Quick 8-View Auto-Import */}
              {isScanningCatalog && folderCatalog.length === 0 && activeFolderId && (
                <section className="rounded-lg bg-[#101217] border border-white/8 px-3 py-2 text-[11px] text-zinc-300">
                  Indexando imágenes de la carpeta ({catalogScanCount} detectadas)...
                </section>
              )}

              {folderCatalog.length >= 16 && selectedDriveImages.length === 0 ? (
                <section className="rounded-lg bg-amber-500/10 border border-amber-500/30 p-3 space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5 font-medium text-amber-200">
                      <Sparkles className="w-3.5 h-3.5 shrink-0" />
                      <span>
                        {folderCatalog.length} imágenes 360° detectadas en carpeta
                      </span>
                    </span>
                    {customViewsActive && (
                      <button
                        type="button"
                        disabled={isImportingViews}
                        onClick={() => void onResetDefaultViews()}
                        className="inline-flex items-center gap-1 text-[11px] text-zinc-200 hover:text-white underline cursor-pointer"
                      >
                        <RotateCcw className="w-3 h-3" />
                        <span>Base</span>
                      </button>
                    )}
                  </div>

                  {/* Density Tier Selector */}
                  <div className="grid grid-cols-3 gap-1.5">
                    {(folderCatalog.length >= 36
                      ? [
                          { count: 36, label: '36 vistas (10°)' },
                          ...(folderCatalog.length >= 72
                            ? [{ count: 72, label: '72 vistas (5°)' }]
                            : []),
                          ...(folderCatalog.length !== 36 && folderCatalog.length !== 72
                            ? [
                                {
                                  count: folderCatalog.length,
                                  label: `${folderCatalog.length} (${folderCatalog.length === 360 ? '1°' : 'Todas'})`,
                                },
                              ]
                            : []),
                        ]
                      : [
                          { count: 16, label: '16 vistas' },
                          { count: folderCatalog.length, label: `${folderCatalog.length} (Todas)` },
                        ]
                    ).map((tier) => {
                      const active = densityTarget === tier.count;
                      return (
                        <button
                          key={tier.count}
                          type="button"
                          disabled={isImportingViews}
                          onClick={() => setDensityTarget(tier.count)}
                          className={`px-2 py-1 rounded text-[11px] font-medium transition-colors cursor-pointer disabled:opacity-50 ${
                            active
                              ? 'bg-amber-500 text-zinc-950 font-semibold'
                              : 'bg-[#181c24] text-zinc-300 hover:text-white border border-white/10'
                          }`}
                        >
                          {tier.label}
                        </button>
                      );
                    })}
                  </div>

                  {isImportingViews ? (
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between text-[11px] text-amber-100">
                        <span className="truncate">{importStage || 'Procesando...'}</span>
                        <span className="font-mono-tabular shrink-0 ml-2">
                          {Math.round(importProgress * 100)}%
                        </span>
                      </div>
                      <div className="h-1.5 w-full rounded-full bg-black/40 overflow-hidden">
                        <div
                          className="h-full bg-amber-400 transition-all duration-200"
                          style={{ width: `${Math.round(importProgress * 100)}%` }}
                        />
                      </div>
                      <button
                        type="button"
                        onClick={handleCancelImport}
                        className="w-full px-2.5 py-1.5 rounded-md font-medium bg-[#1f242e] text-zinc-200 hover:text-white border border-white/10 cursor-pointer"
                      >
                        Cancelar reconstrucción
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void handleBuild360FromCatalog(densityTarget)}
                      className="w-full px-2.5 py-1.5 rounded-md font-semibold bg-amber-500 text-zinc-950 hover:bg-amber-400 cursor-pointer"
                    >
                      Reconstruir 3D con carpeta ({Math.min(densityTarget, folderCatalog.length)} vistas)
                    </button>
                  )}
                </section>
              ) : (
                orderedFolderImages.length >= STUDIO_VIEWS.length &&
                selectedDriveImages.length === 0 && (
                  <section className="rounded-lg bg-amber-500/10 border border-amber-500/30 p-3 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-1.5 font-medium text-amber-200">
                        <Sparkles className="w-3.5 h-3.5 shrink-0" />
                        <span>
                          {orderedFolderImages.length} imágenes detectadas en esta carpeta
                        </span>
                      </span>
                    </div>
                    {isImportingViews ? (
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between text-[11px] text-amber-100">
                          <span className="truncate">{importStage || 'Procesando...'}</span>
                          <span className="font-mono-tabular shrink-0 ml-2">
                            {Math.round(importProgress * 100)}%
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={handleCancelImport}
                          className="w-full px-2.5 py-1.5 rounded-md font-medium bg-[#1f242e] text-zinc-200 hover:text-white border border-white/10 cursor-pointer"
                        >
                          Cancelar
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() =>
                          void handleBuildFromDriveImages(
                            orderedFolderImages.slice(0, STUDIO_VIEWS.length),
                          )
                        }
                        className="w-full px-2.5 py-1.5 rounded-md font-semibold bg-amber-500 text-zinc-950 hover:bg-amber-400 cursor-pointer"
                      >
                        Reconstruir con las 8 fotos de la carpeta
                      </button>
                    )}
                  </section>
                )
              )}

              {/* Manual Multi-View Selection Banner */}
              {(selectedDriveImages.length > 0 || customViewsActive) && (
                <section className="rounded-lg bg-amber-500/10 border border-amber-500/30 p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-amber-200">
                      Vistas desde Drive ({selectedDriveImages.length}/8 seleccionadas)
                    </span>
                    {customViewsActive && (
                      <button
                        type="button"
                        onClick={() => void onResetDefaultViews()}
                        className="inline-flex items-center gap-1 text-[11px] text-zinc-200 hover:text-white underline cursor-pointer"
                      >
                        <RotateCcw className="w-3 h-3" />
                        <span>Restaurar base 4K</span>
                      </button>
                    )}
                  </div>
                  {selectedDriveImages.length > 0 && (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={selectedDriveImages.length !== 8 || isImportingViews}
                        onClick={() => void handleBuildFromDriveImages()}
                        className="flex-1 px-2.5 py-1.5 rounded-md font-semibold bg-amber-500 text-zinc-950 hover:bg-amber-400 disabled:opacity-45 cursor-pointer"
                      >
                        {isImportingViews
                          ? 'Descargando y reconstruyendo...'
                          : selectedDriveImages.length === 8
                            ? 'Reconstruir modelo con 8 fotos'
                            : `Selecciona ${8 - selectedDriveImages.length} imágenes más`}
                      </button>
                      <button
                        type="button"
                        onClick={() => setSelectedDriveImages([])}
                        className="px-2 py-1.5 rounded-md bg-[#1f242e] text-zinc-300 hover:text-white cursor-pointer"
                      >
                        Limpiar
                      </button>
                    </div>
                  )}
                </section>
              )}

              {/* File Browser */}
              <section className="space-y-2.5">
                <div className="flex items-center gap-1.5">
                  <div className="relative flex-1">
                    <Search className="w-3.5 h-3.5 text-zinc-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      type="search"
                      value={searchText}
                      onChange={(e) => setSearchText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void fetchFiles();
                      }}
                      placeholder="Buscar en esta carpeta..."
                      aria-label="Buscar archivos en Google Drive"
                      className="w-full pl-8 pr-2.5 py-1.5 rounded-md bg-[#101217] border border-white/10 text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-amber-500"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => void fetchFiles()}
                    disabled={isLoadingFiles}
                    aria-label="Actualizar lista de archivos"
                    className="p-1.5 rounded-md bg-[#1f242e] border border-white/10 text-zinc-300 hover:text-white disabled:opacity-50 cursor-pointer"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isLoadingFiles ? 'animate-spin' : ''}`} />
                  </button>
                </div>

                <div className="flex items-center gap-1 p-0.5 rounded-lg bg-[#101217] border border-white/8">
                  {CATEGORY_TABS.map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setCategory(tab.id)}
                      className={`flex-1 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer ${
                        category === tab.id
                          ? 'bg-zinc-200 text-zinc-950'
                          : 'text-zinc-400 hover:text-white'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                {/* Files List */}
                <div className="space-y-1.5 max-h-56 overflow-y-auto pr-0.5">
                  {isLoadingFiles && files.length === 0 ? (
                    <p className="text-center py-6 text-zinc-400">Cargando archivos...</p>
                  ) : files.length === 0 ? (
                    <p className="text-center py-6 text-zinc-400">
                      No se encontraron archivos en esta ubicación.
                    </p>
                  ) : (
                    files.map((file) => {
                      const isFolder = file.mimeType === DRIVE_FOLDER_MIME_TYPE;
                      if (isFolder) {
                        return (
                          <div
                            key={file.id}
                            className="flex items-center justify-between gap-2 rounded-lg bg-[#101217] border border-white/8 px-2.5 py-2"
                          >
                            <div className="flex items-center gap-2 min-w-0 flex-1">
                              <Folder className="w-4 h-4 text-amber-400 shrink-0" />
                              <span
                                className="font-medium text-zinc-100 truncate"
                                title={file.name}
                              >
                                {file.name}
                              </span>
                            </div>
                            <button
                              type="button"
                              onClick={() => handleOpenSubfolder(file)}
                              className="px-2 py-1 rounded bg-[#1f242e] text-[11px] font-medium text-zinc-200 hover:text-white hover:bg-[#272d39] shrink-0 cursor-pointer"
                            >
                              Abrir
                            </button>
                          </div>
                        );
                      }

                      const isModel =
                        /\.(glb|gltf|obj)$/i.test(file.name) ||
                        file.mimeType === 'model/gltf-binary';
                      const isImage = file.mimeType.startsWith('image/');
                      const selectedIdx = selectedDriveImages.findIndex((s) => s.id === file.id);
                      const isSelected = selectedIdx >= 0;
                      const overwriteFormat: 'glb' | 'obj' | null = /\.obj$/i.test(file.name)
                        ? 'obj'
                        : /\.(glb|gltf)$/i.test(file.name) ||
                            file.mimeType === 'model/gltf-binary'
                          ? 'glb'
                          : null;

                      return (
                        <div
                          key={file.id}
                          className="flex items-center justify-between gap-2 rounded-lg bg-[#101217] border border-white/8 px-2.5 py-2"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="font-medium text-zinc-100 truncate" title={file.name}>
                              {file.name}
                            </div>
                            <div className="text-[11px] text-zinc-400 flex items-center gap-2">
                              <span>{formatFileSize(file.size)}</span>
                              {file.modifiedTime && (
                                <span>
                                  · {new Date(file.modifiedTime).toLocaleDateString('es-ES')}
                                </span>
                              )}
                            </div>
                          </div>

                          <div className="flex items-center gap-1 shrink-0">
                            {isImage && (
                              <button
                                type="button"
                                onClick={() => toggleSelectDriveImage(file)}
                                title={
                                  isSelected
                                    ? `Quitar de selección (${STUDIO_VIEWS[selectedIdx]?.shortLabel})`
                                    : 'Usar como vista de perfil'
                                }
                                aria-label={
                                  isSelected
                                    ? `Quitar imagen ${file.name}`
                                    : `Seleccionar imagen ${file.name}`
                                }
                                className={`inline-flex items-center gap-1 px-1.5 py-1 rounded text-[11px] cursor-pointer ${
                                  isSelected
                                    ? 'bg-amber-500 text-zinc-950 font-semibold'
                                    : 'bg-[#1f242e] text-zinc-300 hover:text-white'
                                }`}
                              >
                                {isSelected ? (
                                  <>
                                    <Check className="w-3 h-3" />
                                    <span>{STUDIO_VIEWS[selectedIdx]?.shortLabel}</span>
                                  </>
                                ) : (
                                  <ImageIcon className="w-3.5 h-3.5" />
                                )}
                              </button>
                            )}

                            {isModel && overwriteFormat && (
                              <button
                                type="button"
                                disabled={!hasMesh}
                                onClick={() =>
                                  setPendingConfirm({
                                    kind: 'overwrite',
                                    file,
                                    format: overwriteFormat,
                                  })
                                }
                                title="Sobrescribir con modelo actual"
                                aria-label={`Sobrescribir ${file.name}`}
                                className="p-1 rounded bg-[#1f242e] text-zinc-300 hover:text-amber-300 disabled:opacity-40 cursor-pointer"
                              >
                                <Replace className="w-3.5 h-3.5" />
                              </button>
                            )}

                            <button
                              type="button"
                              onClick={() => void handleDownload(file)}
                              title="Descargar archivo"
                              aria-label={`Descargar ${file.name}`}
                              className="p-1 rounded bg-[#1f242e] text-zinc-300 hover:text-white cursor-pointer"
                            >
                              <Download className="w-3.5 h-3.5" />
                            </button>

                            <button
                              type="button"
                              onClick={() => setPendingConfirm({ kind: 'delete', file })}
                              title="Eliminar de Google Drive"
                              aria-label={`Eliminar ${file.name}`}
                              className="p-1 rounded bg-[#1f242e] text-zinc-300 hover:text-red-400 cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </section>
            </>
          )}
        </div>
      </aside>

      {/* Explicit Confirmation Dialog for Destructive / Mutating Drive Operations */}
      {pendingConfirm && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="drive-confirm-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4"
        >
          <div className="w-full max-w-sm rounded-xl bg-[#181c24] border border-white/15 shadow-2xl p-5 space-y-4">
            <div className="space-y-1.5">
              <h3 id="drive-confirm-title" className="text-sm font-semibold text-zinc-100">
                {pendingConfirm.kind === 'delete'
                  ? '¿Eliminar archivo de Google Drive?'
                  : '¿Sobrescribir archivo en Google Drive?'}
              </h3>
              <p className="text-xs text-zinc-300 leading-relaxed">
                {pendingConfirm.kind === 'delete' ? (
                  <>
                    Se eliminará permanentemente{' '}
                    <span className="font-semibold text-white">"{pendingConfirm.file.name}"</span>{' '}
                    de tu Google Drive. Esta acción no se puede deshacer.
                  </>
                ) : (
                  <>
                    Se reemplazará el contenido de{' '}
                    <span className="font-semibold text-white">"{pendingConfirm.file.name}"</span>{' '}
                    en tu Google Drive con el modelo 3D actual (.{pendingConfirm.format.toUpperCase()}
                    ).
                  </>
                )}
              </p>
            </div>

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                disabled={isMutating}
                onClick={() => setPendingConfirm(null)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[#222733] text-zinc-200 hover:bg-[#2c3242] disabled:opacity-50 cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={isMutating}
                onClick={() => void handleConfirmPendingAction()}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-50 cursor-pointer ${
                  pendingConfirm.kind === 'delete'
                    ? 'bg-red-500 text-white hover:bg-red-400'
                    : 'bg-amber-500 text-zinc-950 hover:bg-amber-400'
                }`}
              >
                {isMutating
                  ? 'Procesando...'
                  : pendingConfirm.kind === 'delete'
                    ? 'Confirmar eliminación'
                    : 'Confirmar reemplazo'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
