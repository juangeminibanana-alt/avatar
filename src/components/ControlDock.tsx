import {
  ChevronDown,
  ChevronUp,
  Download,
  HardDrive,
  Images,
  RotateCw,
  SlidersHorizontal,
} from 'lucide-react';
import { useState } from 'react';
import {
  STUDIO_VIEWS,
  type LightingPreset,
  type ReconstructionSettings,
  type RenderMode,
  type ViewSpec,
} from '../reconstruction/types';

interface ControlDockProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  views?: ViewSpec[];
  activeViewIndex: number;
  onSelectView: (index: number) => void;
  renderMode: RenderMode;
  onChangeRenderMode: (mode: RenderMode) => void;
  lightingPreset: LightingPreset;
  onChangeLighting: (preset: LightingPreset) => void;
  turntable: boolean;
  onToggleTurntable: () => void;
  showReference: boolean;
  onToggleReference: () => void;
  showDrive: boolean;
  onToggleDrive: () => void;
  settings: ReconstructionSettings;
  onChangeSettings: (next: ReconstructionSettings) => void;
  onExportGlb: () => void;
  onExportObj: () => void;
  isExporting: boolean;
  isRebuilding: boolean;
}

const RENDER_MODES: ReadonlyArray<{ id: RenderMode; label: string }> = [
  { id: 'textured', label: 'Texturizado' },
  { id: 'clay', label: 'Arcilla' },
  { id: 'wireframe', label: 'Malla' },
  { id: 'normals', label: 'Normales' },
];

const LIGHTING_PRESETS: ReadonlyArray<{ id: LightingPreset; label: string }> = [
  { id: 'studio', label: 'Estudio' },
  { id: 'dramatic', label: 'Contraste' },
  { id: 'warm', label: 'Cálido' },
];

const CARDINAL_PRESETS: ReadonlyArray<{ deg: number; shortLabel: string; label: string }> = [
  { deg: 0, shortLabel: '0°', label: 'Frontal' },
  { deg: 45, shortLabel: '45°', label: 'Diagonal Der.' },
  { deg: 90, shortLabel: '90°', label: 'Perfil Der.' },
  { deg: 135, shortLabel: '135°', label: 'Post. Der.' },
  { deg: 180, shortLabel: '180°', label: 'Espalda' },
  { deg: 225, shortLabel: '225°', label: 'Post. Izq.' },
  { deg: 270, shortLabel: '270°', label: 'Perfil Izq.' },
  { deg: 315, shortLabel: '315°', label: 'Diagonal Izq.' },
];

function findClosestViewIndex(views: ViewSpec[], targetDeg: number): number {
  let bestIdx = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < views.length; i++) {
    const diff = Math.abs(((views[i].azimuthDeg - targetDeg + 540) % 360) - 180);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }
  return bestIdx;
}

