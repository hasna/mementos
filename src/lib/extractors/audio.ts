// ============================================================================
// Audio extractor — transcribes audio files via OpenAI Whisper API
// ============================================================================

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { ExtractionResult } from "./types.js";
import { emptyResult } from "./types.js";

/** Supported audio MIME types by extension. */
const AUDIO_MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  mp4: "audio/mp4",
  mpeg: "audio/mpeg",
  mpga: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  webm: "audio/webm",
  ogg: "audio/ogg",
  flac: "audio/flac",
};

function getAudioMime(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return AUDIO_MIME[ext] ?? "audio/mpeg";
}

/**
 * Transcribe an audio file using the OpenAI Whisper API.
 * Requires the OPENAI_API_KEY environment variable.
 * Returns empty result on failure — never throws.
 */
export async function transcribeAudio(filePath: string): Promise<ExtractionResult> {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return emptyResult({
        source: filePath,
        format: "audio",
        error_detail: "OPENAI_API_KEY environment variable is not set",
      });
    }

    const fileBuffer = readFileSync(filePath);
    const fileName = basename(filePath);
    const mime = getAudioMime(filePath);

    // Build multipart/form-data
    const formData = new FormData();
    formData.append("file", new Blob([fileBuffer], { type: mime }), fileName);
    formData.append("model", "whisper-1");
    formData.append("response_format", "verbose_json");

    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      return emptyResult({
        source: filePath,
        format: "audio",
        error_detail: `Whisper API error ${response.status}: ${errorBody}`,
      });
    }

    const data = (await response.json()) as {
      text: string;
      language?: string;
      duration?: number;
      segments?: Array<{
        id: number;
        start: number;
        end: number;
        text: string;
      }>;
    };

    return {
      text: data.text,
      metadata: {
        source: filePath,
        format: "audio",
        transcription_model: "whisper-1",
        language: data.language,
        duration_seconds: data.duration,
        segment_count: data.segments?.length ?? 0,
        segments: data.segments?.map((s) => ({
          id: s.id,
          start: s.start,
          end: s.end,
          text: s.text,
        })),
      },
      confidence: 0.9, // Whisper doesn't provide per-transcription confidence; 0.9 is a reasonable default
    };
  } catch (err) {
    return emptyResult({
      source: filePath,
      format: "audio",
      error_detail: err instanceof Error ? err.message : String(err),
    });
  }
}
