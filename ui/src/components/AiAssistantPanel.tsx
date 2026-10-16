import { parseMarkdown, stripMarkdown, type Inline, type MdBlock } from "../aiMarkdown";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, MessageCircleQuestion, Check, ChevronDown, Cloud, Copy, FileSearch, LayoutList, LoaderCircle, Maximize2, Minimize2, PenLine, Shield, Sparkles, SpellCheck, StepForward, TextQuote, X, type LucideIcon } from "lucide-react";
import type { AiCitation, AiModelOption, AiOperation, AiProposal, AiProvider, AiProviderStatus, AiScope } from "../ai";
import { parseAiAnalysis, type AiAnalysis, type AiAnalysisItem } from "../aiAnalysis";
import { wordDiff } from "../aiChecks";
import type { Transformation } from "../transformations";
import {
  addPromptRecipe, deletePromptRecipe, loadPromptLibrary, MAX_PROMPT_INSTRUCTION_LENGTH, MAX_PROMPT_NAME_LENGTH,
  savePromptLibrary, updatePromptRecipe, type PromptRecipe,
} from "../promptLibrary";

type Props = {
  compactMode: boolean;
  onExpandAdvanced: () => void;
  provider: AiProvider;
  onProviderChange: (provider: AiProvider) => void;
  model: string;
  onModelChange: (model: string) => void;
  models: AiModelOption[];
  modelsLoading: boolean;
  modelsError: string;
  hiddenModels: Array<{ name: string; reason: string }>;
  providers: AiProviderStatus["providers"] | null;
  scope: AiScope;
  /** titles of notes that would join the context in the «+ связанные» scope */
  linkedTitles: string[];
  onScopeChange: (scope: AiScope) => void;
  contextText: string;
  instruction: string;
  onInstructionChange: (value: string) => void;
  writingRule: string;
  onWritingRuleChange: (value: string) => void;
  onSaveWritingRule: () => void;
  consent: boolean;
  onConsentChange: (value: boolean) => void;
  pending: boolean;
  streamText: string;
  firstTokenMs: number | null;
  elapsedMs: number;
  error: string;
  proposal: AiProposal | null;
  estimatedCost: number | null;
  canRun: boolean;
  onRun: (operation: AiOperation) => void;
  transformations: Transformation[];
  onManageTransformations: () => void;
  onRunTransformation: (id: string) => void;
  /** a question about the note: the answer is not an edit, it is inserted as an insight */
  onAsk: (question: string) => void;
  onCancel: () => void;
  onAccept: () => void;
  onReject: () => void;
  onCitation: (citation: AiCitation) => void;
  onClose: () => void;
  /** present only in the desktop host: stores the OpenRouter key there (never returned to the page) */
  keyManager?: { onSave: (key: string) => Promise<void>; onClear: () => Promise<void>; onSaveCompat: (baseUrl: string, name: string, key: string) => Promise<void>; onClearCompat: () => Promise<void> };
};

const operations: Array<{ id: AiOperation; label: string }> = [
  { id: "proofread", label: "Исправить" },
  { id: "rewrite", label: "Переписать" },
  { id: "structure", label: "Структурировать" },
  { id: "shorten", label: "Сжать" },
  { id: "expand", label: "Расширить" },
  { id: "continue", label: "Продолжить" },
];

const operationIcons: Record<string, LucideIcon> = {
  proofread: SpellCheck, rewrite: PenLine, structure: LayoutList, shorten: Minimize2,
  expand: Maximize2, continue: StepForward, summarize: TextQuote, analyze: FileSearch,
};
const operationHints: Record<string, string> = {
  proofread: "Исправить орфографию и пунктуацию, не меняя смысл",
  rewrite: "Переписать яснее, сохранив факты",
  structure: "Разбить заметку на разделы (вся заметка)",
  shorten: "Сделать короче без потери сути",
  expand: "Развернуть мысль подробнее",
  continue: "Продолжить текст в том же стиле",
  summarize: "Короткое резюме заметки",
  analyze: "Выводы, задачи и вопросы по всей заметке",
};
const scopeOptions: Array<{ id: AiScope; label: string }> = [
  { id: "selection", label: "Выделение" }, { id: "paragraph", label: "Абзац" }, { id: "note", label: "Вся заметка" }, { id: "linked", label: "+ связанные" },
];

const promptTemplates = [
  {
    label: "Извлечь действия и пробелы",
    instruction: "Перечисли конкретные действия, ответственных и сроки. Если ответственный или срок не указаны, явно напиши «не указано»; не выдумывай детали.",
  },
  {
    label: "Подготовить краткую сводку",
    instruction: "Сожми текст до трёх коротких предложений. Сохрани цель, важные решения, даты и следующие шаги; не добавляй факты.",
  },
  {
    label: "Проверить аргументацию",
    instruction: "Раздели проверяемые факты, предположения и открытые вопросы. Не выдавай предположения за факты и не добавляй неподтверждённые сведения.",
  },
];

