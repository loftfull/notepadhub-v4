import type { AiCitation } from "./ai";

export type AiAnalysisItem = {
  text: string;
  citations: AiCitation[];
  owner?: string;
  dueDate?: string;
};

export type AiAnalysis = {
  summary: AiAnalysisItem[];
  keyFacts: AiAnalysisItem[];
  decisions: AiAnalysisItem[];
  actionItems: AiAnalysisItem[];
  risks: AiAnalysisItem[];
  openQuestions: AiAnalysisItem[];
};

const sectionKeys = ["summary", "keyFacts", "decisions", "actionItems", "risks", "openQuestions"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unwrapJson(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1] : trimmed;
}

export function parseAiAnalysis(text: string, sourceCitations: AiCitation[]): AiAnalysis | null {
  let value: unknown;
  try {
    value = JSON.parse(unwrapJson(text));
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;

  const citationByMarker = new Map(
    sourceCitations
      .filter((citation) => /^B[1-9]\d*$/.test(citation.marker) && citation.blockId.trim())
      .map((citation) => [citation.marker, citation]),
  );
  const parsed: Partial<AiAnalysis> = {};

  for (const key of sectionKeys) {
    const entries = value[key];
    if (!Array.isArray(entries) || entries.length > 30) return null;
    const items: AiAnalysisItem[] = [];
    for (const entry of entries) {
      if (!isRecord(entry)
        || typeof entry.text !== "string"
        || !entry.text.trim()
        || entry.text.length > 3000
        || !Array.isArray(entry.citations)
        || entry.citations.length > 20
        || entry.citations.some((marker) => typeof marker !== "string")) return null;

      const item: AiAnalysisItem = {
        text: entry.text.trim(),
        citations: [...new Set(entry.citations)]
          .filter((marker): marker is string => /^B[1-9]\d*$/.test(marker))
          .flatMap((marker) => {
            const citation = citationByMarker.get(marker);
            return citation ? [citation] : [];
          }),
      };
      if (key === "actionItems") {
        if (typeof entry.owner !== "string" || !entry.owner.trim()
          || typeof entry.dueDate !== "string" || !entry.dueDate.trim()) return null;
        item.owner = entry.owner.trim();
        item.dueDate = entry.dueDate.trim();
      }
      items.push(item);
    }
    parsed[key] = items;
  }

  return parsed as AiAnalysis;
}
