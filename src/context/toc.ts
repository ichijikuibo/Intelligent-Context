/**
 * Generates a table of contents for summary content by extracting `##` headings.
 * Returns a JSON array of entries, each describing a section:
 *   h  - heading text (without the ## prefix)
 *   l  - 1-based start line number of the heading
 *   c  - number of lines in the section (heading + body until next heading)
 *   s  - character count of the section body (excluding the heading line)
 *
 * This is a fast code-only operation — no model call needed.
 */

export interface TocEntry {
  /** Heading text (without the ## prefix) */
  h: string;
  /** 1-based start line number */
  l: number;
  /** Number of lines in the section */
  c: number;
  /** Character count of the section body (excluding heading line) */
  s: number;
}

const HEADING_REGEX = /^## (.+)$/;

/**
 * Parse summary `content` and return a JSON string representing the TOC.
 * Always returns a valid JSON array string — empty `[]` if no headings found.
 */
export function generateSummaryToc(content: string): string {
  if (!content) return '[]';

  const lines = content.split('\n');
  const entries: TocEntry[] = [];

  let currentHeading: string | null = null;
  let headingLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i]!.match(HEADING_REGEX);
    if (match) {
      // Close the previous section
      if (currentHeading !== null) {
        const sectionLines = lines.slice(headingLine + 1, i);
        // Trim trailing blank lines from body
        while (sectionLines.length > 0 && sectionLines[sectionLines.length - 1] === '') {
          sectionLines.pop();
        }
        entries.push({
          h: currentHeading,
          l: headingLine + 1,
          c: i - headingLine,
          s: sectionLines.join('\n').length,
        });
      }
      currentHeading = match[1]!.trim();
      headingLine = i;
    }
  }

  // Close the final section
  if (currentHeading !== null) {
    const sectionLines = lines.slice(headingLine + 1);
    while (sectionLines.length > 0 && sectionLines[sectionLines.length - 1] === '') {
      sectionLines.pop();
    }
    entries.push({
      h: currentHeading,
      l: headingLine + 1,
      c: lines.length - headingLine,
      s: sectionLines.join('\n').length,
    });
  }

  return JSON.stringify(entries);
}

/**
 * Renders a lightweight table-of-contents prefix from summary content.
 * Returns empty string if there are fewer than 5 sections (the threshold
 * where a TOC becomes useful for navigation).
 *
 * The output is a compact index like:
 *   ## Index
 *   - [6 lines] Database Schema
 *   - [10 lines] Database Infrastructure
 */
export function renderTocPrefix(content: string): string {
  const entries: TocEntry[] = JSON.parse(generateSummaryToc(content));
  if (entries.length < 2) return '';

  const lines = entries.map(
    (e) => `- [${e.c} lines] ${e.h}`
  );
  return `## Index\n${lines.join('\n')}`;
}

/**
 * Parse the TOC JSON string back into entries.
 */
export function parseToc(tocJson: string): TocEntry[] {
  if (!tocJson) return [];
  try {
    const parsed = JSON.parse(tocJson);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry: unknown): entry is TocEntry =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as TocEntry).h === 'string' &&
        typeof (entry as TocEntry).l === 'number' &&
        typeof (entry as TocEntry).c === 'number' &&
        typeof (entry as TocEntry).s === 'number'
    );
  } catch {
    return [];
  }
}