const rubleFreeFormatter = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 6 });

function getPromptStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

type CiteSource = { byMarker: Map<string, AiCitation>; onCitation: Props["onCitation"] };

function withCitations(text: string, cite: CiteSource | undefined): React.ReactNode {
  if (!cite) return text;
  return text.split(/(\[B\d+\])/g).map((part, index) => {
    const citation = /^\[B\d+\]$/.test(part) ? cite.byMarker.get(part.slice(1, -1)) : undefined;
    return citation ? <button className="ai-citation" key={`${part}-${index}`} onClick={() => cite.onCitation(citation)}>{part}</button> : <span key={index}>{part}</span>;
  });
}

function renderInlines(inlines: Inline[], cite?: CiteSource) {
  return inlines.map((part, index) => {
    let node: React.ReactNode = withCitations(part.text, cite);
    if (part.code) node = <code>{node}</code>;
    if (part.bold) node = <strong>{node}</strong>;
    if (part.italic) node = <em>{node}</em>;
    return part.href ? <a key={index} href={part.href} target="_blank" rel="noreferrer noopener">{node}</a> : <span key={index}>{node}</span>;
  });
}

/** Markdown from the model as formatted text: no # and ** characters on screen; [B1] markers stay clickable. */
function RichProposal({ text, citations, onCitation }: { text: string; citations?: AiCitation[]; onCitation?: Props["onCitation"] }) {
  const blocks = useMemo<MdBlock[]>(() => parseMarkdown(text), [text]);
  const cite = useMemo<CiteSource | undefined>(() => citations?.length && onCitation ? { byMarker: new Map(citations.map((citation) => [citation.marker, citation])), onCitation } : undefined, [citations, onCitation]);
  return (
    <div className="ais-rich">
      {blocks.map((block, index) => {
        if (block.kind === "h") return block.level === 1 ? <h4 key={index}>{renderInlines(block.inlines, cite)}</h4> : <h5 key={index}>{renderInlines(block.inlines, cite)}</h5>;
        if (block.kind === "ul") return <ul key={index}>{block.items.map((item, i) => <li key={i}>{renderInlines(item, cite)}</li>)}</ul>;
        if (block.kind === "ol") return <ol key={index}>{block.items.map((item, i) => <li key={i}>{renderInlines(item, cite)}</li>)}</ol>;
        if (block.kind === "quote") return <blockquote key={index}>{renderInlines(block.inlines, cite)}</blockquote>;
        if (block.kind === "code") return <pre key={index}>{block.text}</pre>;
        return <p key={index}>{renderInlines(block.inlines, cite)}</p>;
      })}
    </div>
  );
}

const analysisSections: Array<{ key: keyof AiAnalysis; label: string }> = [
  { key: "summary", label: "Краткий вывод" },
  { key: "keyFacts", label: "Ключевые факты" },
  { key: "decisions", label: "Решения" },
  { key: "actionItems", label: "Действия" },
  { key: "risks", label: "Риски" },
  { key: "openQuestions", label: "Открытые вопросы" },
];

function renderAnalysisItem(item: AiAnalysisItem, index: number, onCitation: Props["onCitation"]) {
  return (
    <li key={`${item.text}-${index}`}>
      <p>{item.text}</p>
      {item.owner !== undefined && (
        <p className="ai-analysis-meta">
          <span>Ответственный: {item.owner}</span>
          <span>Срок: {item.dueDate}</span>
        </p>
      )}
      {item.citations.length > 0 && (
        <div className="ai-analysis-citations" aria-label="Источники">
          {item.citations.map((citation) => (
            <button
              className="ai-citation"
              key={citation.marker}
              title={citation.label}
              aria-label={`Открыть источник ${citation.marker}: ${citation.label}`}
              onClick={() => onCitation(citation)}
            >
              {citation.marker}
            </button>
          ))}
        </div>
      )}
    </li>
  );
}

function renderAnalysis(analysis: AiAnalysis, onCitation: Props["onCitation"]) {
  return (
    <div className="ai-analysis">
      {analysisSections.map(({ key, label }) => (
        <section className="ai-analysis-section" key={key}>
          <header><strong>{label}</strong><span>{analysis[key].length}</span></header>
          {analysis[key].length > 0
            ? <ul>{analysis[key].map((item, index) => renderAnalysisItem(item, index, onCitation))}</ul>
            : <p className="ai-analysis-empty">Модель не указала пунктов в этой категории.</p>}
        </section>
      ))}
    </div>
  );
}

