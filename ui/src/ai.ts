export type AiTask = "proofread" | "structure" | "analyze" | "summarize" | "custom";

export type AiBlockInput = {
  id: string;
  type: string;
  text: string;
  props?: { level: number };
};

export type AiEdit = {
  id: string;
  text: string;
  type: string;
  props?: { level: number };
};

export type AiStatus = {
  provider: string;
  connected: boolean;
  models: string[];
  defaultModel: string;
  openRouterConfigured?: boolean;
};

export type AiProvider = "ollama" | "openrouter" | "compat";
/** "linked" = the open note plus the notes it links to / is linked from; read-only (analysis, summary, free question). */
export type AiScope = "selection" | "paragraph" | "note" | "linked";
export type AiOperation = "proofread" | "rewrite" | "shorten" | "expand" | "continue" | "structure" | "analyze" | "summarize" | "custom";

export type AiModelOption = {
  id: string;
  name: string;
  contextLength?: number;
  promptPrice?: number;
  completionPrice?: number;
  free: boolean;
};

export type AiProviderStatus = {
  defaultProvider?: AiProvider;
  providers: {
    ollama: { configured: boolean; models: string[]; defaultModel: string };
    openrouter: { configured: boolean; usage?: { callsToday: number; dailyLimit: number; spentMonthUsd: number; monthlyBudgetUsd: number } };
    /** the OpenAI-compatible service the owner configured (Groq, Gemini, LM Studio, ...); the key is never here */
    compat?: { configured: boolean; name: string; baseUrl: string; local: boolean; hasKey: boolean; builtin?: boolean; keyOptional?: boolean };
  };
};

export type AiStreamInput = {
  provider: AiProvider;
  model: string;
  operation: AiOperation;
  scope: AiScope;
  contextText: string;
  noteTitle: string;
  instruction?: string;
  styleGuidance?: string;
  remoteConsent?: boolean;
  /** a compat service on this computer needs no consent */
  localService?: boolean;
  costConfirmed?: boolean;
  maxOutputTokens?: number;
};

export type AiCitation = { marker: string; blockId: string; label: string };
export type AiProposal = {
  id: string;
  noteId: string;
  operation: AiOperation;
  provider: AiProvider;
  model: string;
  scope: AiScope;
  sourceText: string;
  proposedText: string;
  sourceFingerprint: string;
  selectionFrom?: number;
  selectionTo?: number;
  sourceBlockId?: string;
  /** set when the answer is an insight (a transformation result) that is added to the note instead of replacing text */
  insightTitle?: string;
  citations: AiCitation[];
  elapsedMs: number;
  firstTokenMs: number | null;
  /** the answer hit the output limit and is incomplete: it must not be applied */
  truncated?: boolean;
  /** mechanical comparison with the source (numbers, addresses, tables, pictures, size, language) */
  checks?: Array<{ level: "ok" | "warn" | "error"; text: string }>;
  /** what was stripped around the answer (introduction, code fence, labels) */
  cleaned?: string[];
};

export type AiResult = {
  task: AiTask;
  model: string;
  report: string;
  edits: AiEdit[];
};

export async function getAiStatus(signal?: AbortSignal): Promise<AiStatus> {
  const response = await fetch("/api/ai/status", { signal, cache: "no-store" });
  if (!response.ok) throw new Error("Не удалось проверить локальный AI");
  return response.json() as Promise<AiStatus>;
}

export async function runAiTask(input: {
  task: AiTask;
  model: string;
  noteTitle: string;
  blocks: AiBlockInput[];
  instruction?: string;
}, signal?: AbortSignal): Promise<AiResult> {
  if (input.task === "custom" && (!input.instruction?.trim() || input.instruction.length > 1000)) {
    throw new Error("Введите инструкцию длиной от 1 до 1000 символов.");
  }
  const response = await fetch("/api/ai/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal,
    body: JSON.stringify(input),
  });
  const payload: unknown = await response.json();
  if (!response.ok) {
    const message = typeof payload === "object" && payload !== null && "error" in payload && typeof payload.error === "string"
      ? payload.error
      : "Не удалось выполнить задачу локальным AI";
    throw new Error(message);
  }
  return payload as AiResult;
}

export async function getAiProviders(signal?: AbortSignal): Promise<AiProviderStatus> {
  const response = await fetch("/api/ai/status", { signal, cache: "no-store" });
  if (!response.ok) throw new Error("Не удалось проверить AI-провайдеры");
  return response.json() as Promise<AiProviderStatus>;
}

