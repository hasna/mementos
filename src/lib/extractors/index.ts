// ============================================================================
// Extractors — barrel export and auto-detect dispatcher
// ============================================================================

import { extname } from "node:path";
import type { ExtractionResult } from "./types.js";
import { emptyResult } from "./types.js";
import { extractPdf } from "./pdf.js";
import { extractImage } from "./ocr.js";
import { transcribeAudio } from "./audio.js";

export type { ExtractionResult } from "./types.js";
export { emptyResult } from "./types.js";
export { extractPdf } from "./pdf.js";
export { extractImage } from "./ocr.js";
export { transcribeAudio } from "./audio.js";

/** File extensions grouped by extractor type. */
const PDF_EXTENSIONS = new Set(["pdf"]);

const IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "bmp", "tiff", "tif", "webp",
]);

const AUDIO_EXTENSIONS = new Set([
  "mp3", "mp4", "mpeg", "mpga", "m4a", "wav", "webm", "ogg", "flac",
]);

/**
 * Auto-detect file type by extension and route to the correct extractor.
 * Returns an empty result for unsupported file types — never throws.
 */
export async function extractFile(filePath: string): Promise<ExtractionResult> {
  const ext = extname(filePath).toLowerCase().replace(".", "");

  if (PDF_EXTENSIONS.has(ext)) {
    return extractPdf(filePath);
  }

  if (IMAGE_EXTENSIONS.has(ext)) {
    return extractImage(filePath);
  }

  if (AUDIO_EXTENSIONS.has(ext)) {
    return transcribeAudio(filePath);
  }

  return emptyResult({
    source: filePath,
    format: ext || "unknown",
    error_detail: `Unsupported file extension: .${ext || "(none)"}`,
  });
}
