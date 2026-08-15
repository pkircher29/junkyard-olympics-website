export type VerifiedSession = {
  subject: string;
  displayName: string;
  role: "host" | "guest";
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function createSessionVerifier(
  rawUrl: string,
  { fetch: fetchImpl = globalThis.fetch, timeoutMs = 3000 }: { fetch?: FetchLike; timeoutMs?: number } = {},
) {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") throw new Error("session verifier URL must use HTTPS");
  if (url.username || url.password || url.search || url.hash) throw new Error("session verifier URL must not contain credentials, query, or fragment");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10_000) throw new Error("invalid session verifier timeout");

  return async (token: string): Promise<VerifiedSession | null> => {
    if (typeof token !== "string" || token.length < 8 || token.length > 512) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url.toString(), {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const payload = await response.json().catch(() => null) as any;
      if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).length !== 1 || !payload.user) return null;
      const user = payload.user;
      if (typeof user !== "object" || Array.isArray(user) || Object.keys(user).sort().join(",") !== "id,name,role") return null;
      if (typeof user.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(user.id)) return null;
      if (typeof user.name !== "string" || user.name !== user.name.trim() || user.name.length < 2 || user.name.length > 24 || /[\u0000-\u001f\u007f]/.test(user.name)) return null;
      if (user.role !== "host" && user.role !== "guest") return null;
      return { subject: user.id, displayName: user.name, role: user.role };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}
