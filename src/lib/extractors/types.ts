// ============================================================================
// Extractor types — shared interfaces for multi-modal extraction
// ============================================================================

export interface ExtractionResult {
  text: string;
  metadata: Record<string, unknown>;
  pages?: number;
  confidence?: number;
}

/**
 * Returns an empty extraction result — used as a safe fallback when
 * extraction fails or the file type is unsupported.
 */
export function emptyResult(metadata?: Record<string, unknown>): ExtractionResult {
  return {
    text: "",
    metadata: { ...metadata, error: "extraction_failed" },
    confidence: 0,
  };
}
