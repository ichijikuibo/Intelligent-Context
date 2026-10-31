export const MAX_FULL_SUMMARY_DETAILS = 5;

interface CompactSummaryContextInput {
  id: string;
  oneLineSummary: string;
  categories?: string[];
  category?: string;
  confidence?: number;
}

export function renderCompactSummaryContext(input: CompactSummaryContextInput): string {
  const types = formatSummaryTypes(input.categories, input.category);
  const confidence = Number.isFinite(input.confidence) ? input.confidence!.toFixed(2) : '0.00';
  const oneLineSummary = input.oneLineSummary.replace(/\s+/g, ' ').trim() || 'Summary details available on demand.';

  return [
    `- ${input.id} [${types}] - confidence: ${confidence}`,
    oneLineSummary,
    `Full details: use tool ic_get_summary with ${input.id}`,
  ].join('\n');
}

function formatSummaryTypes(categories?: string[], fallbackCategory?: string): string {
  const normalized = [...new Set((categories ?? [])
    .map((category) => category.trim())
    .filter((category) => category.length > 0))];

  if (normalized.length > 0) return normalized.join(', ');
  if (fallbackCategory && fallbackCategory.trim().length > 0) return fallbackCategory.trim();
  return 'summary';
}