import { prisma } from "@/lib/prisma";

export interface ImportEntry {
  title: string;
  status: string;
  progress: number;
  last_updated?: string | number | Date;
  external_id?: string;
  source_platform?: string;
}

export interface MatchResult {
  series_id: string | null;
  confidence: "high" | "medium" | "none";
  match_type: "slug" | "exact_title" | "alias" | "none";
}

/**
 * Normalizes titles for deterministic matching (BUG 81)
 * Removes special characters, extra whitespace, and normalizes unicode.
 */
export function normalizeTitle(title: string): string {
  if (!title) return "";
  return title
    .toLowerCase()
    .normalize("NFKC") // Normalize unicode (BUG 50)
    .replace(/[^\w\s]/g, "") // Remove punctuation
    .replace(/\s+/g, " ") // Normalize whitespace
    .trim();
}

export async function matchSeries(entry: ImportEntry): Promise<MatchResult> {
  const normalizedInputTitle = normalizeTitle(entry.title);
  
  // 1. Exact slug/external ID match
  if (entry.external_id && entry.source_platform) {
    const series = await prisma.series.findFirst({
      where: {
        external_links: {
          path: [entry.source_platform],
          equals: entry.external_id,
        },
      },
      select: { id: true },
    });
    if (series) {
      return { series_id: series.id, confidence: "high", match_type: "slug" };
    }
  }

  // 2. Exact title match (using normalized search)
  // BUG 81: Use normalized title for comparison
  const exactMatch = await prisma.series.findFirst({
    where: {
      OR: [
        { title: { equals: entry.title, mode: "insensitive" } },
        { title: { equals: normalizedInputTitle, mode: "insensitive" } }
      ]
    },
    select: { id: true },
  });
  if (exactMatch) {
    return { series_id: exactMatch.id, confidence: "high", match_type: "exact_title" };
  }

  // 3. Alias match (Normalized title)
  const aliasMatch = await prisma.series.findFirst({
    where: {
      alternative_titles: {
        array_contains: entry.title,
      },
    },
    select: { id: true },
  });
  if (aliasMatch) {
    return { series_id: aliasMatch.id, confidence: "medium", match_type: "alias" };
  }

  // 4. Fuzzy normalization match
  // In a real app, you'd use a dedicated search index, but here we can check if 
  // any series matches our normalized title
  const fuzzyMatch = await prisma.series.findFirst({
    where: {
      title: {
        contains: normalizedInputTitle,
        mode: "insensitive"
      }
    },
    select: { id: true }
  });
  if (fuzzyMatch) {
    return { series_id: fuzzyMatch.id, confidence: "medium", match_type: "alias" };
  }

  // 5. Skip if uncertain
  return { series_id: null, confidence: "none", match_type: "none" };
}

/**
 * Calculates string similarity using Sorensen-Dice coefficient
 * Returns a value between 0 and 1
 */
export function calculateSimilarity(s1: string, s2: string): number {
  const n1 = normalizeTitle(s1).replace(/\s+/g, "");
  const n2 = normalizeTitle(s2).replace(/\s+/g, "");

  if (n1 === n2) return 1.0;
  if (n1.length < 2 || n2.length < 2) return 0;

  const bigrams1 = new Set();
  for (let i = 0; i < n1.length - 1; i++) {
    bigrams1.add(n1.substring(i, i + 2));
  }

  const bigrams2 = new Set();
  for (let i = 0; i < n2.length - 1; i++) {
    bigrams2.add(n2.substring(i, i + 2));
  }

  let intersection = 0;
  for (const bigram of bigrams1) {
    if (bigrams2.has(bigram)) intersection++;
  }

  return (2 * intersection) / (bigrams1.size + bigrams2.size);
}

export function normalizeStatus(status: string): string {
  const s = status.toLowerCase().trim();
  if (s.includes("watch") || s.includes("read")) return "reading";
  if (s.includes("complet")) return "completed";
  if (s.includes("plan") || s.includes("want")) return "planning";
  if (s.includes("drop")) return "dropped";
  if (s.includes("hold") || s.includes("pause")) return "paused";
  return "reading"; // fallback
}

export const STATUS_RANKS: Record<string, number> = {
  planning: 0,
  paused: 1,
  dropped: 2,
  reading: 3,
  completed: 4,
};

export interface ReconcileResult {
  shouldUpdate: boolean;
  updateData?: {
    status?: string;
    progress?: number;
  };
  reason?: string;
}

export function reconcileEntry(
  existing: { status: string; progress: number; last_updated?: Date | null },
  imported: { status: string; progress: number; last_updated?: string | number | Date }
): ReconcileResult {
  const existingRank = STATUS_RANKS[existing.status] ?? -1;
  const importedRank = STATUS_RANKS[imported.status] ?? -1;

  const existingLastUpdated = existing.last_updated ? new Date(existing.last_updated).getTime() : 0;
  const importedLastUpdated = imported.last_updated ? new Date(imported.last_updated).getTime() : 0;

  const progressIncreased = imported.progress > existing.progress;
  const timeIncreased = importedLastUpdated > existingLastUpdated;
  const statusAdvanced = importedRank > existingRank;

  // TERMINAL PROTECTION:
  // If existing is COMPLETED, only allow update if progress increased
  if (existing.status === 'completed' && imported.status !== 'completed' && !progressIncreased) {
    return { 
      shouldUpdate: false, 
      reason: "Terminal status protection: Cannot downgrade COMPLETED status without progress increase" 
    };
  }

  // DELTA DEFINITION:
  // Imported entry applies ONLY IF:
  // - imported.last_updated > existing.last_updated
  // OR
  // - imported.progress > existing.progress
  
  if (timeIncreased || progressIncreased) {
    // Even if time increased, don't allow progress regression unless time is significantly newer
    // (e.g. user manually rolled back on the source platform)
    if (imported.progress < existing.progress && !timeIncreased) {
      return { shouldUpdate: false, reason: "Progress regression blocked (imported < existing)" };
    }

    return {
      shouldUpdate: true,
      updateData: {
        status: imported.status,
        progress: imported.progress,
      },
      reason: timeIncreased ? "Timestamp advancement" : "Progress increase",
    };
  }

  // Idempotency: If exactly the same, skip
  if (imported.progress === existing.progress && importedRank === existingRank) {
    return { shouldUpdate: false, reason: "Already up to date (idempotent skip)" };
  }

  // Status-only update (if timestamp is unknown or same)
  if (statusAdvanced && imported.progress === existing.progress) {
    return {
      shouldUpdate: true,
      updateData: { status: imported.status },
      reason: "Status advancement"
    };
  }

  return { shouldUpdate: false, reason: "No significant changes or older data detected" };
}
