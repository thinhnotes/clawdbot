# image-ocr setup

## Recommended approach in this workspace

Prefer the existing multimodal model path first.

Why:
- the local codebase includes gateway attachment parsing for `image/*`
- there is a live image probe in `src/gateway/live-image-probe.ts`
- `src/gateway/chat-attachments.ts` converts base64 image attachments into structured image inputs for models

So for this workspace, the recommended order is:

1. model OCR via current provider/gateway
2. optional OCR API fallback if configured later
3. local `tesseract` fallback

## Local fallback install (only if needed)

```bash
sudo apt update && sudo apt install -y tesseract-ocr
```

For Vietnamese OCR too:

```bash
sudo apt install -y tesseract-ocr-vie
```

## Quick local fallback test

```bash
bash skills/image-ocr/scripts/ocr_image.sh /path/to/image.jpg --lang vie+eng
```

## Caveats

### Model OCR
- usually best for screenshots/UI/chat images
- may cost tokens / rely on provider availability
- dense long images may still truncate or summarize unless prompted carefully

### Online OCR APIs
- free tiers are often weak, rate-limited, or privacy-poor
- only add this path if you have a specific provider worth using

### Local OCR
- may confuse `0/O`, `1/l/I`, accented Vietnamese, and stylized fonts
- works better on clean screenshots than messy camera photos
