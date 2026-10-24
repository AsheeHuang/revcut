import type { MediaAnalysis, MediaKind, Moment } from '@revcut/shared';
import { z } from 'zod';

// meta() puts a range into the JSON schema the model sees without validating it:
// resolveVerdicts clamps instead, because a near miss is still a useful answer (SPEC §7.4).
const Score = z.number().int().meta({ minimum: 1, maximum: 10 });
const Unit = z.number().meta({ minimum: 0, maximum: 1 });

export const MediaVerdict = z.object({
  ref: z.string(),
  usable: z.boolean(),
  score: Score,
  description: z.string(),
  moments: z.array(z.object({ t: z.number().meta({ minimum: 0 }), score: Score, focusX: Unit, focusY: Unit })),
  duplicateOf: z.string().nullable(),
});
export const AnalysisResult = z.object({ media: z.array(MediaVerdict) });
export type AnalysisResult = z.infer<typeof AnalysisResult>;

export const SYSTEM_PROMPT = `你是剪輯師，幫使用者把一段期間拍的影片和照片，剪成一支「個人回顧」短片（直式 9:16、20–25 秒的 IG Reels，每段只用 0.5–2 秒）。

使用者會給你一批素材。每個素材有一個代號（m1、m2…），依拍攝時間排序。影片附上幾張依時間順序抽出的畫面，每張前面標了它在原片的秒數；照片只有一張。

評分標準（1–10 的整數，10 最好）：
- 畫面品質：清晰、曝光正常、畫面穩定
- 內容：人物表情、互動、動作、特別的景色或事件
- 這一刻能不能代表這段期間

每個素材都要回傳一筆，欄位如下：
- ref：素材代號，例如 "m1"
- usable：明顯模糊、誤拍、全黑、手指擋到鏡頭時為 false，其他為 true
- score：依上面的標準評分
- description：用繁體中文描述畫面內容，30 字以內
- moments：影片挑 1–3 個最值得用的瞬間，照片挑 1 個。影片夠長時，同一支影片的瞬間要是不同的畫面，彼此相隔至少 3 秒。每個瞬間有：
  - t：瞬間在原片的秒數，在 0 到影片長度之間；照片填 0。成品會以這個時間點為中心取一小段
  - score：這個瞬間的分數，1–10 的整數
  - focusX、focusY：主體在原始畫面中的位置，0–1，左上角是 (0, 0)、右下角是 (1, 1)。直式裁切會以這個點為中心
- duplicateOf：和另一個素材幾乎一樣（同一場景、同一時刻）時，把比較差的那個標記為重複，填比較好那個的代號；否則填 null

不要辨識、也不要命名畫面中的人物，用「一個人」「兩個朋友」這類說法。`;

export type AnalysisItem<F> = {
  ref: string;
  mediaId: string;
  kind: MediaKind;
  durationSec: number | null;
  capturedAt: string | null;
  frames: F[];
};

export type Part<F> = { type: 'text'; text: string } | { type: 'image'; frame: F };

type ItemSource = { id: string; kind: MediaKind; durationSec: number | null; capturedAt: string | null };

const captureKey = (item: ItemSource) => (item.capturedAt === null ? Number.POSITIVE_INFINITY : Date.parse(item.capturedAt));

// SPEC §7.2: short refs in capture order keep the model from mixing media up.
export function buildItems<S extends ItemSource, F>(media: S[], framesOf: (media: S) => F[]): AnalysisItem<F>[] {
  return [...media]
    .sort((a, b) => captureKey(a) - captureKey(b))
    .map((item, i) => ({
      ref: `m${i + 1}`,
      mediaId: item.id,
      kind: item.kind,
      durationSec: item.durationSec,
      capturedAt: item.capturedAt,
      frames: framesOf(item),
    }));
}

// capturedAt carries the capture place's own offset, so its first 16 characters are the local time.
const localTime = (capturedAt: string | null) => (capturedAt === null ? '拍攝時間不明' : capturedAt.slice(0, 16).replace('T', ' '));

function header(item: AnalysisItem<unknown>): string {
  if (item.kind === 'photo') return `素材 ${item.ref}｜照片｜${localTime(item.capturedAt)}`;
  return `素材 ${item.ref}｜影片｜${(item.durationSec ?? 0).toFixed(1)} 秒｜${localTime(item.capturedAt)}`;
}

function task(items: AnalysisItem<unknown>[]): string {
  const dates = items.flatMap((item) => (item.capturedAt ? [item.capturedAt.slice(0, 10)] : [])).sort();
  const period = dates.length > 0 ? `這批素材拍攝於 ${dates[0]} 到 ${dates.at(-1)}，` : '這批';
  return `${period}共 ${items.length} 個素材。請依照指示，為每個素材回傳一筆評估。`;
}

export function buildParts<F extends { t: number }>(items: AnalysisItem<F>[]): Part<F>[] {
  const parts: Part<F>[] = [];
  for (const item of items) {
    parts.push({ type: 'text', text: header(item) });
    for (const frame of item.frames) {
      if (item.kind === 'video') parts.push({ type: 'text', text: `t=${frame.t.toFixed(1)}s` });
      parts.push({ type: 'image', frame });
    }
  }
  parts.push({ type: 'text', text: task(items) });
  return parts;
}

const DEFAULT_SCORE = 5;
const MAX_MOMENTS = { video: 3, photo: 1 } as const satisfies Record<MediaKind, number>;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));
const clampScore = (score: number) => clamp(score, 1, 10);

function middle(item: AnalysisItem<unknown>, score: number): Moment {
  return { t: item.kind === 'video' ? (item.durationSec ?? 0) / 2 : 0, score, focusX: 0.5, focusY: 0.5 };
}

// SPEC §7.4.
export function resolveVerdicts(result: AnalysisResult, items: AnalysisItem<unknown>[]): Map<string, MediaAnalysis> {
  const idOf = new Map(items.map((item) => [item.ref, item.mediaId]));
  const verdicts = new Map<string, AnalysisResult['media'][number]>();
  for (const verdict of result.media) if (idOf.has(verdict.ref) && !verdicts.has(verdict.ref)) verdicts.set(verdict.ref, verdict);

  return new Map(
    items.map((item) => {
      const verdict = verdicts.get(item.ref);
      if (!verdict) {
        const analysis = {
          usable: true,
          score: DEFAULT_SCORE,
          description: 'AI 沒有回傳這個素材的分析',
          moments: [middle(item, DEFAULT_SCORE)],
          duplicateOf: null,
        };
        return [item.mediaId, analysis];
      }
      const score = clampScore(verdict.score);
      const moments = verdict.moments
        .map((moment) => ({
          t: item.kind === 'video' ? clamp(moment.t, 0, item.durationSec ?? 0) : 0,
          score: clampScore(moment.score),
          focusX: clamp(moment.focusX, 0, 1),
          focusY: clamp(moment.focusY, 0, 1),
        }))
        .sort((a, b) => b.score - a.score || a.t - b.t)
        .slice(0, MAX_MOMENTS[item.kind]);
      const duplicateOf = verdict.duplicateOf === null ? undefined : idOf.get(verdict.duplicateOf);
      const analysis: MediaAnalysis = {
        usable: verdict.usable,
        score,
        description: verdict.description.trim(),
        moments: moments.length > 0 ? moments : [middle(item, score)],
        duplicateOf: duplicateOf === undefined || duplicateOf === item.mediaId ? null : duplicateOf,
      };
      return [item.mediaId, analysis];
    }),
  );
}