export type HiddenModel = { name: string; reason: string };

export async function getAiModels(provider: AiProvider, signal?: AbortSignal): Promise<{ models: AiModelOption[]; hidden: HiddenModel[] }> {
  const response = await fetch(`/api/ai/models?provider=${provider}`, { signal, cache: "no-store" });
  const payload: unknown = await response.json();
  if (!response.ok) {
    const message = isRecord(payload) && typeof payload.error === "string" ? payload.error : "Не удалось загрузить модели";
    throw new Error(message);
  }
  if (!isRecord(payload) || !Array.isArray(payload.models)) throw new Error("Провайдер вернул некорректный каталог моделей");
  const hidden = Array.isArray(payload.hidden)
    ? payload.hidden.filter((item): item is HiddenModel => isRecord(item) && typeof item.name === "string" && typeof item.reason === "string")
    : [];
  return { models: payload.models.filter(isAiModelOption), hidden };
}

export async function streamAiTask(
  input: AiStreamInput,
  options: {
    signal?: AbortSignal;
    onDelta: (text: string) => void;
    onFirstToken?: (at: number) => void;
  },
): Promise<{ model: string; elapsedMs: number; firstTokenMs: number | null; truncated: boolean }> {
  if (!input.contextText.trim()) throw new Error("Нет текста для AI-запроса.");
  if (input.contextText.length > 24_000) throw new Error("Контекст AI-запроса превышает 24 000 символов.");
  if ((input.operation === "structure" && input.scope !== "note") || (input.operation === "analyze" && input.scope !== "note" && input.scope !== "linked")) {
    throw new Error("Эта операция доступна только для всей заметки.");
  }
  if (input.scope === "linked" && !["analyze", "summarize", "custom"].includes(input.operation)) {
    throw new Error("Для связанных заметок доступны только анализ, резюме и свой вопрос.");
  }
  if (input.provider !== "ollama" && !input.remoteConsent && !input.localService) throw new Error("Сначала подтвердите отправку текста во внешний сервис.");

  const startedAt = performance.now();
  const response = await fetch("/api/ai/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: options.signal,
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    const message = isRecord(payload) && typeof payload.error === "string" ? payload.error : `AI-провайдер вернул HTTP ${response.status}`;
    throw new Error(message);
  }
  if (!response.body) throw new Error("Провайдер не открыл потоковый ответ.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let firstTokenMs: number | null = null;
  let model = input.model;
  let completed = false;
  let truncated = false;

  const consumeEvent = (event: string) => {
    const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) return;
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      throw new Error("AI-провайдер вернул повреждённое событие.");
    }
    if (!isRecord(payload)) throw new Error("AI-провайдер вернул некорректное событие.");
    if (payload.error && typeof payload.error === "string") throw new Error(payload.error);
    if (typeof payload.model === "string") model = payload.model;
    if (typeof payload.delta === "string" && payload.delta.length > 0) {
      if (firstTokenMs === null) {
        firstTokenMs = performance.now() - startedAt;
        options.onFirstToken?.(firstTokenMs);
      }
      options.onDelta(payload.delta);
    }
    if (payload.truncated === true) truncated = true;   // the model stopped at its output limit: the answer ends in the middle
    if (payload.done === true) completed = true;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = pending.search(/\r?\n\r?\n/)) >= 0) {
        const event = pending.slice(0, boundary);
        const delimiter = pending.slice(boundary).match(/^\r?\n\r?\n/)?.[0] ?? "\n\n";
        pending = pending.slice(boundary + delimiter.length);
        consumeEvent(event);
      }
    }
    pending += decoder.decode();
    if (pending.trim()) consumeEvent(pending);
  } finally {
    reader.releaseLock();
  }

  if (!completed) throw new Error("Поток AI завершился без подтверждения результата.");
  return { model, elapsedMs: performance.now() - startedAt, firstTokenMs, truncated };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAiModelOption(value: unknown): value is AiModelOption {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.name === "string"
    && typeof value.free === "boolean"
    && (value.contextLength === undefined || typeof value.contextLength === "number")
    && (value.promptPrice === undefined || typeof value.promptPrice === "number")
    && (value.completionPrice === undefined || typeof value.completionPrice === "number");
}