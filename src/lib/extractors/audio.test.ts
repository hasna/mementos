// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { transcribeAudio } from "./audio.js";

// ============================================================================
// Tests for audio extractor
// ============================================================================

describe("transcribeAudio", () => {
  const tmpFile = join(tmpdir(), "test-audio.mp3");

  let originalFetch: typeof globalThis.fetch;
  let originalApiKey: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalApiKey = process.env["OPENAI_API_KEY"];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalApiKey !== undefined) {
      process.env["OPENAI_API_KEY"] = originalApiKey;
    } else {
      delete process.env["OPENAI_API_KEY"];
    }
    if (existsSync(tmpFile)) {
      unlinkSync(tmpFile);
    }
  });

  test("returns empty result when OPENAI_API_KEY is not set", async () => {
    delete process.env["OPENAI_API_KEY"];
    const result = await transcribeAudio("/tmp/test.mp3");

    expect(result.text).toBe("");
    expect(result.confidence).toBe(0);
    const meta = result.metadata as Record<string, string>;
    expect(meta["error_detail"]).toContain("OPENAI_API_KEY");
  });

  test("returns empty result when file does not exist", async () => {
    process.env["OPENAI_API_KEY"] = "sk-test-fake";
    const result = await transcribeAudio("/nonexistent/path/audio.mp3");

    expect(result.text).toBe("");
    expect(result.confidence).toBe(0);
    const meta = result.metadata as Record<string, string>;
    expect(meta["error_detail"]).toBeTruthy();
  });

  test("returns empty result when API returns non-OK status", async () => {
    process.env["OPENAI_API_KEY"] = "sk-test-fake";
    writeFileSync(tmpFile, "fake audio data");

    globalThis.fetch = mock(async () =>
      new Response("Unauthorized", { status: 401 })
    ) as unknown as typeof fetch;

    const result = await transcribeAudio(tmpFile);

    expect(result.text).toBe("");
    expect(result.confidence).toBe(0);
    const meta = result.metadata as Record<string, string>;
    expect(meta["error_detail"]).toContain("Whisper API error 401");
  });

  test("returns transcription on successful API call", async () => {
    process.env["OPENAI_API_KEY"] = "sk-test-fake";
    writeFileSync(tmpFile, "fake audio data");

    const mockResponse = {
      text: "Hello world from whisper",
      language: "en",
      duration: 5.2,
      segments: [
        { id: 0, start: 0, end: 2.5, text: "Hello world" },
        { id: 1, start: 2.5, end: 5.2, text: " from whisper" },
      ],
    };

    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    ) as unknown as typeof fetch;

    const result = await transcribeAudio(tmpFile);

    expect(result.text).toBe("Hello world from whisper");
    expect(result.confidence).toBe(0.9);
    const meta = result.metadata as Record<string, unknown>;
    expect(meta["transcription_model"]).toBe("whisper-1");
    expect(meta["language"]).toBe("en");
    expect(meta["duration_seconds"]).toBe(5.2);
    expect(meta["segment_count"]).toBe(2);
  });

  test("handles response without segments gracefully", async () => {
    process.env["OPENAI_API_KEY"] = "sk-test-fake";
    writeFileSync(tmpFile, "fake audio data");

    const mockResponse = {
      text: "Simple transcription",
      language: "en",
      duration: 3.0,
      // No segments field
    };

    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify(mockResponse), { status: 200 })
    ) as unknown as typeof fetch;

    const result = await transcribeAudio(tmpFile);

    expect(result.text).toBe("Simple transcription");
    const meta = result.metadata as Record<string, unknown>;
    expect(meta["segment_count"]).toBe(0);
  });

  test("returns correct MIME type for .wav files", async () => {
    process.env["OPENAI_API_KEY"] = "sk-test-fake";
    const wavFile = join(tmpdir(), "test-audio.wav");
    writeFileSync(wavFile, "fake wav data");

    let capturedBody: FormData | null = null;

    globalThis.fetch = mock(async (_url: unknown, init?: RequestInit) => {
      capturedBody = init?.body as FormData;
      return new Response(JSON.stringify({ text: "wav audio", language: "en", duration: 1.0 }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await transcribeAudio(wavFile);
    expect(result.text).toBe("wav audio");

    if (existsSync(wavFile)) unlinkSync(wavFile);
  });

  test("sends correct Authorization header", async () => {
    process.env["OPENAI_API_KEY"] = "sk-test-my-key";
    writeFileSync(tmpFile, "fake audio data");

    let capturedHeaders: HeadersInit | undefined;

    globalThis.fetch = mock(async (_url: unknown, init?: RequestInit) => {
      capturedHeaders = init?.headers;
      return new Response(JSON.stringify({ text: "test", language: "en", duration: 1.0 }), { status: 200 });
    }) as unknown as typeof fetch;

    await transcribeAudio(tmpFile);

    expect(capturedHeaders).toBeTruthy();
    const headers = capturedHeaders as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-test-my-key");
  });

  test("includes source and format in metadata", async () => {
    process.env["OPENAI_API_KEY"] = "sk-test-fake";
    writeFileSync(tmpFile, "fake audio data");

    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ text: "audio content", language: "en", duration: 2.0, segments: [] }), { status: 200 })
    ) as unknown as typeof fetch;

    const result = await transcribeAudio(tmpFile);

    const meta = result.metadata as Record<string, unknown>;
    expect(meta["source"]).toBe(tmpFile);
    expect(meta["format"]).toBe("audio");
  });

  test("error result includes source and format in metadata", async () => {
    delete process.env["OPENAI_API_KEY"];

    const result = await transcribeAudio("/some/audio.mp3");
    const meta = result.metadata as Record<string, string>;
    expect(meta["source"]).toBe("/some/audio.mp3");
    expect(meta["format"]).toBe("audio");
  });
});
