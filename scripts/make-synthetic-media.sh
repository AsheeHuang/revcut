#!/usr/bin/env bash
# Generates synthetic media for development under fixtures/private/synthetic/ (gitignored).
set -euo pipefail

out="$(cd "$(dirname "$0")/.." && pwd)/fixtures/private/synthetic"
mkdir -p "$out"
work="$(mktemp -d)"
trap 'rm -r -- "$work"' EXIT

ff() { ffmpeg -y -v error "$@"; }

# SDR portrait MP4 with only a UTC QuickTime:CreateDate, like most non-iPhone cameras.
ff -f lavfi -i testsrc2=size=1080x1920:rate=30 -f lavfi -i sine=frequency=440 -t 4 \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -metadata creation_time=2026-10-03T06:22:10Z \
  "$out/sdr-portrait.mp4"

# HDR (HLG) HEVC 10-bit 4K MOV with iPhone-style Keys metadata (creation date with offset,
# ISO 6709 location). Rotated iPhone video is covered by the real samples.
ff -f lavfi -i testsrc2=size=3840x2160:rate=30 -f lavfi -i sine=frequency=660 -t 10 \
  -c:v libx265 -preset ultrafast -x265-params log-level=error -pix_fmt yuv420p10le -tag:v hvc1 \
  -color_primaries bt2020 -color_trc arib-std-b67 -colorspace bt2020nc \
  -c:a aac \
  -movflags use_metadata_tags \
  -metadata com.apple.quicktime.creationdate=2026-10-04T09:15:00+0900 \
  -metadata "com.apple.quicktime.location.ISO6709=+35.6595+139.7005+010.000/" \
  "$out/hdr-hevc.mov"

ff -f lavfi -i testsrc2=size=1600x1200 -frames:v 1 "$work/landscape.jpg"

# JPEG with an explicit offset, Tokyo GPS, and EXIF Orientation 6 (display is portrait).
cp "$work/landscape.jpg" "$out/jpeg-offset.jpg"
exiftool -q -overwrite_original \
  "-DateTimeOriginal=2026:10:05 08:00:00" "-OffsetTimeOriginal=+09:00" \
  -GPSLatitude=35.6595 -GPSLatitudeRef=N -GPSLongitude=139.7005 -GPSLongitudeRef=E \
  -Orientation#=6 "$out/jpeg-offset.jpg"

# JPEG with a naive local time and San Francisco GPS: the time is Pacific time.
cp "$work/landscape.jpg" "$out/jpeg-naive.jpg"
exiftool -q -overwrite_original \
  "-DateTimeOriginal=2026:10:06 18:30:00" \
  -GPSLatitude=37.7793 -GPSLatitudeRef=N -GPSLongitude=122.4193 -GPSLongitudeRef=W \
  "$out/jpeg-naive.jpg"

# Standalone HEIC with a naive time and Taipei GPS.
heif-enc -q 80 -o "$out/photo.heic" "$work/landscape.jpg" >/dev/null
exiftool -q -overwrite_original \
  "-DateTimeOriginal=2026:10:07 12:00:00" "-OffsetTimeOriginal=+08:00" \
  -GPSLatitude=25.026 -GPSLatitudeRef=N -GPSLongitude=121.543 -GPSLongitudeRef=E \
  "$out/photo.heic"

# Live Photo pair. exiftool 12.40 cannot write the Apple maker note tag that holds the
# pairing ID (Apple:MediaGroupUUID, tag 0x0011), so build a minimal Apple maker note by hand.
live_id=7E1B2C3D-0000-4000-8000-5E1F5E1F5E1F
python3 - "$work/makernote.bin" "$live_id" <<'PY'
import struct, sys
value = sys.argv[2].encode() + b"\0"
header = b"Apple iOS\0" + b"\0\x01" + b"MM"
entry = struct.pack(">HHII", 0x0011, 2, len(value), len(header) + 2 + 12 + 4)
open(sys.argv[1], "wb").write(header + struct.pack(">H", 1) + entry + struct.pack(">I", 0) + value)
PY
heif-enc -q 80 -o "$out/live.heic" "$work/landscape.jpg" >/dev/null
exiftool -q -overwrite_original \
  "-DateTimeOriginal=2026:10:08 20:00:00" "-OffsetTimeOriginal=+08:00" \
  -GPSLatitude=25.026 -GPSLatitudeRef=N -GPSLongitude=121.543 -GPSLongitudeRef=E \
  "-MakerNotes<=$work/makernote.bin" "$out/live.heic"
ff -f lavfi -i testsrc2=size=1920x1080:rate=30 -f lavfi -i sine=frequency=880 -t 2 \
  -c:v libx264 -pix_fmt yuv420p -c:a pcm_s16le \
  -movflags use_metadata_tags \
  -metadata com.apple.quicktime.content.identifier=$live_id \
  -metadata com.apple.quicktime.creationdate=2026-10-08T20:00:00+0800 \
  "$out/live.mov"

ls -l "$out"