export function AiAssistantPanel({
  compactMode, onExpandAdvanced,
  provider, onProviderChange, model, onModelChange, models, modelsLoading, modelsError, hiddenModels, providers,
  scope, linkedTitles, onScopeChange, contextText, instruction, onInstructionChange, writingRule, onWritingRuleChange,
  onSaveWritingRule, consent, onConsentChange, pending, streamText, firstTokenMs, elapsedMs, error,
  proposal, estimatedCost, canRun, onRun, transformations, onManageTransformations, onRunTransformation, onAsk, onCancel, onAccept, onReject, onCitation, onClose, keyManager,
}: Props) {
  const [modalMode, setModalMode] = useState(() => window.matchMedia("(max-width: 1199px)").matches);
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [modelQuery, setModelQuery] = useState("");
  const [keyDraft, setKeyDraft] = useState("");
  const [keyMessage, setKeyMessage] = useState("");
  const [promptLibrary, setPromptLibrary] = useState<{ recipes: PromptRecipe[]; error: string }>(() => {
    const storage = getPromptStorage();
    if (!storage) return { recipes: [], error: "Локальное хранилище недоступно: библиотека рецептов не загружена." };
    const loaded = loadPromptLibrary(storage);
    return loaded.ok ? { recipes: loaded.value, error: "" } : { recipes: [], error: loaded.error };
  });
  const [recipeEditor, setRecipeEditor] = useState<{ id: string | null; name: string; instruction: string } | null>(null);
  const visibleModels = useMemo(() => {
    const query = modelQuery.trim().toLocaleLowerCase();
    return models.filter((item) => !query || `${item.name} ${item.id}`.toLocaleLowerCase().includes(query)).slice(0, 100);
  }, [modelQuery, models]);
  const selectedModel = models.find((item) => item.id === model);
  const compat = providers?.compat;
  const remoteReady = provider === "ollama" ? true : provider === "compat" ? Boolean(compat?.configured && ((compat.local && !/(^|[-/:])cloud($|[-/:])/i.test(model)) || consent)) : Boolean(consent && providers?.openrouter.configured);
  const canStart = canRun && !pending && remoteReady && Boolean(model) && Boolean(contextText.trim());
  const hasContext = Boolean(contextText.trim());
  const contextLabel = scope === "selection" ? "Выделение" : scope === "paragraph" ? "текущий абзац" : scope === "linked" ? "заметка и связанные заметки" : "вся заметка";
  const analysis = proposal?.operation === "analyze" ? parseAiAnalysis(proposal.proposedText, proposal.citations) : null;
  const visibleOperations = compactMode ? operations.slice(0, 4) : operations;
  const providerLabel = provider === "ollama" ? "Ollama" : provider === "compat" ? (compat?.name || "Другой сервис") : "OpenRouter";
  const modelLabel = selectedModel?.name ?? (modelsLoading ? "загрузка модели…" : "модель не выбрана");
  const priceLabel = selectedModel?.free
    ? "Бесплатно"
    : selectedModel?.promptPrice !== undefined && selectedModel.completionPrice !== undefined
      ? `$${rubleFreeFormatter.format(selectedModel.promptPrice * 1_000_000)} / $${rubleFreeFormatter.format(selectedModel.completionPrice * 1_000_000)} за 1M входных / выходных токенов`
      : selectedModel ? "Цена неизвестна — запуск заблокирован" : "";
  const persistRecipes = (recipes: PromptRecipe[]) => {
    const storage = getPromptStorage();
    if (!storage) {
      setPromptLibrary((current) => ({ ...current, error: "Локальное хранилище недоступно: рецепт не сохранён." }));
      return false;
    }
    const saved = savePromptLibrary(storage, recipes);
    if (!saved.ok) {
      setPromptLibrary((current) => ({ ...current, error: saved.error }));
      return false;
    }
    setPromptLibrary({ recipes, error: "" });
    return true;
  };
  const openNewRecipe = () => setRecipeEditor({ id: null, name: "", instruction: "" });
  const openRecipe = (recipe: PromptRecipe) => setRecipeEditor({ id: recipe.id, name: recipe.name, instruction: recipe.instruction });
  const saveRecipe = () => {
    if (!recipeEditor) return;
    const recipe: PromptRecipe = {
      id: recipeEditor.id ?? crypto.randomUUID(),
      name: recipeEditor.name.trim(),
      instruction: recipeEditor.instruction.trim(),
    };
    const changed = recipeEditor.id
      ? updatePromptRecipe(promptLibrary.recipes, recipe)
      : addPromptRecipe(promptLibrary.recipes, recipe);
    if (!changed.ok) {
      setPromptLibrary((current) => ({ ...current, error: changed.error }));
      return;
    }
    if (persistRecipes(changed.value)) setRecipeEditor(null);
  };
  const removeRecipe = (id: string) => {
    const changed = deletePromptRecipe(promptLibrary.recipes, id);
    if (changed.ok) persistRecipes(changed.value);
    else setPromptLibrary((current) => ({ ...current, error: changed.error }));
  };

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 1199px)");
    const updateMode = () => setModalMode(mediaQuery.matches);
    updateMode();
    mediaQuery.addEventListener("change", updateMode);
    return () => mediaQuery.removeEventListener("change", updateMode);
  }, []);

  useEffect(() => {
    if (!modalMode) return;
    const focusTimer = window.setTimeout(() => closeButtonRef.current?.focus(), 0);
    return () => window.clearTimeout(focusTimer);
  }, [modalMode]);

  const handleDialogKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (!modalMode || event.key !== "Tab") return;
    const isActuallyTabbable = (element: HTMLElement) => {
      if (!element.isConnected || element.hasAttribute("disabled") || element.hasAttribute("hidden")) return false;
      let ancestor = element.parentElement;
      while (ancestor && ancestor !== dialogRef.current) {
        if (ancestor.hasAttribute("hidden") || ancestor.hasAttribute("inert") || ancestor.getAttribute("aria-hidden") === "true") return false;
        if (ancestor.matches("details:not([open])") && !element.matches("summary")) return false;
        ancestor = ancestor.parentElement;
      }
      const style = window.getComputedStyle(element);
      return element.getClientRects().length > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, a[href], [tabindex]:not([tabindex="-1"])',
    ) ?? []).filter(isActuallyTabbable);
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const local = provider === "ollama" || (provider === "compat" && Boolean(compat?.local));
  return (
    <aside
      ref={dialogRef}
      className="ai-assistant ai-studio"
      role={modalMode ? "dialog" : "complementary"}
      aria-modal={modalMode ? "true" : undefined}
      aria-labelledby="ai-assistant-title"
      aria-label={modalMode ? undefined : "AI-помощник"}
      aria-busy={pending}
      onKeyDown={handleDialogKeyDown}
    >
      <header className="ais-header">
        <span className="ais-mark" aria-hidden="true"><Sparkles size={16} /></span>
        <div className="ais-title"><strong id="ai-assistant-title">AI-помощник</strong><span>Меняет текст только после «Применить»</span></div>
        <button ref={closeButtonRef} className="icon-button quiet" aria-label="Закрыть AI-помощник" onClick={onClose}><X size={17} /></button>
      </header>

      <div className="ais-body">
        <details className="ais-model ai-advanced-controls">
          <summary>
            <span className={`ais-dot ${local ? "is-local" : "is-cloud"}`} aria-hidden="true" />
            <span className="ais-model-text"><b>{providerLabel}</b><span>{modelLabel}</span></span>
            <ChevronDown size={15} aria-hidden="true" />
            <span className="visually-hidden">Настройки AI и модели</span>
          </summary>
          <div className="ai-assistant-settings">
            <div className="ais-field"><span id="ais-provider-label">Где работает модель</span>
              <div className="ais-seg" role="radiogroup" aria-labelledby="ais-provider-label">
                <button role="radio" aria-checked={local} className={local ? "is-on" : ""} onClick={() => onProviderChange("ollama")}><Shield size={14} />На компьютере</button>
                <button role="radio" aria-checked={provider === "openrouter"} className={provider === "openrouter" ? "is-on" : ""} onClick={() => onProviderChange("openrouter")}><Cloud size={14} />OpenRouter</button>
                <button role="radio" aria-checked={provider === "compat"} className={provider === "compat" ? "is-on" : ""} onClick={() => onProviderChange("compat")}><Cloud size={14} />Онлайн</button>
              </div>
            </div>
            {provider === "compat" && <CompatSettings status={compat} keyManager={keyManager} consent={consent} onConsentChange={onConsentChange} model={model} onModelChange={onModelChange} contextLabel={contextLabel} />}
            {provider === "openrouter" && (
              <div className="ai-remote-consent">
                <p>{providers?.openrouter.configured
                  ? `Контекст «${contextLabel}» будет отправлен OpenRouter. Перед запуском проверьте точный контекст и цену.`
                  : (keyManager ? "Ключ OpenRouter не сохранён. Вставьте его ниже: он хранится только на этом компьютере." : "OpenRouter key не настроен. Серверное окружение OPENROUTER_API_KEY отсутствует.")}</p>
                {keyManager && (
                  <div className="ai-key-form">
                    <label><span>Ключ OpenRouter</span><input type="password" autoComplete="off" spellCheck={false} value={keyDraft} onChange={(event) => setKeyDraft(event.target.value)} placeholder="sk-or-…" /></label>
                    <div className="ai-key-actions">
                      <button type="button" disabled={keyDraft.trim().length < 16} onClick={() => { void keyManager.onSave(keyDraft.trim()).then(() => { setKeyDraft(""); setKeyMessage("Ключ сохранён."); }).catch((error: unknown) => setKeyMessage(error instanceof Error ? error.message : "Не удалось сохранить ключ.")); }}>Сохранить ключ</button>
                      {providers?.openrouter.configured && <button type="button" onClick={() => { void keyManager.onClear().then(() => setKeyMessage("Ключ удалён.")).catch((error: unknown) => setKeyMessage(error instanceof Error ? error.message : "Не удалось удалить ключ.")); }}>Удалить ключ</button>}
                    </div>
                    {keyMessage && <small role="status">{keyMessage}</small>}
                  </div>
                )}
                {providers?.openrouter.usage && <small className="ais-usage">Облако: сегодня {providers.openrouter.usage.callsToday} из {providers.openrouter.usage.dailyLimit} запросов · в этом месяце ≈${rubleFreeFormatter.format(providers.openrouter.usage.spentMonthUsd)} из ${rubleFreeFormatter.format(providers.openrouter.usage.monthlyBudgetUsd)}</small>}
                <label className="ais-check"><input type="checkbox" checked={consent} onChange={(event) => onConsentChange(event.target.checked)} /> Разрешить отправку выбранного контекста</label>
              </div>
            )}
            <label className="ais-field">
              <span>Модель</span>
              <input aria-label="Фильтр моделей" value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} placeholder="Найти модель…" />
              <select aria-label="Выбрать модель" value={model} onChange={(event) => onModelChange(event.target.value)} disabled={modelsLoading || models.length === 0}>
                {visibleModels.map((item) => <option key={item.id} value={item.id}>{item.name}{item.free ? " · free" : ""}</option>)}
              </select>
              <small>{modelsLoading ? "Загрузка каталога…" : modelsError || priceLabel || "Модель недоступна"}</small>
              {provider === "ollama" && hiddenModels.length > 0 && <small className="ais-hidden-models" title={hiddenModels.map((item) => `${item.name}: ${item.reason}`).join(String.fromCharCode(10))}>Скрыто моделей: {hiddenModels.length} (облачные, кодовые, для поиска, устаревшие, слабые). Наведите, чтобы увидеть причины.</small>}
            </label>
          </div>
        </details>

        <section className="ais-section" aria-label="Что обработать">
          <div className="ais-label"><span id="ais-scope-label">Что обработать</span>
            <span className={`ais-privacy ${local ? "is-local" : "is-cloud"}`}>{local ? <Shield size={12} aria-hidden="true" /> : <Cloud size={12} aria-hidden="true" />}{local ? "Остаётся на компьютере" : scope === "linked" ? `Уйдёт в облако: ${linkedTitles.length + 1} заметок` : "Уйдёт в облако"}</span>
          </div>
          <div className="ais-seg ais-seg-wrap" role="radiogroup" aria-labelledby="ais-scope-label">
            {scopeOptions.map((option) => { const noLinks = option.id === "linked" && linkedTitles.length === 0; return <button key={option.id} role="radio" aria-checked={scope === option.id} disabled={noLinks} title={noLinks ? "У этой заметки нет связей: добавьте [[ссылку]] (Ctrl+L)" : option.id === "linked" ? "Заметка и до 5 связанных заметок — только для чтения" : undefined} className={scope === option.id ? "is-on" : ""} onClick={() => onScopeChange(option.id)}>{option.label}</button>; })}
          </div>
          <details className="ais-context">
            <summary>{hasContext ? `${contextText.length.toLocaleString("ru-RU")} зн. · показать отправляемый текст` : "Нет текста: выделите фрагмент или поставьте курсор в абзац"}</summary>
            {scope === "linked" && <p className="ais-linked-list">Связанные заметки в запросе ({linkedTitles.length}): {linkedTitles.join(", ")}</p>}
            <pre>{contextText || "Сначала выберите текст или установите курсор в абзац."}</pre>
          </details>
        </section>

        <section className="ais-section" aria-label="Команды редактирования">
          <div className="ais-label"><span>Править текст</span></div>
          {!hasContext && <p className="ais-why">Поставьте курсор в абзац с текстом или выделите фрагмент: тогда действия станут доступны.</p>}
          <div className="ais-chips">
            {visibleOperations.map((operation) => {
              const Icon = operationIcons[operation.id] ?? Sparkles;
              const needsNote = (scope === "linked" && !["summarize"].includes(operation.id));
              return <button key={operation.id} className="ais-chip" title={needsNote ? (scope === "linked" ? "Для связанных заметок доступны изучение и свой вопрос" : "Доступно в режиме «Вся заметка»") : operationHints[operation.id]} disabled={!canStart || needsNote} onClick={() => onRun(operation.id)}><Icon size={14} aria-hidden="true" />{operation.label}</button>;
            })}
          </div>
          {compactMode && <button className="ai-show-advanced ais-more" onClick={onExpandAdvanced}>Ещё команды и своя инструкция</button>}
        </section>

        {pending && (
          <div className="ai-live ais-live" role="status" aria-live="polite">
            <div className="ai-live-heading"><LoaderCircle size={15} className="ai-spinner" /> Генерируется · {elapsedMs > 0 ? `${(elapsedMs / 1000).toFixed(1)} с` : "подключение…"}</div>
            {firstTokenMs !== null && <small>Первый токен: {(firstTokenMs / 1000).toFixed(2)} с</small>}
            {streamText && <div className="ais-stream"><RichProposal text={streamText} /><span className="ais-caret" aria-hidden="true" /></div>}
            <button className="ais-ghost" onClick={onCancel}>Отменить запрос</button>
          </div>
        )}
        {error && <p className="ai-error" role="alert">{error}</p>}

        {proposal && (
          <section className="ai-proposal ais-proposal" aria-live="polite">
            <header><strong>{proposal.operation === "analyze" || proposal.operation === "summarize" ? "Анализ заметки" : "Предложение"}</strong><small>{proposal.model} · {(proposal.elapsedMs / 1000).toFixed(1)} с</small></header>
            {proposal.truncated && <p className="ais-truncated" role="alert">Ответ оборван на лимите длины модели: он неполный, «Применить» отключено. Сократите область или повторите запрос.</p>}
            {proposal.operation !== "analyze" && proposal.operation !== "summarize" && proposal.scope !== "linked" && <DiffView before={stripMarkdown(proposal.sourceText)} after={stripMarkdown(proposal.proposedText)} />}
            {proposal.checks && proposal.checks.length > 0 && <ul className="ais-checks" aria-label="Проверка ответа">{proposal.checks.map((check, index) => <li key={index} className={`is-${check.level}`}><span aria-hidden="true">{check.level === "ok" ? "✓" : check.level === "warn" ? "!" : "✕"}</span>{check.text}</li>)}</ul>}
            {proposal.cleaned && proposal.cleaned.length > 0 && <p className="ais-cleaned">Очищено: {proposal.cleaned.join("; ")}.</p>}
            <div className={`ai-proposal-text${analysis ? " ai-proposal-analysis" : ""}`} data-raw={proposal.proposedText}>
              {analysis
                ? renderAnalysis(analysis, onCitation)
                : <>
                  {proposal.operation === "analyze" && <p className="ai-analysis-fallback">Структурированный ответ не распознан; показан исходный текст модели.</p>}
                  <RichProposal text={proposal.proposedText} citations={proposal.citations} onCitation={onCitation} />
                </>}
            </div>
            <div className="ai-proposal-actions">
              {(proposal.insightTitle || (proposal.operation !== "analyze" && proposal.operation !== "summarize")) && proposal.scope !== "linked" && <button className="ai-accept" disabled={proposal.truncated} onClick={onAccept}><Check size={15} /> {proposal.insightTitle ? "Вставить как инсайт" : proposal.checks?.some((check) => check.level === "error") ? "Применить, несмотря на замечания" : "Применить"}</button>}
              <button onClick={onReject}><X size={15} /> Отклонить</button>
            </div>
          </section>
        )}
        {estimatedCost !== null && selectedModel && !selectedModel.free && (
          <p className="ai-cost-estimate">Максимальная оценка запроса (анализ — до 1536 выходных токенов): ${rubleFreeFormatter.format(estimatedCost)}. Перед платным запросом потребуется отдельное подтверждение.</p>
        )}
        {provider === "openrouter" && providers?.openrouter.configured === false && !keyManager && <p className="ai-provider-missing">Добавьте OPENROUTER_API_KEY в игнорируемый .env.local и перезапустите dev-сервер.</p>}

        <section className="ais-section" aria-label="Изучить заметку">
          <div className="ais-label"><span>Изучить заметку</span><small>результат можно вставить в конец</small></div>
          <div className="ais-chips">
            {transformations.map((item) => {
              const linkedOk = scope !== "linked" || item.mode === "analyze";
              return <button key={item.id} className="ais-chip is-insight" disabled={!canRun || pending || !linkedOk} title={linkedOk ? item.hint : "Для связанных заметок доступен только структурный анализ"} onClick={() => onRunTransformation(item.id)}>{item.title}</button>;
            })}
            <button type="button" className="ais-chip" onClick={onManageTransformations} title="Свои трансформации: инструкция, проба, сохранение">＋ Своя…</button>
          </div>
        </section>

        <details className="ai-writing-assets ais-assets">
          <summary>Шаблоны и правила письма</summary>
          <label className="ai-writing-rule">
            Мои правила письма
            <textarea value={writingRule} maxLength={500} onChange={(event) => onWritingRuleChange(event.target.value)} placeholder="Короткое правило, например: короткие фразы, без канцелярита." />
            <button onClick={onSaveWritingRule}>Сохранить на этом устройстве</button>
          </label>
          <div className="ai-prompt-library">
            <p>Шаблон подставит текст в поле инструкции; проверьте его и запустите вручную.</p>
            <div className="ai-prompt-library-list">
              {promptTemplates.map((template) => (
                <button key={template.label} onClick={() => onInstructionChange(template.instruction)}>{template.label}</button>
              ))}
              {promptLibrary.recipes.map((recipe) => (
                <div className="ai-user-recipe" key={recipe.id}>
                  <button onClick={() => onInstructionChange(recipe.instruction)}>{recipe.name}</button>
                  <button className="ai-recipe-action" aria-label={`Изменить рецепт «${recipe.name}»`} onClick={() => openRecipe(recipe)}>Изменить</button>
                  <button className="ai-recipe-action ai-recipe-delete" aria-label={`Удалить рецепт «${recipe.name}»`} onClick={() => removeRecipe(recipe.id)}>Удалить</button>
                </div>
              ))}
            </div>
            <button className="ai-recipe-create" onClick={openNewRecipe}>Добавить рецепт</button>
            {recipeEditor && (
              <div className="ai-recipe-editor" aria-label={recipeEditor.id ? "Изменить рецепт" : "Новый рецепт"}>
                <label>Название
                  <input maxLength={MAX_PROMPT_NAME_LENGTH} value={recipeEditor.name} onChange={(event) => setRecipeEditor({ ...recipeEditor, name: event.target.value })} />
                </label>
                <label>Инструкция
                  <textarea maxLength={MAX_PROMPT_INSTRUCTION_LENGTH} value={recipeEditor.instruction} onChange={(event) => setRecipeEditor({ ...recipeEditor, instruction: event.target.value })} />
                </label>
                <div className="ai-recipe-editor-actions">
                  <button onClick={saveRecipe}>Сохранить рецепт</button>
                  <button onClick={() => setRecipeEditor(null)}>Отмена</button>
                </div>
              </div>
            )}
            {promptLibrary.error && <p className="ai-error" role="alert">{promptLibrary.error}</p>}
          </div>
        </details>
      </div>

      {!compactMode && (
        <footer className="ais-composer">
          <label className="visually-hidden" htmlFor="ais-instruction">Своя инструкция</label>
          <textarea id="ais-instruction" rows={2} value={instruction} maxLength={1000} onChange={(event) => onInstructionChange(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && canStart && instruction.trim()) { event.preventDefault(); onRun("custom"); } }}
            placeholder="Своя инструкция: например, перепиши дружелюбно, сохранив факты" />
          <div className="ais-composer-row">
            <small>{instruction.length}/1000 · Ctrl+Enter</small>
            <button className="ais-ask" aria-label="Задать вопрос по заметке" title="Вопрос по заметке: ответ можно вставить в конец заметки отдельным инсайтом (текст заметки не меняется)" disabled={!canStart || !instruction.trim()} onClick={() => onAsk(instruction.trim())}><MessageCircleQuestion size={15} /> Спросить</button>
            <button className="ais-send" aria-label="Выполнить инструкцию" title="Выполнить инструкцию" disabled={!canStart || !instruction.trim()} onClick={() => onRun("custom")}><ArrowUp size={17} /></button>
          </div>
        </footer>
      )}
    </aside>
  );
}

