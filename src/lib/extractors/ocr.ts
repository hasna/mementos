// ============================================================================
// OCR extractor — extracts text from images using Tesseract.js
// ============================================================================

import type { ExtractionResult } from "./types.js";
import { emptyResult } from "./types.js";

/**
 * Extract text from an image file using Tesseract.js OCR.
 * Returns empty result on failure — never throws.
 */
export async function extractImage(filePath: string): Promise<ExtractionResult> {
  try {
    // Dynamic import so tesseract.js is only loaded when needed
    const Tesseract = (await import("tesseract.js")).default;

    const result = await Tesseract.recognize(filePath, "eng");

    const text = result.data.text.trim();
    const confidence = result.data.confidence / 100; // Tesseract returns 0-100, normalize to 0-1

    return {
      text,
      metadata: {
        source: filePath,
        format: "image",
        ocr_engine: "tesseract.js",
        raw_confidence: result.data.confidence,
      },
      confidence,
    };
  } catch (err) {
    return emptyResult({
      source: filePath,
      format: "image",
      error_detail: err instanceof Error ? err.message : String(err),
    });
  }
}
