import tzLookup from '@photostructure/tz-lookup';
import { z } from 'zod';

// A clock reading: `wall` is the wall-clock time encoded as if it were UTC
// milliseconds; `offsetMin` is null when the file did not say which zone it is in.
export type Stamp = { wall: number; offsetMin: number | null };
export type Gps = { lat: number; lng: number };

export type CaptureTags = {
  dateTimeOriginal: Stamp | null;
  keysCreationDate: Stamp | null;
  quickTimeCreateDate: Date | null;
};

export type ExifInfo = {
  mimeType: string | null;
  gps: Gps | null;
  captureTags: CaptureTags;
  contentIdentifier: string | null;
};

export type VideoInfo = {
  width: number;
  height: number;
  durationSec: number | null;
  fps: number | null;
  colorTransfer: string | null;
  hasAudio: boolean;
};

const STAMP = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?/;
const OFFSET = /^([+-])(\d{2}):?(\d{2})$/;

function parseOffset(text: string): number | null {
  if (text === 'Z') return 0;
  const match = OFFSET.exec(text);
  if (!match) return null;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === '-' ? -minutes : minutes;
}

function parseStamp(text: string | undefined, offsetText?: string): Stamp | null {
  const match = text === undefined ? null : STAMP.exec(text);
  if (!match) return null;
  const [y, mo, d, h, mi, s] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(wall);
  if (y < 1900 || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  const offsetSource = match[7] ?? offsetText;
  return { wall, offsetMin: offsetSource === undefined ? null : parseOffset(offsetSource) };
}

const ExiftoolOutput = z.tuple([
  z.looseObject({
    'File:MIMEType': z.string().optional(),
    'ExifIFD:DateTimeOriginal': z.string().optional(),
    'ExifIFD:OffsetTimeOriginal': z.string().optional(),
    'Keys:CreationDate': z.string().optional(),
    'QuickTime:CreateDate': z.string().optional(),
    'Composite:GPSLatitude': z.number().optional(),
    'Composite:GPSLongitude': z.number().optional(),
    // exiftool 12.40 names the HEIC side of the Live Photo pairing ID MediaGroupUUID.
    'Apple:MediaGroupUUID': z.string().optional(),
    'Keys:ContentIdentifier': z.string().optional(),
  }),
]);

export function parseExiftool(json: unknown): ExifInfo {
  const [tags] = ExiftoolOutput.parse(json);
  const lat = tags['Composite:GPSLatitude'];
  const lng = tags['Composite:GPSLongitude'];
  const createDate = parseStamp(tags['QuickTime:CreateDate']);
  return {
    mimeType: tags['File:MIMEType'] ?? null,
    gps: lat === undefined || lng === undefined ? null : { lat, lng },
    captureTags: {
      dateTimeOriginal: parseStamp(tags['ExifIFD:DateTimeOriginal'], tags['ExifIFD:OffsetTimeOriginal']),
      keysCreationDate: parseStamp(tags['Keys:CreationDate']),
      quickTimeCreateDate: createDate && new Date(createDate.wall),
    },
    contentIdentifier: tags['Apple:MediaGroupUUID'] ?? tags['Keys:ContentIdentifier'] ?? null,
  };
}

const FfprobeOutput = z.object({
  streams: z.array(
    z.object({
      codec_type: z.string(),
      width: z.number().optional(),
      height: z.number().optional(),
      avg_frame_rate: z.string().optional(),
      color_transfer: z.string().optional(),
      tags: z.object({ rotate: z.coerce.number().optional() }).optional(),
      side_data_list: z.array(z.object({ rotation: z.number().optional() })).optional(),
    }),
  ),
  format: z.object({ duration: z.coerce.number().optional() }),
});

function ratio(text: string | undefined): number | null {
  const [num, den] = (text ?? '').split('/').map(Number);
  return num && den ? num / den : null;
}

export function parseFfprobe(json: unknown): VideoInfo {
  const { streams, format } = FfprobeOutput.parse(json);
  const stream = streams.find((s) => s.codec_type === 'video' && s.width && s.height);
  if (!stream?.width || !stream.height) throw new Error('檔案裡沒有影像軌');
  const rotation = stream.tags?.rotate ?? stream.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0;
  const sideways = Math.abs(rotation) % 180 === 90;
  return {
    width: sideways ? stream.height : stream.width,
    height: sideways ? stream.width : stream.height,
    durationSec: format.duration ?? null,
    fps: ratio(stream.avg_frame_rate),
    colorTransfer: stream.color_transfer ?? null,
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
  };
}

export function isHdr(colorTransfer: string | null): boolean {
  return colorTransfer === 'smpte2084' || colorTransfer === 'arib-std-b67';
}

function zoneOffsetMin(timeZone: string, instant: number): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(instant)
    .find((part) => part.type === 'timeZoneName')?.value;
  return parseOffset(name?.replace('GMT', '') || 'Z') ?? 0;
}

function wallToInstant(wall: number, timeZone: string): number {
  const guess = wall - zoneOffsetMin(timeZone, wall) * 60_000;
  return wall - zoneOffsetMin(timeZone, guess) * 60_000;
}

// SPEC §6.2 step 2.
export function resolveCaptureTime({
  tags,
  gps,
  fileLastModified,
  defaultTz,
}: {
  tags: CaptureTags;
  gps: Gps | null;
  fileLastModified: Date | null;
  defaultTz: string;
}): { capturedAt: Date; utcOffsetMin: number } | null {
  const zone = gps ? tzLookup(gps.lat, gps.lng) : defaultTz;
  const local = tags.dateTimeOriginal ?? tags.keysCreationDate;
  if (local?.offsetMin != null) {
    return { capturedAt: new Date(local.wall - local.offsetMin * 60_000), utcOffsetMin: local.offsetMin };
  }
  const instant = local ? wallToInstant(local.wall, zone) : (tags.quickTimeCreateDate ?? fileLastModified)?.getTime();
  if (instant === undefined) return null;
  return { capturedAt: new Date(instant), utcOffsetMin: zoneOffsetMin(zone, instant) };
}

export function toOffsetIso(instant: Date, offsetMin: number): string {
  const wall = new Date(instant.getTime() + offsetMin * 60_000).toISOString().slice(0, 19);
  const sign = offsetMin < 0 ? '-' : '+';
  const abs = Math.abs(offsetMin);
  return `${wall}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}
