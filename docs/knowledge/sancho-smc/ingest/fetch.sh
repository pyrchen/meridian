#!/usr/bin/env bash
# Re-fetch the channel and rebuild transcripts. Idempotent: yt-dlp skips
# captions it already has, so re-running only picks up new uploads.
#
#   ./fetch.sh <raw-dir> <transcripts-dir>
set -euo pipefail

CHANNEL="https://www.youtube.com/@SanchoDT/videos"
RAW="${1:?usage: fetch.sh <raw-dir> <transcripts-dir>}"
OUT="${2:?usage: fetch.sh <raw-dir> <transcripts-dir>}"
YTDLP="${YTDLP:-yt-dlp}"

mkdir -p "$RAW"

# ru-orig is the original speech track; plain `ru` is a machine round-trip
# translation of it and reads noticeably worse.
"$YTDLP" \
  --write-auto-subs --sub-langs "ru-orig" --sub-format json3 \
  --write-info-json --skip-download \
  --ignore-errors --no-warnings --sleep-requests 1 \
  -o "$RAW/%(id)s.%(ext)s" \
  "$CHANNEL"

python "$(dirname "$0")/build_transcripts.py" "$RAW" "$OUT"
