// ============================================================================
// PDF extractor — extracts text content from PDF files
// ============================================================================

import { readFileSync } from "node:fs";
import type { ExtractionResult } from "./types.js";
import { emptyResult } from "./types.js";

/**
 * Extract text from a PDF file using pdf-parse.
 * Returns empty result on failure — never throws.
 */
export async function extractPdf(filePath: string): Promise<ExtractionResult> {
  try {
    // Dynamic import so pdf-parse is only loaded when needed
    const pdfParse = (await import("pdf-parse")).default;

    const buffer = readFileSync(filePath);
    const data = await pdfParse(buffer);

    return {
      text: data.text,
      metadata: {
        source: filePath,
        format: "pdf",
        pdf_version: data.version,
        page_count: data.numpages,
        info: data.info,
      },
      pages: data.numpages,
      confidence: 1.0,
    };
  } catch (err) {
    return emptyResult({
      source: filePath,
      format: "pdf",
      error_detail: err instanceof Error ? err.message : String(err),
    });
  }
}
