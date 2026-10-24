#!/usr/bin/env node
// Usage: node scripts/capture-metadata-fixtures.mjs <media files...>
// Writes sanitized exiftool and ffprobe JSON to fixtures/metadata/ for each file.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const outDir = path.join(import.meta.dirname, '..', 'fixtures', 'metadata');
const VIDEO_EXTENSIONS = new Set(['.mov', '.mp4']);

const DROPPED_KEY = /^(System|ExifTool|XMP-mwg-rs):|Serial|Owner|Artist|Copyright|Author|Creator|UserComment|ImageDescription|ImageUniqueID|BurstUUID|^filename$/i;
const LOCATION_KEY = /GPS|ISO6709|location/i;

function roundTo3(value) {
  if (typeof value === 'number') return Math.round(value * 1000) / 1000;
  if (typeof value === 'string') return value.replace(/\d+\.\d{4,}/g, (n) => Number(n).toFixed(3));
  return value;
}

function sanitize(value, key = '') {
  if (Array.isArray(value)) return value.map((item) => sanitize(item, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !DROPPED_KEY.test(k))
        .map(([k, v]) => [k, sanitize(v, k)]),
    );
  }
  return LOCATION_KEY.test(key) ? roundTo3(value) : value;
}

const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

for (const file of process.argv.slice(2)) {
  const name = path.basename(file);
  const [exif] = JSON.parse(run('exiftool', ['-json', '-n', '-G1', file]));
  exif.SourceFile = name;
  writeFileSync(path.join(outDir, `${name}.exiftool.json`), `${JSON.stringify([sanitize(exif)], null, 2)}\n`);

  if (VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase())) {
    const probe = JSON.parse(run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]));
    writeFileSync(path.join(outDir, `${name}.ffprobe.json`), `${JSON.stringify(sanitize(probe), null, 2)}\n`);
  }
  console.log(name);
}
