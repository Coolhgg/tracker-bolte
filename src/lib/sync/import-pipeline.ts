import { prisma } from "@/lib/prisma";
import { ImportEntry, matchSeries, normalizeStatus, reconcileEntry, calculateSimilarity } from "./import-matcher";
import { syncSourceQueue, refreshCoverQueue } from "@/lib/queues";
import { searchMangaDex } from "@/lib/mangadex";

async function findOrCreateSeriesExternally(entry: ImportEntry): Promise<string | null> {
  try {
    // 1. Search MangaDex
    const candidates = await searchMangaDex(entry.title);
    if (!candidates || candidates.length === 0) return null;

    // 2. Find best match based on title similarity
    const bestMatch = candidates.reduce((best, current) => {
      const currentScore = calculateSimilarity(entry.title, current.title);
      const bestScore = best ? calculateSimilarity(entry.title, best.title) : -1;
      return currentScore > bestScore ? current : best;
    }, null as any);

    if (bestMatch && calculateSimilarity(entry.title, bestMatch.title) > 0.8) {
      // 3. Check if series already exists locally by mangadex_id to avoid unique constraint crash
      const existingSeries = await prisma.series.findUnique({
        where: { mangadex_id: bestMatch.mangadex_id }
      });

      if (existingSeries) {
        console.log(`[Import Discovery] Found existing series ${existingSeries.id} for ${entry.title}`);
        return existingSeries.id;
      }

      // 4. Create the series locally
      try {
        const series = await prisma.series.create({
          data: {
            title: bestMatch.title,
            mangadex_id: bestMatch.mangadex_id,
            alternative_titles: bestMatch.alternative_titles,
            description: bestMatch.description,
            status: bestMatch.status || "ongoing",
            type: bestMatch.type || "manga",
            content_rating: bestMatch.content_rating,
            cover_url: bestMatch.cover_url,
            external_links: {
              mangadex: bestMatch.mangadex_id
            },
            updated_at: new Date(),
            sources: {
              create: {
                source_name: "MangaDex",
                source_id: bestMatch.mangadex_id,
                source_url: `https://mangadex.org/title/${bestMatch.mangadex_id}`,
                sync_priority: "HOT"
              }
            }
          }
        });
        return series.id;
      } catch (createError: any) {
        // Handle race condition: if it was created between our check and create
        if (createError.code === 'P2002') {
          const secondCheck = await prisma.series.findUnique({
            where: { mangadex_id: bestMatch.mangadex_id }
          });
          return secondCheck?.id || null;
        }
        throw createError;
      }
    }
  } catch (error) {
    console.error(`[Import Discovery] Failed for ${entry.title}:`, error);
  }
  return null;
}

export async function processImportJob(jobId: string) {
  const job = await prisma.importJob.findUnique({
    where: { id: jobId },
    include: { user: true }
  });

  if (!job || job.status !== "pending") return;

  await prisma.importJob.update({
    where: { id: jobId },
    data: { status: "processing" }
  });

  const rawEntries = job.error_log as any[] || []; // Assuming entries are temporarily stored here
  const results = {
    matched: 0,
    failed: 0,
    skipped: [] as any[]
  };

    for (const entry of rawEntries) {
      try {
        let match = await matchSeries(entry);
        
        // BUG FIX: Active Discovery for missing series
        if (!match.series_id) {
          console.log(`[Import] No local match for "${entry.title}". Attempting discovery...`);
          const discoveredId = await findOrCreateSeriesExternally(entry);
          if (discoveredId) {
            match = { series_id: discoveredId, confidence: "high", match_type: "exact_title" };
          }
        }

        if (match.series_id) {
          const normalizedStatus = normalizeStatus(entry.status);
          
          // Find existing entry to apply conflict resolution
          const existingEntry = await prisma.libraryEntry.findUnique({
            where: {
              user_id_series_id: {
                user_id: job.user_id,
                series_id: match.series_id
              }
            }
          });

          if (existingEntry) {
            const reconciliation = reconcileEntry(
              { 
                status: existingEntry.status, 
                progress: Number(existingEntry.last_read_chapter || 0),
                last_updated: existingEntry.updated_at
              },
              { 
                status: normalizedStatus, 
                progress: entry.progress,
                last_updated: entry.last_updated
              }
            );

            if (reconciliation.shouldUpdate && reconciliation.updateData) {
              const updateData: any = {
                updated_at: new Date()
              };

              if (reconciliation.updateData.status !== undefined) {
                updateData.status = reconciliation.updateData.status;
              }
              if (reconciliation.updateData.progress !== undefined) {
                updateData.last_read_chapter = reconciliation.updateData.progress;
              }

              await prisma.libraryEntry.update({
                where: { id: existingEntry.id },
                data: updateData
              });
              results.matched++;
            } else {
              results.skipped.push({
                title: entry.title,
                reason: reconciliation.reason || "Conflict resolution skipped update"
              });
            }
          } else {
            // New entry
            await prisma.libraryEntry.create({
              data: {
                user_id: job.user_id,
                series_id: match.series_id,
                status: normalizedStatus,
                last_read_chapter: entry.progress,
                added_at: new Date()
              }
            });
            results.matched++;
          }

          // BUG FIX: Immediate Sync for successfully imported series (Chapters + Covers)
          // Find or create a source to trigger sync
          const source = await prisma.seriesSource.findFirst({
            where: { series_id: match.series_id }
          });

          if (source) {
            console.log(`[Import] Triggering immediate sync for source ${source.id} (${entry.title})`);
            
            // 1. Queue chapter sync
            await syncSourceQueue.add(`sync-${source.id}`, { 
              seriesSourceId: source.id
            }, { 
              jobId: `sync-${source.id}`, // BullMQ deduplication
              priority: 1, // High priority
              removeOnComplete: true 
            });

            // 2. Queue cover refresh if it's a MangaDex source
            if (source.source_name.toLowerCase() === 'mangadex') {
              console.log(`[Import] Triggering cover refresh for ${match.series_id}`);
              await refreshCoverQueue.add(`cover-${match.series_id}`, {
                seriesId: match.series_id,
                sourceId: source.source_id,
                sourceName: 'mangadex'
              }, {
                jobId: `cover-${match.series_id}`,
                priority: 2,
                removeOnComplete: true
              });
            }
          }

        } else {
          results.failed++;
          results.skipped.push({
            title: entry.title,
            reason: "No confident match found even after external discovery"
          });
        }


      // Update progress
      await prisma.importJob.update({
        where: { id: jobId },
        data: {
          processed_items: { increment: 1 },
          matched_items: results.matched,
          failed_items: results.failed
        }
      });
    } catch (error: any) {
      results.failed++;
      results.skipped.push({
        title: entry.title,
        reason: error.message
      });
    }
  }

  await prisma.importJob.update({
    where: { id: jobId },
    data: {
      status: "completed",
      completed_at: new Date(),
      error_log: results.skipped // Record failures for user report
    }
  });

  // Log audit event
  await prisma.auditLog.create({
    data: {
      user_id: job.user_id,
      event: "library_import_completed",
      status: "success",
      metadata: {
        job_id: jobId,
        matched: results.matched,
        failed: results.failed
      }
    }
  });
}