/** Before/after as one text with the changes marked: deleted words struck through, added words highlighted. Falls back to two blocks for very long texts. */
function DiffView({ before, after }: { before: string; after: string }) {
  const parts = useMemo(() => wordDiff(before, after), [before, after]);
  if (!parts) return <div className="ais-diff-plain"><del>{before}</del><ins>{after}</ins></div>;
  return (
    <div className="ais-diff" aria-label="Изменения в тексте">
      {parts.map((part, index) => part.kind === "same" ? <span key={index}>{part.text}</span> : part.kind === "del" ? <del key={index}>{part.text}</del> : <ins key={index}>{part.text}</ins>)}
    </div>
  );
}


const COMPAT_PRESETS: Array<{ id: string; label: string; url: string; note: string; keyless?: boolean }> = [
  { id: "pollinations", label: "Pollinations (бесплатно, без ключа)", url: "https://text.pollinations.ai/openai", keyless: true, note: "По умолчанию. Бесплатно, без регистрации и ключа; модель GPT-OSS 20B, ответ начинается за несколько секунд. Сервис сторонний, без гарантий доступности и скорости; текст уходит на pollinations.ai." },
  { id: "groq", label: "Groq", url: "https://api.groq.com/openai/v1", note: "Бесплатный тариф с лимитами (на 2026-10: gpt-oss-120b, около 30 запросов в минуту и 1000 в сутки). Условия меняются: проверьте на сайте сервиса." },
  { id: "gemini", label: "Google AI Studio (Gemini)", url: "https://generativelanguage.googleapis.com/v1beta/openai", note: "Бесплатный уровень; Google вправе использовать присланные тексты для улучшения продуктов. Лимиты смотрите в AI Studio." },
  { id: "mistral", label: "Mistral", url: "https://api.mistral.ai/v1", note: "Есть бесплатный план для экспериментов (нужна проверка телефона). Условия проверьте на сайте." },
  { id: "nvidia", label: "NVIDIA NIM", url: "https://integrate.api.nvidia.com/v1", note: "Бесплатные кредиты для разработчиков на build.nvidia.com; ключ начинается с nvapi-." },
  { id: "github", label: "GitHub Models", url: "https://models.github.ai/inference", note: "Бесплатный уровень с лимитами; вместо ключа токен GitHub с правом models. Список моделей сервис не отдаёт: введите название вручную." },
  { id: "ollama-cloud", label: "Ollama: облачные модели вашего аккаунта", url: "http://127.0.0.1:11434/v1", note: "Сильные облачные модели Ollama (например kimi, gpt-oss:120b) работают через ollama.com: текст ИЗ ЗАМЕТКИ УХОДИТ С КОМПЬЮТЕРА. Нужен вход в Ollama (ollama signin); ключ не нужен. Программа попросит согласие и спросит отдельно." },
  { id: "lmstudio", label: "LM Studio (на этом компьютере)", url: "http://127.0.0.1:1234/v1", note: "Сервер на этом компьютере: текст никуда не уходит, ключ не нужен." },
  { id: "vllm", label: "vLLM / llama.cpp (на этом компьютере)", url: "http://127.0.0.1:8000/v1", note: "Сервер на этом компьютере: текст никуда не уходит, ключ не нужен." },
  { id: "custom", label: "Свой адрес", url: "", note: "Любой сервис с интерфейсом OpenAI (адрес до /chat/completions, например https://api.example.com/v1)." },
];

