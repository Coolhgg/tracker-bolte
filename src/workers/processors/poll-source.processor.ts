import { Job } from 'bullmq';
import { prisma } from '@/lib/prisma';
import { scrapers, ScraperError, validateSourceUrl, RateLimitError, ProxyBlockedError } from '@/lib/scrapers';
import { chapterIngestQueue, getNotificationSystemHealth } from '@/lib/queues';
import { sourceRateLimiter } from '@/lib/rate-limiter';
import { z } from 'zod';

const MAX_CONSECUTIVE_FAILURES = 5;
const RATE_LIMIT_TIMEOUT_MS = 60000; // 60s max wait for rate limit

// Thresholds for backpressure (BUG 9)
const MAX_INGEST_QUEUE_SIZE = 50000;

const PollSourceDataSchema = z.object({
  seriesSourceId: z.string().uuid(),
});

export interface PollSourceData {
  seriesSourceId: string;
}

export async function processPollSource(job: Job<PollSourceData>) {
  const jobId = job.id || 'unknown'; // Job Correlation ID (BUG 12)
  console.log(`[PollSource][${jobId}] Starting process for source ID: ${job.data.seriesSourceId}`);

  // Validate job payload
  const parseResult = PollSourceDataSchema.safeParse(job.data);
  if (!parseResult.success) {
    throw new Error(`[PollSource][${jobId}] Invalid job payload: ${parseResult.error.message}`);
  }

  const { seriesSourceId } = parseResult.data;

  const source = await prisma.seriesSource.findUnique({
    where: { id: seriesSourceId },
    include: { series: true }
  });

  if (!source) {
    console.warn(`[PollSource][${jobId}] Source ${seriesSourceId} not found, skipping`);
    return;
  }

  // BUG 9: Backpressure check
  const systemHealth = await getNotificationSystemHealth();
  const ingestQueueSize = await chapterIngestQueue.getJobCounts('waiting');
  
  if (systemHealth.isCritical || ingestQueueSize.waiting > MAX_INGEST_QUEUE_SIZE) {
    console.warn(`[PollSource][${jobId}] System under high load (waiting: ${ingestQueueSize.waiting}), delaying poll for ${source.series.title}`);
    await prisma.seriesSource.update({
      where: { id: source.id },
      data: {
        next_check_at: new Date(Date.now() + 15 * 60 * 1000), // Delay 15 min
      }
    });
    return;
  }

  // Circuit breaker: skip if too many consecutive failures
  if (source.failure_count >= MAX_CONSECUTIVE_FAILURES) {
    console.warn(`[PollSource][${jobId}] Circuit breaker open for ${seriesSourceId} (${source.failure_count} failures)`);
    await prisma.seriesSource.update({
      where: { id: source.id },
      data: {
        sync_priority: 'COLD',
        next_check_at: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24hr
      }
    });
    return;
  }

  // Validate source URL
  if (!validateSourceUrl(source.source_url)) {
    console.error(`[PollSource][${jobId}] Invalid source URL for ${seriesSourceId}`);
    await prisma.seriesSource.update({
      where: { id: source.id },
      data: {
        failure_count: { increment: 1 },
        last_checked_at: new Date(),
      }
    });
    return;
  }

  const scraper = scrapers[source.source_name.toLowerCase()];
  if (!scraper) {
    console.error(`[PollSource][${jobId}] No scraper for source ${source.source_name}`);
    return;
  }

  // ========================================
  // RATE LIMITING: Acquire token before scraping
  // This ensures we don't exceed per-source limits
  // ========================================
  const sourceName = source.source_name.toLowerCase();
  console.log(`[PollSource][${jobId}] Waiting for rate limit token for ${sourceName}...`);
  
  const tokenAcquired = await sourceRateLimiter.acquireToken(sourceName, RATE_LIMIT_TIMEOUT_MS);
  
  if (!tokenAcquired) {
    // Rate limit timeout - reschedule job for later
    console.warn(`[PollSource][${jobId}] Rate limit timeout for ${sourceName}, rescheduling`);
    await prisma.seriesSource.update({
      where: { id: source.id },
      data: {
        next_check_at: new Date(Date.now() + 5 * 60 * 1000), // Retry in 5 min
      }
    });
    return;
  }

  try {
    console.log(`[PollSource][${jobId}] Polling ${source.source_name} for ${source.series.title}...`);
    const scrapedData = await scraper.scrapeSeries(source.source_id);
    
    // For each chapter, enqueue an ingestion job
    const ingestJobs = scrapedData.chapters.map(chapter => {
      const chapterNumberStr = chapter.chapterNumber.toString();
      // Deduplication key: sourceId:chapterNumber
      const dedupKey = `${source.id}:${chapterNumberStr}`;
      
      return {
        name: `ingest-${dedupKey}`,
        data: {
          seriesSourceId: source.id,
          seriesId: source.series_id,
          chapterNumber: chapter.chapterNumber,
          chapterTitle: chapter.chapterTitle || null,
          chapterUrl: chapter.chapterUrl,
          publishedAt: chapter.publishedAt ? chapter.publishedAt.toISOString() : null,
          traceId: jobId, // BUG 12: Correlation ID
        },
        opts: {
          jobId: `ingest-${dedupKey}`, // BullMQ native deduplication
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 1000,
          }
        }
      };
    });

    if (ingestJobs.length > 0) {
      await chapterIngestQueue.addBulk(ingestJobs);
      console.log(`[PollSource][${jobId}] Enqueued ${ingestJobs.length} ingestion jobs for ${source.series.title}`);
    }

    // Update source status
    await prisma.seriesSource.update({
      where: { id: source.id },
      data: {
        last_checked_at: new Date(),
        last_success_at: new Date(),
        failure_count: 0,
      }
    });

  } catch (error) {
    // BUG 10: Error classification
    let isRetryable = true;
    let nextCheckDelayMs = 15 * 60 * 1000; // Default 15 min

    if (error instanceof RateLimitError) {
      console.warn(`[PollSource][${jobId}] Rate limited by source ${source.source_name}, backing off 1 hour`);
      nextCheckDelayMs = 60 * 60 * 1000; // 1 hour
      isRetryable = true;
    } else if (error instanceof ProxyBlockedError) {
      console.warn(`[PollSource][${jobId}] Proxy blocked for ${source.source_name}, backing off 2 hours`);
      nextCheckDelayMs = 120 * 60 * 1000; // 2 hours
      isRetryable = true;
    } else if (error instanceof ScraperError) {
      isRetryable = error.isRetryable;
    }
    
    console.error(`[PollSource][${jobId}] Error polling source ${source.id}:`, error);
    
    await prisma.seriesSource.update({
      where: { id: source.id },
      data: {
        last_checked_at: new Date(),
        failure_count: { increment: 1 },
        next_check_at: new Date(Date.now() + nextCheckDelayMs),
      }
    });

    if (isRetryable) {
      throw error;
    }
  }
}
