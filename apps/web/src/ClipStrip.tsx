import { closestCenter, DndContext, type DragEndEvent, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { horizontalListSortingStrategy, SortableContext, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { type Clip, framesToSec, type Timeline, type Timing } from '@revcut/shared';

type Props = {
  timeline: Timeline;
  timing: Timing | null;
  downbeats: ReadonlySet<number>;
  selectedId: string | null;
  flagged: ReadonlyMap<string, 'error' | 'warning'>;
  onSelect: (clipId: string) => void;
  onReorder: (clipId: string, toIndex: number) => void;
};

// SPEC §11.3: card widths follow the beats, so the ruler underneath lines up with every cut.
export function ClipStrip({ timeline, timing, downbeats, selectedId, flagged, onSelect, onReorder }: Props) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const ids = timeline.clips.map((clip) => clip.id);
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (over && active.id !== over.id) onReorder(String(active.id), ids.indexOf(String(over.id)));
  };
  const totalBeats = timeline.clips.reduce((sum, clip) => sum + clip.beats, 0);
  const { startBeat } = timeline.music;

  return (
    <div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={ids} strategy={horizontalListSortingStrategy}>
          <ol className="flex" data-testid="clip-strip">
            {timeline.clips.map((clip, k) => (
              <ClipCard
                key={clip.id}
                clip={clip}
                index={k}
                sec={timing ? framesToSec(timing.clips[k]!.frames) : null}
                selected={clip.id === selectedId}
                flag={flagged.get(clip.id)}
                onSelect={onSelect}
              />
            ))}
          </ol>
        </SortableContext>
      </DndContext>
      <div className="flex h-4 items-start" aria-hidden="true" data-testid="beat-ruler">
        {Array.from({ length: totalBeats }, (_, i) => (
          <div
            key={i}
            className={`flex-1 border-l ${downbeats.has(startBeat + i) ? 'h-4 border-slate-700' : 'h-2 border-slate-300'}`}
          />
        ))}
      </div>
    </div>
  );
}

const FLAG_STYLES = { error: 'bg-red-600', warning: 'bg-amber-500' } as const;

function ClipCard({
  clip,
  index,
  sec,
  selected,
  flag,
  onSelect,
}: {
  clip: Clip;
  index: number;
  sec: number | null;
  selected: boolean;
  flag: 'error' | 'warning' | undefined;
  onSelect: (clipId: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: clip.id });
  return (
    <li
      ref={setNodeRef}
      style={{ flex: `${clip.beats} 1 0`, transform: CSS.Translate.toString(transform), transition, zIndex: isDragging ? 10 : undefined }}
      className="min-w-0"
      data-testid="clip-card"
      data-clip-id={clip.id}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        onClick={() => onSelect(clip.id)}
        aria-pressed={selected}
        aria-label={`第 ${index + 1} 段`}
        className={`relative block w-full cursor-grab overflow-hidden rounded border-2 bg-white text-left active:cursor-grabbing ${
          selected ? 'border-slate-900' : 'border-white'
        } ${isDragging ? 'opacity-80 shadow-lg' : ''}`}
      >
        <img src={`/api/media/${clip.mediaId}/thumb`} alt="" draggable={false} className="h-20 w-full object-cover" />
        {flag && <span className={`absolute top-1 right-1 h-2.5 w-2.5 rounded-full ${FLAG_STYLES[flag]}`} />}
        <span className="block truncate px-1 py-0.5 text-xs text-slate-600 tabular-nums">
          {clip.beats} 拍{sec !== null ? `・${sec.toFixed(2)} 秒` : ''}
        </span>
      </button>
    </li>
  );
}