function CompatSettings({ status, keyManager, consent, onConsentChange, model, onModelChange, contextLabel }: {
  status?: { configured: boolean; name: string; baseUrl: string; local: boolean; hasKey: boolean };
  keyManager?: Props["keyManager"];
  consent: boolean;
  onConsentChange: (value: boolean) => void;
  model: string;
  onModelChange: (value: string) => void;
  contextLabel: string;
}) {
  const initialPreset = COMPAT_PRESETS.find((item) => item.url && item.url === status?.baseUrl)?.id ?? (status?.baseUrl ? "custom" : "pollinations");
  const [preset, setPreset] = useState(initialPreset);
  const [url, setUrl] = useState(status?.baseUrl || COMPAT_PRESETS[0].url);
  const [key, setKey] = useState("");
  const [message, setMessage] = useState("");
  const chosen = COMPAT_PRESETS.find((item) => item.id === preset) ?? COMPAT_PRESETS[0];
  const localUrl = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(url.trim());
  const canSave = Boolean(keyManager) && url.trim().length > 8 && (localUrl || chosen.keyless || key.trim().length >= 8 || status?.hasKey);
  return (
    <div className="ai-remote-consent ais-compat">
      <label className="ais-field"><span>Сервис</span>
        <select aria-label="Сервис" value={preset} onChange={(event) => { const next = COMPAT_PRESETS.find((item) => item.id === event.target.value); setPreset(event.target.value); if (next) setUrl(next.url); }}>
          {COMPAT_PRESETS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
      </label>
      <small className="ais-compat-note">{chosen.note}</small>
      <label className="ais-field"><span>Адрес</span><input aria-label="Адрес сервиса" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://…/v1" spellCheck={false} /></label>
      {!localUrl && !chosen.keyless && <label className="ais-field"><span>Ключ{status?.hasKey ? " (сохранён; оставьте пустым, чтобы не менять)" : ""}</span><input type="password" autoComplete="off" spellCheck={false} value={key} onChange={(event) => setKey(event.target.value)} placeholder="ключ API" /></label>}
      <div className="ai-key-actions">
        <button type="button" disabled={!canSave} onClick={() => { void keyManager?.onSaveCompat(url.trim(), chosen.id === "custom" ? "Свой сервис" : chosen.label.replace(/ \(.*\)$/, ""), key.trim()).then(() => { setKey(""); setMessage("Сохранено. Обновляю список моделей…"); }).catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Не удалось сохранить.")); }}>Сохранить</button>
        {status?.configured && <button type="button" onClick={() => { void keyManager?.onClearCompat().then(() => setMessage("Настройки сервиса и ключ удалены.")).catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Не удалось удалить.")); }}>Удалить</button>}
      </div>
      {message && <small role="status">{message}</small>}
      {!keyManager && <small>Настройки сервиса меняются только в настольной программе.</small>}
      <label className="ais-field"><span>Модель (если список не загрузился, введите название вручную)</span><input aria-label="Название модели сервиса" value={model} onChange={(event) => onModelChange(event.target.value)} placeholder="например: openai/gpt-oss-120b" spellCheck={false} /></label>
      {status?.configured && (!status.local || /(^|[-/:])cloud($|[-/:])/i.test(model)) && <><p>Контекст «{contextLabel}» будет отправлен сервису «{status.name}». Перед первым запуском программа спросит отдельно: цена и условия сервиса ей неизвестны.</p>
        <label className="ais-check"><input type="checkbox" checked={consent} onChange={(event) => onConsentChange(event.target.checked)} /> Разрешить отправку выбранного контекста</label></>}
    </div>
  );
}
