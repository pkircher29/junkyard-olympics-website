import { describe, expect, it, vi } from "vitest";
import {
  MODERATION_CATEGORIES,
  buildModerationPrompt,
  buildPlaquePrompt,
  createOllamaVisionClient,
  generatePlaque,
  moderatePhoto,
  parseModerationJson,
  validatePlaqueJson,
  type FetchLike,
  type ModerationCategory,
} from "../src/photo-ai.js";

const image = new Uint8Array([1, 2, 3, 4]);
const safeSignal = { verdict: "SAFE", confidence: "HIGH", detected: false, reasonCodes: [] } as const;

function moderation(overrides: Partial<Record<ModerationCategory, unknown>> = {}) {
  return Object.fromEntries(MODERATION_CATEGORIES.map((category) => [category, overrides[category] ?? safeSignal]));
}

function ollamaResponse(response: unknown, status = 200): Response {
  return new Response(JSON.stringify({ response: typeof response === "string" ? response : JSON.stringify(response) }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeFetch(response: unknown): FetchLike {
  return vi.fn(async () => ollamaResponse(response));
}

describe("moderation schema and fail-closed decision", () => {
  it("accepts a complete, explicit, high-confidence safe result", () => {
    expect(parseModerationJson(JSON.stringify(moderation()))).toEqual(moderation());
  });

  it.each([
    ["malformed JSON", "{"],
    ["missing category", JSON.stringify(Object.fromEntries(Object.entries(moderation()).slice(1)))],
    ["unknown category", JSON.stringify({ ...moderation(), surprise: safeSignal })],
    ["unknown verdict", JSON.stringify(moderation({ nuditySexualContent: { ...safeSignal, verdict: "MAYBE" } }))],
    ["unknown reason code", JSON.stringify(moderation({ nuditySexualContent: { ...safeSignal, reasonCodes: ["OTHER"] } }))],
    ["extra signal field", JSON.stringify(moderation({ nuditySexualContent: { ...safeSignal, note: "ok" } }))],
  ])("rejects %s", (_label, raw) => {
    expect(() => parseModerationJson(raw)).toThrow();
  });

  it.each([
    ["uncertain", { ...safeSignal, verdict: "UNCERTAIN", confidence: "HIGH" }],
    ["minor", { verdict: "UNSAFE", confidence: "HIGH", detected: true, reasonCodes: ["AGE_UNCERTAIN"] }],
    ["low confidence", { ...safeSignal, confidence: "LOW" }],
    ["contradictory", { ...safeSignal, detected: true }],
    ["unsafe", { verdict: "UNSAFE", confidence: "HIGH", detected: true, reasonCodes: ["CONTENT_PRESENT"] }],
  ])("keeps a %s signal pending", async (_label, signal) => {
    const fetch = fakeFetch(moderation({ minorAgeUncertainty: signal }));
    await expect(moderatePhoto(image, { fetch })).resolves.toMatchObject({ verdict: "PENDING_REVIEW" });
  });

  it("returns safe only when every category is explicitly safe", async () => {
    await expect(moderatePhoto(image, { fetch: fakeFetch(moderation()) })).resolves.toEqual({ verdict: "SAFE", reasonCodes: [] });
  });

  it.each([
    ["unavailable", vi.fn(async () => { throw new Error("offline"); })],
    ["HTTP failure", vi.fn(async () => ollamaResponse("failure", 503))],
    ["malformed envelope", vi.fn(async () => new Response("not-json"))],
    ["malformed model JSON", fakeFetch("{")],
  ])("keeps model %s pending", async (_label, fetch) => {
    await expect(moderatePhoto(image, { fetch: fetch as FetchLike })).resolves.toMatchObject({ verdict: "PENDING_REVIEW" });
  });

  it("aborts a timed-out request and keeps it pending", async () => {
    const fetch: FetchLike = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    await expect(moderatePhoto(image, { fetch, timeoutMs: 5 })).resolves.toMatchObject({ verdict: "PENDING_REVIEW" });
  });
});

describe("bounded local Ollama vision client", () => {
  it("uses qwen2.5vl:3b, base64, JSON mode, and no unbounded stream", async () => {
    const fetch = fakeFetch(moderation());
    const client = createOllamaVisionClient({ fetch });
    await client.request(image, "private prompt");
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse(String(init?.body));
    expect(url).toBe("http://127.0.0.1:11434/api/generate");
    expect(body).toMatchObject({ model: "qwen2.5vl:3b", images: ["AQIDBA=="], format: "json", stream: false });
    expect(body.options.num_predict).toBeGreaterThan(0);
  });

  it("rejects oversized images, oversized model output, and non-loopback URLs", async () => {
    const client = createOllamaVisionClient({ fetch: fakeFetch({}), maxImageBytes: 3 });
    await expect(client.request(image, "prompt")).rejects.toThrow(/image/i);
    expect(() => createOllamaVisionClient({ baseUrl: "https://example.com" })).toThrow(/loopback/i);
    const huge = "x".repeat(100);
    const bounded = createOllamaVisionClient({ fetch: fakeFetch(huge), maxResponseChars: 20 });
    await expect(bounded.request(image, "prompt")).rejects.toThrow(/response/i);
  });
});

describe("identity-safe prompts", () => {
  it("forbids identity and protected-trait inference", () => {
    for (const prompt of [buildModerationPrompt(), buildPlaquePrompt([])]) {
      expect(prompt).toMatch(/do not infer/i);
      expect(prompt).toMatch(/identity|name/i);
      expect(prompt).toMatch(/protected trait/i);
    }
  });

  it("includes only explicitly supplied names in the plaque prompt", () => {
    expect(buildPlaquePrompt([])).not.toMatch(/Chris|Paul/);
    expect(buildPlaquePrompt(["Chris"])).toContain(JSON.stringify(["Chris"]));
  });
});

describe("plaque validation and generation", () => {
  it("accepts exact, bounded, corny JSON", () => {
    expect(validatePlaqueJson(JSON.stringify({ title: "Junkyard Glory", caption: "A glorious lap around the scrap heap." }), [])).toEqual({
      title: "Junkyard Glory",
      caption: "A glorious lap around the scrap heap.",
    });
  });

  it.each([
    ["malformed JSON", "{"],
    ["extra field", JSON.stringify({ title: "Junkyard Glory", caption: "A glorious lap.", extra: true })],
    ["long title", JSON.stringify({ title: "x".repeat(61), caption: "A glorious lap." })],
    ["long caption", JSON.stringify({ title: "Junkyard Glory", caption: "x".repeat(181) })],
    ["profanity", JSON.stringify({ title: "Junkyard Glory", caption: "A damn fine lap." })],
    ["body claim", JSON.stringify({ title: "Junkyard Glory", caption: "A skinny champion rules the heap." })],
    ["sexual claim", JSON.stringify({ title: "Junkyard Glory", caption: "A sexy victory lap." })],
    ["humiliation", JSON.stringify({ title: "Junkyard Glory", caption: "The pathetic loser returns." })],
    ["protected trait", JSON.stringify({ title: "Junkyard Glory", caption: "A religious hero wins." })],
    ["relationship", JSON.stringify({ title: "Junkyard Glory", caption: "The husband claims victory." })],
    ["sobriety", JSON.stringify({ title: "Junkyard Glory", caption: "A drunk champion arrives." })],
    ["medical", JSON.stringify({ title: "Junkyard Glory", caption: "A diagnosed hero wins." })],
    ["criminal", JSON.stringify({ title: "Junkyard Glory", caption: "The thief takes the trophy." })],
    ["inferred name", JSON.stringify({ title: "Chris Wins", caption: "A glorious lap around the heap." })],
  ])("rejects %s", (_label, raw) => {
    expect(() => validatePlaqueJson(raw, [])).toThrow();
  });

  it("allows only names supplied by the uploader", () => {
    const raw = JSON.stringify({ title: "Chris Wins", caption: "Chris takes a glorious lap around the heap." });
    expect(validatePlaqueJson(raw, ["Chris"]).title).toBe("Chris Wins");
    expect(() => validatePlaqueJson(raw, ["Paul"])).toThrow(/name/i);
  });

  it("retries once, then returns the deterministic fallback", async () => {
    const fetch = vi.fn(async () => ollamaResponse("{"));
    const first = await generatePlaque(image, { fetch, names: [] });
    const second = await generatePlaque(image, { fetch: fakeFetch("{"), names: [] });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(first).toEqual(second);
    expect(first).toEqual({ title: "Junkyard Glory", caption: "Officially legendary, unofficially held together with duct tape." });
  });

  it("does not use a name when none was supplied", async () => {
    const fetch = fakeFetch({ title: "Chris Wins", caption: "Chris takes a glorious lap." });
    const plaque = await generatePlaque(image, { fetch, names: [] });
    expect(plaque.title).not.toContain("Chris");
    expect(plaque.caption).not.toContain("Chris");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("returns a valid first response without retry", async () => {
    const fetch = fakeFetch({ title: "Junkyard Glory", caption: "A glorious lap around the scrap heap." });
    await expect(generatePlaque(image, { fetch, names: [] })).resolves.toMatchObject({ title: "Junkyard Glory" });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
