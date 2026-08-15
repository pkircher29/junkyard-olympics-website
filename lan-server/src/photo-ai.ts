export const MODERATION_CATEGORIES = [
  "nuditySexualContent",
  "graphicViolence",
  "weaponsPointedAtPeople",
  "hateSymbolsHarassmentText",
  "illegalActivity",
  "visiblyEndangeredPerson",
  "minorAgeUncertainty",
  "personallyIdentifyingDocuments",
  "generalUncertainty",
] as const;

export type ModerationCategory = (typeof MODERATION_CATEGORIES)[number];
export type ModerationSignalVerdict = "SAFE" | "UNSAFE" | "UNCERTAIN";
export type ModerationConfidence = "HIGH" | "LOW";
export type ModerationReasonCode =
  | "CONTENT_PRESENT"
  | "POSSIBLE_CONTENT"
  | "AGE_UNCERTAIN"
  | "ID_DOCUMENT_PRESENT"
  | "TEXT_UNCERTAIN"
  | "IMAGE_AMBIGUOUS";

export interface ModerationSignal {
  verdict: ModerationSignalVerdict;
  confidence: ModerationConfidence;
  detected: boolean;
  reasonCodes: ModerationReasonCode[];
}

export type ModerationResult = Record<ModerationCategory, ModerationSignal>;
export type ModerationDecisionReason =
  | "MODEL_UNAVAILABLE"
  | "MODEL_TIMEOUT"
  | "MALFORMED_RESPONSE"
  | "LOW_CONFIDENCE"
  | "UNCERTAIN_SIGNAL"
  | "MINOR_OR_AGE_UNCERTAIN"
  | "CONTRADICTORY_SIGNAL"
  | "UNSAFE_SIGNAL";
export type ModerationDecision =
  | { verdict: "SAFE"; reasonCodes: [] }
  | { verdict: "PENDING_REVIEW"; reasonCodes: ModerationDecisionReason[] };

export interface Plaque {
  title: string;
  caption: string;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface OllamaVisionOptions {
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  maxImageBytes?: number;
  maxResponseChars?: number;
  fetch?: FetchLike;
}

export interface PhotoAiOptions extends OllamaVisionOptions {
  names?: readonly string[];
}

const REASON_CODES = new Set<ModerationReasonCode>([
  "CONTENT_PRESENT",
  "POSSIBLE_CONTENT",
  "AGE_UNCERTAIN",
  "ID_DOCUMENT_PRESENT",
  "TEXT_UNCERTAIN",
  "IMAGE_AMBIGUOUS",
]);
const SIGNAL_KEYS = new Set(["verdict", "confidence", "detected", "reasonCodes"]);
const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_MODEL = "qwen2.5vl:3b";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_CHARS = 16_384;

class PhotoAiError extends Error {
  constructor(readonly code: "MODEL_UNAVAILABLE" | "MODEL_TIMEOUT" | "MALFORMED_RESPONSE", message: string) {
    super(message);
    this.name = "PhotoAiError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

export function parseModerationJson(raw: string): ModerationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PhotoAiError("MALFORMED_RESPONSE", "Moderation output is not valid JSON");
  }
  const categoryKeys = new Set<string>(MODERATION_CATEGORIES);
  if (!isRecord(parsed) || !exactKeys(parsed, categoryKeys)) {
    throw new PhotoAiError("MALFORMED_RESPONSE", "Moderation categories are missing or unknown");
  }

