// In the desktop host the AI provider router runs in C#, not in a dev server. This shim answers the same /api/ai/* calls
// that ai.ts already makes, so the AI client and panel stay unchanged:
//   GET /api/ai/status, GET /api/ai/models?provider=…, POST /api/ai/stream (server-sent events)
// Streaming goes over the bridge as events; cancelling the fetch cancels the request in the host.
import { callHost, HostError, isHosted, onHostEvent } from "./bridge";

type AiEventPayload = { requestId: string; data: Record<string, unknown> };

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

export function installAiTransport(): void {
  if (!isHosted()) return;
  const original = window.fetch.bind(window);
  const listeners = new Map<string, (data: Record<string, unknown>) => void>();
  onHostEvent("aiEvent", (payload) => {
    const p = payload as AiEventPayload | null;
    if (p?.requestId) listeners.get(p.requestId)?.(p.data);
  });

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, window.location.href);
    if (url.origin !== window.location.origin || !url.pathname.startsWith("/api/ai/")) return original(input, init);

    try {
      if (url.pathname === "/api/ai/status") return jsonResponse(200, await callHost("aiStatus"));
      if (url.pathname === "/api/ai/models") return jsonResponse(200, await callHost("aiModels", { provider: url.searchParams.get("provider") ?? "" }));
      if (url.pathname === "/api/ai/stream" && (init?.method ?? "GET").toUpperCase() === "POST") return await stream(init);
      return jsonResponse(404, { error: "AI-маршрут не найден" });
    } catch (error) {
      if (error instanceof HostError) return jsonResponse(error.status ?? 502, { error: error.message });
      throw error;
    }
  };

  async function stream(init: RequestInit | undefined): Promise<Response> {
    const signal = init?.signal ?? undefined;
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const body: unknown = JSON.parse(String(init?.body ?? "{}"));
    const requestId = crypto.randomUUID().replace(/-/g, "");
    const encoder = new TextEncoder();
    let controllerRef!: ReadableStreamDefaultController<Uint8Array>;
    let finished = false;
    const finish = () => { if (finished) return; finished = true; listeners.delete(requestId); };
    const readable = new ReadableStream<Uint8Array>({
      start(controller) { controllerRef = controller; },
      cancel() { finish(); void callHost("aiCancel", { requestId }).catch(() => undefined); },
    });
    listeners.set(requestId, (data) => {
      if (finished) return;
      controllerRef.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      if (data.done === true || typeof data.error === "string") { finish(); controllerRef.close(); }
    });
    signal?.addEventListener("abort", () => {
      if (finished) return;
      finish();
      void callHost("aiCancel", { requestId }).catch(() => undefined);
      controllerRef.error(new DOMException("Aborted", "AbortError"));
    }, { once: true });
    try {
      await callHost("aiStreamStart", { requestId, body });
    } catch (error) {
      finish();
      throw error;
    }
    return new Response(readable, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } });
  }
}
