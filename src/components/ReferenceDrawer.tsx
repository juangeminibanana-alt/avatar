import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { STUDIO_VIEWS, type ViewSpec } from '../reconstruction/types';

interface ReferenceDrawerProps {
  open: boolean;
  views?: ViewSpec[];
  activeViewIndex: number;
  onSelectView: (index: number) => void;
  onClose: () => void;
}

export function ReferenceDrawer({
  open,
  views = STUDIO_VIEWS,
  activeViewIndex,
  onSelectView,
  onClose,
}: ReferenceDrawerProps) {
  if (!open) return null;

  const safeIdx = Math.max(0, Math.min(views.length - 1, activeViewIndex));
  const activeView = views[safeIdx] ?? views[0];

  const handlePrev = () => {
    onSelectView((safeIdx - 1 + views.length) % views.length);
  };

  const handleNext = () => {
    onSelectView((safeIdx + 1) % views.length);
  };

  return (
    <aside
      aria-label="Referencia fotográfica 4K"
      className="fixed top-4 right-4 z-20 w-60 sm:w-68 rounded-xl bg-[#161920]/96 border border-white/12 shadow-2xl p-3 space-y-2.5"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-medium text-zinc-200 truncate">
          Referencia 4K · {activeView.label} ({activeView.shortLabel})
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Cerrar panel de referencia"
          className="p-1 rounded-md text-zinc-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="relative aspect-[9/16] max-h-[42vh] w-full mx-auto overflow-hidden rounded-lg bg-[#e2e1e0] border border-white/10">
        {activeView.url ? (
          <img
            src={activeView.url}
            alt={`Perfil original ${activeView.label} a ${activeView.shortLabel}`}
            className="w-full h-full object-contain"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-[#101217] text-[11px] text-zinc-400">
            Sin vista previa
          </div>
        )}
      </div>

      {views.length > 8 && (
        <div className="flex items-center justify-between gap-1.5">
          <button
            type="button"
            onClick={handlePrev}
            aria-label="Vista anterior"
            className="inline-flex items-center gap-1 px-2 py-1 rounded bg-[#1f242e] text-[11px] text-zinc-300 hover:text-white cursor-pointer"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
            <span>Anterior</span>
          </button>
          <span className="text-[11px] font-mono-tabular text-zinc-400">
            {safeIdx + 1} / {views.length}
          </span>
          <button
            type="button"
            onClick={handleNext}
            aria-label="Vista siguiente"
            className="inline-flex items-center gap-1 px-2 py-1 rounded bg-[#1f242e] text-[11px] text-zinc-300 hover:text-white cursor-pointer"
          >
            <span>Siguiente</span>
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      <div
        className={`grid grid-cols-4 gap-1.5 ${
          views.length > 8 ? 'max-h-32 overflow-y-auto pr-0.5' : ''
        }`}
      >
        {views.map((view, idx) => (
          <button
            key={view.id}
            type="button"
            onClick={() => onSelectView(idx)}
            className={`px-1.5 py-1 rounded text-[11px] font-mono-tabular transition-colors cursor-pointer ${
              idx === safeIdx
                ? 'bg-amber-500 text-zinc-950 font-semibold'
                : 'bg-[#1f242e] text-zinc-300 hover:text-white'
            }`}
          >
            {view.shortLabel}
          </button>
        ))}
      </div>
    </aside>
  );
}
