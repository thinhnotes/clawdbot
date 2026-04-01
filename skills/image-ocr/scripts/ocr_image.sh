#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage:
  ocr_image.sh <image-file> [--lang eng|vie+eng] [--out /path/to/out.txt]
EOF
  exit 2
}

if [[ "${1:-}" == "" || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
fi

in="${1:-}"
shift || true

lang="eng"
out=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --lang)
      lang="${2:-}"
      shift 2
      ;;
    --out)
      out="${2:-}"
      shift 2
      ;;
    *)
      echo "Unknown arg: $1" >&2
      usage
      ;;
  esac
done

if [[ ! -f "$in" ]]; then
  echo "File not found: $in" >&2
  exit 1
fi

if ! command -v tesseract >/dev/null 2>&1; then
  echo "Missing tesseract. Install with: sudo apt update && sudo apt install -y tesseract-ocr" >&2
  exit 1
fi

if [[ "$out" == "" ]]; then
  base="${in%.*}"
  out="${base}.ocr.txt"
fi

mkdir -p "$(dirname "$out")"

tesseract "$in" stdout -l "$lang" >"$out"

echo "$out"