  for (const category of MODERATION_CATEGORIES) {
    const signal = parsed[category];
    if (!isRecord(signal) || !exactKeys(signal, SIGNAL_KEYS)) {
      throw new PhotoAiError("MALFORMED_RESPONSE", `Invalid moderation signal for ${category}`);
    }
    if (signal.verdict !== "SAFE" && signal.verdict !== "UNSAFE" && signal.verdict !== "UNCERTAIN") {
      throw new PhotoAiError("MALFORMED_RESPONSE", `Unknown verdict for ${category}`);
    }
    if (signal.confidence !== "HIGH" && signal.confidence !== "LOW") {
      throw new PhotoAiError("MALFORMED_RESPONSE", `Unknown confidence for ${category}`);
    }
    if (typeof signal.detected !== "boolean") {
      throw new PhotoAiError("MALFORMED_RESPONSE", `Invalid detected flag for ${category}`);
    }
    if (!Array.isArray(signal.reasonCodes) || signal.reasonCodes.some((code) => typeof code !== "string" || !REASON_CODES.has(code as ModerationReasonCode))) {
      throw new PhotoAiError("MALFORMED_RESPONSE", `Unknown reason code for ${category}`);
    }
    if (new Set(signal.reasonCodes).size !== signal.reasonCodes.length) {
      throw new PhotoAiError("MALFORMED_RESPONSE", `Duplicate reason code for ${category}`);
    }
  }
  return parsed as ModerationResult;
}

export function buildModerationPrompt(): string {
  return `You are a conservative local event-photo safety classifier. Do not infer identity, names, age, relationships, protected traits, health, sobriety, or criminal history. Judge only visible evidence. If visibility, age, text, or context is ambiguous, use UNCERTAIN or LOW confidence; never guess. Return one JSON object and nothing else. It must contain exactly these categories: ${MODERATION_CATEGORIES.join(", ")}. Each value must contain exactly {"verdict":"SAFE|UNSAFE|UNCERTAIN","confidence":"HIGH|LOW","detected":boolean,"reasonCodes":[]} using only reason codes CONTENT_PRESENT, POSSIBLE_CONTENT, AGE_UNCERTAIN, ID_DOCUMENT_PRESENT, TEXT_UNCERTAIN, IMAGE_AMBIGUOUS. SAFE means clearly absent, HIGH confidence, detected false, and no reason codes.`;
}

function validateLoopbackUrl(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TypeError("Ollama base URL must be a valid loopback URL");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new TypeError("Ollama base URL must use a loopback host");
  }
  return url;
}