export function ControlDock({
  collapsed,
  onToggleCollapse,
  views = STUDIO_VIEWS,
  activeViewIndex,
  onSelectView,
  renderMode,
  onChangeRenderMode,
  lightingPreset,
  onChangeLighting,
  turntable,
  onToggleTurntable,
  showReference,
  onToggleReference,
  showDrive,
  onToggleDrive,
  settings,
  onChangeSettings,
  onExportGlb,
  onExportObj,
  isExporting,
  isRebuilding,
}: ControlDockProps) {
  const [tuningOpen, setTuningOpen] = useState(false);

  const isDense = views.length > 8;
  const activeAzimuth = views[activeViewIndex]?.azimuthDeg ?? 0;
  const presetButtons = isDense
    ? CARDINAL_PRESETS.map((preset) => {
        const mappedIndex = findClosestViewIndex(views, preset.deg);
        return {
          key: `cardinal_${preset.deg}`,
          index: mappedIndex,
          shortLabel: preset.shortLabel,
          label: preset.label,
          deg: preset.deg,
        };
      })
    : views.map((view, idx) => ({
        key: view.id,
        index: idx,
        shortLabel: view.shortLabel,
        label: view.label,
        deg: view.azimuthDeg,
      }));

  const activePresetKey = isDense
    ? presetButtons.reduce(
        (best, cur) => {
          const diff = Math.abs(((activeAzimuth - cur.deg + 540) % 360) - 180);
          return diff < best.diff ? { key: cur.key, diff } : best;
        },
        { key: presetButtons[0]?.key ?? '', diff: Infinity },
      ).key
    : presetButtons[activeViewIndex]?.key;

  return (
    <div
      className={`fixed bottom-5 left-1/2 -translate-x-1/2 z-20 w-[min(1040px,95vw)] transition-transform duration-300 ease-out ${
        collapsed ? 'translate-y-[calc(100%-36px)]' : 'translate-y-0'
      }`}
    >
      {/* Top Collapse / Expand Handle */}
      <div className="flex justify-center mb-1.5">
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Mostrar controles' : 'Ocultar controles'}
          className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-t-lg bg-[#181c24] border border-b-0 border-white/12 text-xs font-medium text-zinc-200 hover:text-white hover:bg-[#1f242e] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          {collapsed ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          <span>{collapsed ? 'Mostrar controles (H)' : 'Ocultar controles (H)'}</span>
        </button>
      </div>

      {/* Main Dock Surface (Solid dark rgba without backdrop-blur over WebGL) */}
      <div className="rounded-xl bg-[#161920]/96 border border-white/12 shadow-2xl p-3 space-y-2.5">
        {/* Optional Tuning Drawer inside Dock */}
        {tuningOpen && (
          <div className="pb-2.5 mb-1 border-b border-white/10 grid grid-cols-1 sm:grid-cols-4 gap-3 items-center text-xs">
            <div className="flex flex-col gap-1">
              <span className="text-zinc-400">Densidad de malla</span>
              <div className="flex items-center gap-1 p-0.5 bg-[#101217] rounded-lg border border-white/8">
                <button
                  type="button"
                  disabled={isRebuilding}
                  onClick={() => onChangeSettings({ ...settings, resolution: 'standard' })}
                  className={`flex-1 px-2.5 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                    settings.resolution === 'standard'
                      ? 'bg-amber-500 text-zinc-950'
                      : 'text-zinc-300 hover:text-white'
                  }`}
                >
                  Estándar
                </button>
                <button
                  type="button"
                  disabled={isRebuilding}
                  onClick={() => onChangeSettings({ ...settings, resolution: 'high' })}
                  className={`flex-1 px-2.5 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                    settings.resolution === 'high'
                      ? 'bg-amber-500 text-zinc-950'
                      : 'text-zinc-300 hover:text-white'
                  }`}
                >
                  Alta (4K)
                </button>
              </div>
            </div>

            <label className="flex flex-col gap-1.5">
              <div className="flex justify-between text-zinc-400">
                <span>Suavizado Taubin</span>
                <span className="font-mono-tabular text-zinc-200">{settings.smoothingPasses}</span>
              </div>
              <input
                type="range"
                min={0}
                max={6}
                step={1}
                value={settings.smoothingPasses}
                onChange={(e) =>
                  onChangeSettings({ ...settings, smoothingPasses: Number(e.target.value) })
                }
                className="studio-slider w-full"
              />
            </label>

            <label className="flex flex-col gap-1.5">
              <div className="flex justify-between text-zinc-400">
                <span>Fusión multivista</span>
                <span className="font-mono-tabular text-zinc-200">
                  {settings.blendSharpness.toFixed(1)}
                </span>
              </div>
              <input
                type="range"
                min={1.2}
                max={8.0}
                step={0.2}
                value={settings.blendSharpness}
                onChange={(e) =>
                  onChangeSettings({ ...settings, blendSharpness: Number(e.target.value) })
                }
                className="studio-slider w-full"
              />
            </label>

            <div className="flex flex-col gap-1">
              <span className="text-zinc-400">Iluminación</span>
              <div className="flex items-center gap-1 p-0.5 bg-[#101217] rounded-lg border border-white/8">
                {LIGHTING_PRESETS.map((lp) => (
                  <button
                    key={lp.id}
                    type="button"
                    onClick={() => onChangeLighting(lp.id)}
                    className={`flex-1 px-2 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                      lightingPreset === lp.id
                        ? 'bg-zinc-200 text-zinc-950'
                        : 'text-zinc-300 hover:text-white'
                    }`}
                  >
                    {lp.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Row 1: Angle Presets */}
        <div className="flex items-center justify-between gap-1 overflow-x-auto pb-0.5">
          <span className="text-[11px] font-medium text-zinc-400 pr-1 whitespace-nowrap shrink-0">
            Perfiles:
          </span>
          <div className="flex items-center gap-1 flex-1 justify-between">
            {presetButtons.map((btn) => {
              const active = btn.key === activePresetKey;
              return (
                <button
                  key={btn.key}
                  type="button"
                  onClick={() => onSelectView(btn.index)}
                  className={`px-2 py-1 rounded-md text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    active
                      ? 'bg-amber-500 text-zinc-950 font-semibold'
                      : 'bg-[#1f242e] text-zinc-300 hover:text-white hover:bg-[#272d39]'
                  }`}
                >
                  {btn.shortLabel} · {btn.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Row 2: Render Modes, Turntable, Reference & Exports */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-white/8">
          {/* Render Modes */}
          <div className="flex items-center gap-1 p-1 bg-[#101217] rounded-lg border border-white/8">
            {RENDER_MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => onChangeRenderMode(m.id)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  renderMode === m.id
                    ? 'bg-zinc-100 text-zinc-950'
                    : 'text-zinc-400 hover:text-white'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={onToggleTurntable}
              aria-pressed={turntable}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                turntable
                  ? 'bg-amber-500/20 border-amber-500/50 text-amber-300'
                  : 'bg-[#1f242e] border-white/10 text-zinc-200 hover:bg-[#272d39]'
              }`}
            >
              <RotateCw className="w-3.5 h-3.5" />
              <span>{turntable ? 'Pausar giro' : 'Girar 360°'}</span>
            </button>

            <button
              type="button"
              onClick={onToggleReference}
              aria-pressed={showReference}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                showReference
                  ? 'bg-zinc-100 border-white text-zinc-950'
                  : 'bg-[#1f242e] border-white/10 text-zinc-200 hover:bg-[#272d39]'
              }`}
            >
              <Images className="w-3.5 h-3.5" />
              <span>Fotos 4K</span>
            </button>

            <button
              type="button"
              onClick={() => setTuningOpen((v) => !v)}
              aria-expanded={tuningOpen}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                tuningOpen
                  ? 'bg-zinc-700 border-white/25 text-white'
                  : 'bg-[#1f242e] border-white/10 text-zinc-200 hover:bg-[#272d39]'
              }`}
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              <span>Ajustes</span>
            </button>

            <button
              type="button"
              onClick={onToggleDrive}
              aria-pressed={showDrive}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                showDrive
                  ? 'bg-zinc-100 border-white text-zinc-950'
                  : 'bg-[#1f242e] border-white/10 text-zinc-200 hover:bg-[#272d39]'
              }`}
            >
              <HardDrive className="w-3.5 h-3.5" />
              <span>Google Drive</span>
            </button>

            <div className="h-5 w-px bg-white/12 hidden sm:block" />

            <button
              type="button"
              disabled={isExporting}
              onClick={onExportGlb}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-amber-500 text-zinc-950 hover:bg-amber-400 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              <span>{isExporting ? 'Horneando...' : 'Exportar .GLB'}</span>
            </button>

            <button
              type="button"
              disabled={isExporting}
              onClick={onExportObj}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-[#1f242e] border border-white/12 text-zinc-200 hover:bg-[#272d39] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <span>.OBJ</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
