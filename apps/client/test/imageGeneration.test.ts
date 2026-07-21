import { describe, expect, it, vi } from "vitest";
import {
  MAX_REFERENCE_IMAGE_BYTES,
  requestImageGeneration,
} from "../src/imageGeneration";

describe("image generation client", () => {
  it("uses the JSON generations endpoint for a text-only prompt", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({
      data: [{ b64_json: "aW1hZ2U=", revised_prompt: "A polished prompt" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await expect(requestImageGeneration(
      "https://example.test/v1/",
      "secret-key",
      { model: "gpt-image-2", prompt: "  draw a bird  ", size: "1024x1024", quality: "low" },
      request,
    )).resolves.toEqual({
      src: "data:image/png;base64,aW1hZ2U=",
      revisedPrompt: "A polished prompt",
      model: "gpt-image-2",
      size: "1024x1024",
      quality: "low",
      mode: "generation",
    });

    const [url, init] = request.mock.calls[0]!;
    expect(url).toEqual(new URL("https://example.test/v1/images/generations"));
    expect(init.headers).toMatchObject({
      Authorization: "Bearer secret-key",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "gpt-image-2",
      prompt: "draw a bird",
      n: 1,
      response_format: "b64_json",
    });
  });

  it("uses multipart image edits without overriding the boundary header", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({
      data: [{ url: "https://cdn.example.test/result.png" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const reference = new Blob(["png"], { type: "image/png" });

    await expect(requestImageGeneration(
      "https://example.test/v1",
      "secret-key",
      {
        model: "gpt-image-2",
        prompt: "make it red",
        size: "1536x1024",
        quality: "medium",
        referenceImage: { blob: reference, fileName: "reference.png" },
      },
      request,
    )).resolves.toMatchObject({
      src: "https://cdn.example.test/result.png",
      mode: "edit",
    });

    const [url, init] = request.mock.calls[0]!;
    expect(url).toEqual(new URL("https://example.test/v1/images/edits"));
    expect(init.headers).toEqual({ Authorization: "Bearer secret-key", Accept: "application/json" });
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as FormData;
    expect(form.get("prompt")).toBe("make it red");
    expect(form.get("image")).toBeInstanceOf(Blob);
    expect(form.get("size")).toBe("1536x1024");
  });

  it("validates reference images locally and never exposes the API key in errors", async () => {
    const oversized = new Blob([new Uint8Array(MAX_REFERENCE_IMAGE_BYTES + 1)], { type: "image/png" });
    await expect(requestImageGeneration(
      "https://example.test/v1",
      "never-print-this",
      {
        model: "gpt-image-2",
        prompt: "edit",
        size: "1024x1024",
        quality: "low",
        referenceImage: { blob: oversized, fileName: "large.png" },
      },
      vi.fn(),
    )).rejects.toThrow("20 MB");

    const failed = vi.fn(async () => new Response(JSON.stringify({
      error: { message: "invalid image for never-print-this" },
    }), { status: 400, headers: { "Content-Type": "application/json" } }));
    const error = await requestImageGeneration(
      "https://example.test/v1",
      "never-print-this",
      { model: "gpt-image-2", prompt: "draw", size: "1024x1024", quality: "low" },
      failed,
    ).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("invalid image");
    expect((error as Error).message).not.toContain("never-print-this");
  });
});
