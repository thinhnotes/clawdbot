---
name: image-ocr
description: Extract text from screenshots, photos, and image snippets with a model-first OCR workflow. Prefer multimodal model/image input when available; fall back to online OCR APIs or local OCR only when needed.
---

# image-ocr

Use this skill when the user wants text read from an image, screenshot, UI capture, receipt, poster, or cropped text snippet.

## Preferred backend order

1. **Model-first OCR** (preferred)
   - Use the available multimodal model path / gateway image-input support first.
   - Best for screenshots, chat UI, mixed Vietnamese+English UI text, and quick one-off extraction.
2. **Online OCR API** (optional fallback)
   - Use only if configured and the model path is unavailable or weak.
3. **Local OCR (`tesseract`)** (last fallback)
   - Keep as offline/deterministic fallback, not the default.

## Why model-first

The local codebase already shows gateway support for image attachments and multimodal message parsing. There is a live image probe in the repo that sends a PNG to models and asserts the returned text content. That makes model OCR the most practical default here.

## Workflow

1. Try extracting text with the current multimodal model/provider.
2. If output is incomplete or obviously weak, try an OCR API if configured.
3. If no online path is available, use `tesseract` locally.
4. Return:
   - extracted text
   - confidence/quality note
   - whether the result came from model / online / local OCR

## Prompting guidance for model OCR

When using a model, ask for exact extraction first:
- “Extract all visible text exactly as shown.”
- “Preserve line breaks.”
- “Do not summarize.”
- “If a character is unclear, mark it with [?].”

For screenshots with tables/lists:
- ask to preserve bullets, numbers, and line grouping

## Local fallback usage

Basic OCR:
- `bash skills/image-ocr/scripts/ocr_image.sh /path/to/image.jpg`

Vietnamese + English:
- `bash skills/image-ocr/scripts/ocr_image.sh /path/to/image.jpg --lang vie+eng`

## Notes

- Prefer model OCR for screenshots and UI text.
- Prefer local OCR only when offline behavior or deterministic extraction matters.
- If later we add an OCR API key/config, place it between model-first and local fallback.