export function createOllamaVisionClient(options: OllamaVisionOptions = {}) {
  const baseUrl = validateLoopbackUrl(options.baseUrl ?? DEFAULT_BASE_URL);
  const model = options.model ?? DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const maxResponseChars = options.maxResponseChars ?? DEFAULT_MAX_RESPONSE_CHARS;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new RangeError("timeoutMs is out of bounds");
  if (!Number.isInteger(maxImageBytes) || maxImageBytes < 1 || maxImageBytes > DEFAULT_MAX_IMAGE_BYTES) throw new RangeError("maxImageBytes is out of bounds");
  if (!Number.isInteger(maxResponseChars) || maxResponseChars < 1 || maxResponseChars > 65_536) throw new RangeError("maxResponseChars is out of bounds");
  if (!model || model.length > 128) throw new TypeError("model is invalid");

  return {
    async request(image: Uint8Array, prompt: string): Promise<string> {
      if (image.byteLength < 1 || image.byteLength > maxImageBytes) throw new RangeError("image exceeds configured image bound");
      if (!prompt || prompt.length > 16_384) throw new RangeError("prompt exceeds configured prompt bound");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        let response: Response;
        try {
          response = await fetchImpl(new URL("/api/generate", baseUrl).toString(), {
            method: "POST",
            headers: { "content-type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
              model,
              prompt,
              images: [Buffer.from(image).toString("base64")],
              format: "json",
              stream: false,
              options: { temperature: 0, num_predict: 1024 },
            }),
          });
        } catch (error) {
          if (controller.signal.aborted) throw new PhotoAiError("MODEL_TIMEOUT", "Local model request timed out");
          throw new PhotoAiError("MODEL_UNAVAILABLE", "Local model request failed");
        }
        if (!response.ok) throw new PhotoAiError("MODEL_UNAVAILABLE", "Local model returned an error status");
        const declaredLength = Number(response.headers.get("content-length"));
        if (Number.isFinite(declaredLength) && declaredLength > maxResponseChars * 2) {
          throw new PhotoAiError("MALFORMED_RESPONSE", "Local model response exceeds configured bound");
        }
        const text = await response.text();
        if (text.length > maxResponseChars * 2) throw new PhotoAiError("MALFORMED_RESPONSE", "Local model response exceeds configured bound");
        let envelope: unknown;
        try {
          envelope = JSON.parse(text);
        } catch {
          throw new PhotoAiError("MALFORMED_RESPONSE", "Local model envelope is malformed");
        }
        if (!isRecord(envelope) || typeof envelope.response !== "string" || envelope.response.length > maxResponseChars) {
          throw new PhotoAiError("MALFORMED_RESPONSE", "Local model response field is missing or oversized");
        }
        return envelope.response;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function decideModeration(result: ModerationResult): ModerationDecision {
  const reasons = new Set<ModerationDecisionReason>();
  for (const category of MODERATION_CATEGORIES) {
    const signal = result[category];
    const contradictory =
      (signal.verdict === "SAFE" && (signal.detected || signal.reasonCodes.length > 0)) ||
      (signal.verdict === "UNSAFE" && !signal.detected);
    if (contradictory) reasons.add("CONTRADICTORY_SIGNAL");
    if (signal.confidence !== "HIGH") reasons.add("LOW_CONFIDENCE");
    if (signal.verdict === "UNCERTAIN") reasons.add("UNCERTAIN_SIGNAL");
    if (signal.verdict === "UNSAFE") reasons.add("UNSAFE_SIGNAL");
    if (category === "minorAgeUncertainty" && (signal.verdict !== "SAFE" || signal.detected || signal.reasonCodes.includes("AGE_UNCERTAIN"))) {
      reasons.add("MINOR_OR_AGE_UNCERTAIN");
    }
    if (signal.verdict !== "SAFE" || signal.confidence !== "HIGH" || signal.detected || signal.reasonCodes.length > 0) {
      if (reasons.size === 0) reasons.add("UNCERTAIN_SIGNAL");
    }
  }
  return reasons.size === 0
    ? { verdict: "SAFE", reasonCodes: [] }
    : { verdict: "PENDING_REVIEW", reasonCodes: [...reasons] };
}

export async function moderatePhoto(image: Uint8Array, options: OllamaVisionOptions = {}): Promise<ModerationDecision> {
  try {
    const raw = await createOllamaVisionClient(options).request(image, buildModerationPrompt());
    return decideModeration(parseModerationJson(raw));
  } catch (error) {
    const code = error instanceof PhotoAiError ? error.code : "MODEL_UNAVAILABLE";
    return { verdict: "PENDING_REVIEW", reasonCodes: [code] };
  }
}

const PLAQUE_KEYS = new Set(["title", "caption"]);
const POLICY_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ["profanity", /\b(?:damn|shit|fuck|bitch|asshole)\b/i],
  ["body", /\b(?:fat|skinny|thin|obese|weight|body|ugly|hot)\b/i],
  ["sexual", /\b(?:sexy|sexual|nude|naked|seductive)\b/i],
  ["humiliation", /\b(?:pathetic|loser|humiliat\w*|embarrass\w*|failure|idiot|stupid)\b/i],
  ["protected trait", /\b(?:race|racial|ethnic\w*|religio\w*|christian|muslim|jewish|gender|transgender|gay|lesbian|disabled|disability|elderly)\b/i],
  ["relationship", /\b(?:husband|wife|boyfriend|girlfriend|spouse|dating|married|couple)\b/i],
  ["sobriety", /\b(?:drunk|sober|intoxicat\w*|wasted|high)\b/i],
  ["medical", /\b(?:diagnos\w*|disease|disorder|syndrome|patient|medication|illness)\b/i],
  ["criminal", /\b(?:criminal|thief|stole|arrest\w*|felon|guilty|crime)\b/i],
];
const SAFE_TITLECASE_WORDS = new Set([
  "A", "An", "The", "Junkyard", "Olympics", "Hall", "Fame", "Glory", "Officially", "Scrap", "Heap", "Victory", "Wins",
]);
export const FALLBACK_PLAQUE: Readonly<Plaque> = Object.freeze({
  title: "Junkyard Glory",
  caption: "Officially legendary, unofficially held together with duct tape.",
});

function normalizedNames(names: readonly string[]): string[] {
  if (names.length > 12) throw new RangeError("Too many supplied names");
  return names.map((name) => {
    const trimmed = name.trim();
    if (!trimmed || Array.from(trimmed).length > 60 || /[\p{Cc}\p{Cf}]/u.test(trimmed)) throw new TypeError("Supplied name is invalid");
    return trimmed;
  });
}

export function buildPlaquePrompt(names: readonly string[] = []): string {
  const allowedNames = normalizedNames(names);
  return `Write a warm, celebratory, absurd, corny Junkyard sports plaque for this photo. Do not infer identity, names, protected traits, age, body traits, sexuality, relationships, sobriety, medical status, or criminal history. Do not humiliate or use profanity. You may use a person's name only if it appears in this exact uploader-supplied JSON allowlist: ${JSON.stringify(allowedNames)}. If the list is empty, use no person's name. Return exactly {"title":"...","caption":"..."} with no other fields. Title maximum 60 characters; caption maximum 180 characters and one short sentence.`;
}

function findDisallowedName(text: string, names: readonly string[]): string | undefined {
  const allowedTokens = new Set(names.flatMap((name) => name.match(/[\p{L}'-]+/gu) ?? []).map((token) => token.toLocaleLowerCase("en-US")));
  for (const token of text.match(/\b[\p{Lu}][\p{L}'-]*\b/gu) ?? []) {
    if (!SAFE_TITLECASE_WORDS.has(token) && !allowedTokens.has(token.toLocaleLowerCase("en-US"))) return token;
  }
  return undefined;
}

export function validatePlaqueJson(raw: string, names: readonly string[] = []): Plaque {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TypeError("Plaque output is not valid JSON");
  }
  if (!isRecord(parsed) || !exactKeys(parsed, PLAQUE_KEYS) || typeof parsed.title !== "string" || typeof parsed.caption !== "string") {
    throw new TypeError("Plaque output must contain exactly title and caption strings");
  }
  const title = parsed.title.trim();
  const caption = parsed.caption.trim();
  if (!title || !caption || Array.from(title).length > 60 || Array.from(caption).length > 180) throw new RangeError("Plaque text is empty or exceeds length limits");
  if (/[\p{Cc}\p{Cf}]/u.test(title + caption)) throw new TypeError("Plaque text contains control characters");
  const text = `${title} ${caption}`;
  for (const [policy, pattern] of POLICY_PATTERNS) {
    if (pattern.test(text)) throw new TypeError(`Plaque violates ${policy} policy`);
  }
  const allowedNames = normalizedNames(names);
  const disallowedName = findDisallowedName(text, allowedNames);
  if (disallowedName) throw new TypeError("Plaque contains a name that was not supplied");
  return { title, caption };
}

export async function generatePlaque(image: Uint8Array, options: PhotoAiOptions = {}): Promise<Plaque> {
  let prompt: string;
  try {
    prompt = buildPlaquePrompt(options.names ?? []);
  } catch {
    return { ...FALLBACK_PLAQUE };
  }
  const client = createOllamaVisionClient(options);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = await client.request(image, prompt);
      return validatePlaqueJson(raw, options.names ?? []);
    } catch {
      // Exactly one bounded retry; invalid or unavailable output never escapes policy validation.
    }
  }
  return { ...FALLBACK_PLAQUE };
}
