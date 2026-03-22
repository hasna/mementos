// Ambient module declarations for dynamically-imported extractor dependencies.
// These are optional peer dependencies — loaded at runtime only when needed.

declare module "pdf-parse" {
  interface PdfData {
    numpages: number;
    numrender: number;
    info: Record<string, unknown>;
    metadata: unknown;
    version: string;
    text: string;
  }
  function pdfParse(buffer: Buffer | Uint8Array): Promise<PdfData>;
  export default pdfParse;
}

declare module "tesseract.js" {
  interface RecognizeResult {
    data: {
      text: string;
      confidence: number;
      lines: unknown[];
      words: unknown[];
    };
  }
  function recognize(image: string | Buffer, lang: string): Promise<RecognizeResult>;
  const Tesseract: { recognize: typeof recognize };
  export default Tesseract;
}
