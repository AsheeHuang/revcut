import { HEIGHT, WIDTH } from '@revcut/shared';

const SHADE = 'rgba(0, 0, 0, 0.45)';
const LABEL = { fill: 'white', fontSize: 30, fontFamily: 'system-ui, sans-serif' } as const;

// SPEC §9.2: an editor-only sketch of where Instagram's Reels UI sits over a 1080x1920 frame.
// Never part of RecapVideo, so it cannot end up in an export.
export function IgSafeZoneMask() {
  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
      aria-hidden="true"
    >
      <rect x={0} y={0} width={WIDTH} height={200} fill={SHADE} />
      <text x={48} y={128} {...LABEL} fontSize={48} fontWeight={700}>
        Reels
      </text>
      <rect x={936} y={1010} width={144} height={700} fill={SHADE} />
      {[1080, 1220, 1360, 1490, 1620].map((cy) => (
        <circle key={cy} cx={1008} cy={cy} r={36} fill="none" stroke="white" strokeWidth={5} />
      ))}
      <rect x={0} y={1500} width={900} height={290} fill={SHADE} />
      <circle cx={84} cy={1556} r={36} fill="white" fillOpacity={0.8} />
      <text x={136} y={1567} {...LABEL} fontWeight={700}>
        帳號名稱・追蹤
      </text>
      <text x={48} y={1650} {...LABEL}>
        文案第一行……
      </text>
      <text x={48} y={1735} {...LABEL}>
        ♫ 音樂名稱
      </text>
      <rect x={0} y={1790} width={WIDTH} height={130} fill={SHADE} />
      <text x={WIDTH / 2} y={1868} {...LABEL} textAnchor="middle">
        IG 導覽列
      </text>
    </svg>
  );
}
