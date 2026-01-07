import 'dotenv/config';
import { Worker } from 'bullmq';
import { redisWorker, disconnectRedis, REDIS_KEY_PREFIX, setWorkerHeartbeat } from '@/lib/redis';
import { 
    SYNC_SOURCE_QUEUE, CHECK_SOURCE_QUEUE, NOTIFICATION_QUEUE, 
      NOTIFICATION_DELIVERY_QUEUE, NOTIFICATION_DELIVERY_PREMIUM_QUEUE, NOTIFICATION_DIGEST_QUEUE,
      CANONICALIZE_QUEUE, REFRESH_COVER_QUEUE, CHAPTER_INGEST_QUEUE, GAP_RECOVERY_QUEUE,
      syncSourceQueue, checkSourceQueue, notificationQueue,
      notificationDeliveryQueue, notificationDeliveryPremiumQueue, notificationDigestQueue,
      canonicalizeQueue, refreshCoverQueue, chapterIngestQueue, gapRecoveryQueue,
      getNotificationSystemHealth
    } from '@/lib/queues';
import { processPollSource } from './processors/poll-source.processor';
import { processChapterIngest } from './processors/chapter-ingest.processor';
import { processCheckSource } from './processors/check-source.processor';
import { processNotification } from './processors/notification.processor';
import { processNotificationDelivery } from './processors/notification-delivery.processor';
import { processNotificationDigest } from './processors/notification-digest.processor';
import { processCanonicalize } from './processors/canonicalize.processor';
import { processRefreshCover } from './processors/refresh-cover.processor';
import { processGapRecovery } from './processors/gap-recovery.processor';
import { runMasterScheduler } from './schedulers/master.scheduler';

console.log('[Workers] Starting...');

// Global process guards
process.on('uncaughtException', (error) => {
  console.error('[Workers] Uncaught Exception:', error);
  shutdown('uncaughtException').catch(() => process.exit(1));
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Workers] Unhandled Rejection at:', promise, 'reason:', reason);
  shutdown('unhandledRejection').catch(() => process.exit(1));
});

// Worker Initialization using Dedicated Worker Redis
let canonicalizeWorker: Worker | null = null;
canonicalizeWorker = new Worker(
  CANONICALIZE_QUEUE,
  processCanonicalize,
  { 
    connection: redisWorker,
    prefix: REDIS_KEY_PREFIX,
    concurrency: 2,
  }
);

let pollSourceWorker: Worker | null = null;
pollSourceWorker = new Worker(
  SYNC_SOURCE_QUEUE,
  processPollSource,
  { 
    connection: redisWorker,
    prefix: REDIS_KEY_PREFIX,
    concurrency: 20,
    limiter: {
      max: 10,
      duration: 1000,
    },
  }
);

let chapterIngestWorker: Worker | null = null;
chapterIngestWorker = new Worker(
  CHAPTER_INGEST_QUEUE,
  processChapterIngest,
  { 
    connection: redisWorker,
    prefix: REDIS_KEY_PREFIX,
    concurrency: 10,
  }
);

let checkSourceWorker: Worker | null = null;
checkSourceWorker = new Worker(
  CHECK_SOURCE_QUEUE,
  processCheckSource,
  { 
    connection: redisWorker,
    prefix: REDIS_KEY_PREFIX,
    concurrency: 2,
    limiter: {
      max: 3,
      duration: 1000,
    },
  }
);

let notificationWorker: Worker | null = null;
notificationWorker = new Worker(
  NOTIFICATION_QUEUE,
  processNotification,
  { 
    connection: redisWorker,
    prefix: REDIS_KEY_PREFIX,
    concurrency: 3,
  }
);

let notificationDeliveryWorker: Worker | null = null;
notificationDeliveryWorker = new Worker(
  NOTIFICATION_DELIVERY_QUEUE,
  processNotificationDelivery,
  { 
    connection: redisWorker,
    prefix: REDIS_KEY_PREFIX,
    concurrency: 5,
  }
);

let notificationDeliveryPremiumWorker: Worker | null = null;
notificationDeliveryPremiumWorker = new Worker(
  NOTIFICATION_DELIVERY_PREMIUM_QUEUE,
  processNotificationDelivery,
  { 
    connection: redisWorker,
    prefix: REDIS_KEY_PREFIX,
    concurrency: 15,
    limiter: {
      max: 1000,
      duration: 60000,
    },
  }
);

let notificationDigestWorker: Worker | null = null;
notificationDigestWorker = new Worker(
  NOTIFICATION_DIGEST_QUEUE,
  processNotificationDigest,
  { 
    connection: redisWorker,
    prefix: REDIS_KEY_PREFIX,
    concurrency: 1,
  }
);

let refreshCoverWorker: Worker | null = null;
refreshCoverWorker = new Worker(
  REFRESH_COVER_QUEUE,
  processRefreshCover,
  {
    connection: redisWorker,
    prefix: REDIS_KEY_PREFIX,
    concurrency: 5,
    limiter: {
      max: 5,
      duration: 1000,
    },
  }
);

let gapRecoveryWorker: Worker | null = null;
gapRecoveryWorker = new Worker(
  GAP_RECOVERY_QUEUE,
  processGapRecovery,
  {
    connection: redisWorker,
    prefix: REDIS_KEY_PREFIX,
    concurrency: 1,
  }
);

// Heartbeat interval
const HEARTBEAT_INTERVAL = 5 * 1000;
let heartbeatInterval: NodeJS.Timeout | null = null;

async function getSystemHealth() {
  const [notificationHealth, syncCounts, ingestCounts] = await Promise.all([
    getNotificationSystemHealth(),
    syncSourceQueue.getJobCounts('waiting', 'active'),
    chapterIngestQueue.getJobCounts('waiting', 'active'),
  ]);

  return {
    status: notificationHealth.isCritical ? 'unhealthy' : 'healthy',
    memory: process.memoryUsage(),
    uptime: process.uptime(),
    queues: {
      notifications: notificationHealth,
      sync: syncCounts,
      ingest: ingestCounts,
    },
    timestamp: new Date().toISOString()
  };
}

async function startHeartbeat() {
  const initialHealth = await getSystemHealth();
  await setWorkerHeartbeat(initialHealth);
  console.log('[Workers] Initial heartbeat sent');
  
  heartbeatInterval = setInterval(async () => {
    try {
      const health = await getSystemHealth();
      await setWorkerHeartbeat(health);
      console.log('[Workers] Heartbeat sent');
    } catch (error) {
      console.error('[Workers] Failed to send heartbeat:', error);
    }
  }, HEARTBEAT_INTERVAL);
}

// Scheduler interval
const SCHEDULER_INTERVAL = 5 * 60 * 1000;
const SCHEDULER_LOCK_KEY = `${REDIS_KEY_PREFIX}scheduler:lock`;
const SCHEDULER_LOCK_TTL = 360; 
const WORKER_GLOBAL_LOCK_KEY = `${REDIS_KEY_PREFIX}workers:global`;
const WORKER_GLOBAL_LOCK_TTL = 60;

let schedulerInterval: NodeJS.Timeout | null = null;
let globalLockHeartbeat: NodeJS.Timeout | null = null;

async function acquireGlobalLock(): Promise<boolean> {
  try {
    const result = await redisWorker.set(WORKER_GLOBAL_LOCK_KEY, process.pid.toString(), 'EX', WORKER_GLOBAL_LOCK_TTL, 'NX');
    if (result === 'OK') {
      globalLockHeartbeat = setInterval(async () => {
        try {
          await redisWorker.expire(WORKER_GLOBAL_LOCK_KEY, WORKER_GLOBAL_LOCK_TTL);
        } catch (error) {
          console.error('[Workers] Failed to extend global lock TTL:', error);
        }
      }, (WORKER_GLOBAL_LOCK_TTL / 2) * 1000);
      return true;
    }
    return false;
  } catch (error) {
    console.error('[Workers] Failed to acquire global lock:', error);
    return false;
  }
}

async function acquireSchedulerLock(): Promise<boolean> {
  try {
    const result = await redisWorker.set(SCHEDULER_LOCK_KEY, process.pid.toString(), 'EX', SCHEDULER_LOCK_TTL, 'NX');
    return result === 'OK';
  } catch (error) {
    console.error('[Scheduler] Failed to acquire lock:', error);
    return false;
  }
}

async function startScheduler() {
  console.log('[Scheduler] Starting master scheduler loop...');
  
  const runScheduler = async () => {
    const hasLock = await acquireSchedulerLock();
    if (hasLock) {
      try {
        await runMasterScheduler();
      } catch (error) {
        console.error('[Scheduler] Error in master scheduler:', error);
      }
    } else {
      console.log('[Scheduler] Another instance is already running the scheduler.');
    }
  };

  await runScheduler();
  schedulerInterval = setInterval(runScheduler, SCHEDULER_INTERVAL);
}

async function start() {
  try {
    const hasGlobalLock = await acquireGlobalLock();
    if (!hasGlobalLock) {
      console.error('[Workers] Another worker instance is already running. Exiting.');
      process.exit(1);
    }
    console.log('[Workers] Acquired global lock on dedicated Redis');

    await startHeartbeat();
    await startScheduler();
    
    console.log('[Workers] Started and listening on dedicated Redis');
  } catch (error) {
    console.error('[Workers] Fatal error during startup, cleaning up...', error);
    await shutdown('bootstrap_failure');
  }
}

async function shutdown(signal: string) {
  console.log(`[Workers] Received ${signal}, shutting down gracefully...`);
  
  try {
    await redisWorker.del(WORKER_GLOBAL_LOCK_KEY);
    console.log('[Workers] Global lock released');
  } catch (error) {
    console.error('[Workers] Failed to release global lock:', error);
  }

  if (heartbeatInterval) clearInterval(heartbeatInterval);
  if (globalLockHeartbeat) clearInterval(globalLockHeartbeat);
  if (schedulerInterval) clearInterval(schedulerInterval);

  await Promise.all([
    canonicalizeWorker?.close(),
    pollSourceWorker?.close(),
    chapterIngestWorker?.close(),
    checkSourceWorker?.close(),
    notificationWorker?.close(),
    notificationDeliveryWorker?.close(),
    notificationDeliveryPremiumWorker?.close(),
    notificationDigestWorker?.close(),
    refreshCoverWorker?.close(),
    gapRecoveryWorker?.close(),
  ].filter(Boolean));

  await Promise.all([
    syncSourceQueue.close(),
    checkSourceQueue.close(),
    notificationQueue.close(),
    notificationDeliveryQueue.close(),
    notificationDeliveryPremiumQueue.close(),
    notificationDigestQueue.close(),
    canonicalizeQueue.close(),
    refreshCoverQueue.close(),
    chapterIngestQueue.close(),
    gapRecoveryQueue.close(),
  ]);

  await disconnectRedis();
  
  console.log('[Workers] Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Worker event handlers
pollSourceWorker?.on('completed', (job) => console.log(`[PollSource] Job ${job.id} completed`));
pollSourceWorker?.on('failed', (job, err) => console.error(`[PollSource] Job ${job?.id} failed:`, err.message));
pollSourceWorker?.on('active', (job) => console.log(`[PollSource] Job ${job.id} started`));

chapterIngestWorker?.on('completed', (job) => console.log(`[ChapterIngest] Job ${job.id} completed`));
chapterIngestWorker?.on('failed', (job, err) => console.error(`[ChapterIngest] Job ${job?.id} failed:`, err.message));
chapterIngestWorker?.on('active', (job) => console.log(`[ChapterIngest] Job ${job.id} started`));

checkSourceWorker?.on('completed', (job) => console.log(`[CheckSource] Job ${job.id} completed`));
checkSourceWorker?.on('failed', (job, err) => console.error(`[CheckSource] Job ${job?.id} failed:`, err.message));
checkSourceWorker?.on('active', (job) => console.log(`[CheckSource] Job ${job.id} started`));

notificationWorker?.on('completed', (job) => console.log(`[Notification] Job ${job.id} completed`));
notificationWorker?.on('failed', (job, err) => console.error(`[Notification] Job ${job?.id} failed:`, err.message));

notificationDeliveryWorker?.on('completed', (job) => console.log(`[NotificationDelivery] Job ${job.id} completed`));
notificationDeliveryWorker?.on('failed', (job, err) => console.error(`[NotificationDelivery] Job ${job?.id} failed:`, err.message));
notificationDeliveryWorker?.on('active', (job) => console.log(`[NotificationDelivery] Job ${job.id} started`));

canonicalizeWorker?.on('completed', (job) => console.log(`[Canonicalize] Job ${job.id} completed`));
canonicalizeWorker?.on('failed', (job, err) => console.error(`[Canonicalize] Job ${job?.id} failed:`, err.message));
canonicalizeWorker?.on('active', (job) => console.log(`[Canonicalize] Job ${job.id} started`));

refreshCoverWorker?.on('completed', (job) => console.log(`[RefreshCover] Job ${job.id} completed`));
refreshCoverWorker?.on('failed', (job, err) => console.error(`[RefreshCover] Job ${job?.id} failed:`, err.message));
refreshCoverWorker?.on('active', (job) => console.log(`[RefreshCover] Job ${job.id} started`));

// Redis Self-Check
let failedPings = 0;
setInterval(async () => {
  try {
    const redisPing = await redisWorker.ping();
    if (redisPing === 'PONG') {
      failedPings = 0;
      return;
    }
    failedPings++;
  } catch (error) {
    failedPings++;
  }

  if (failedPings >= 3) {
    console.error('[Workers] Dedicated Redis unavailable – exiting');
    process.exit(1);
  }
}, 10000);

start().catch(error => {
  console.error('[Workers] Fatal error during startup:', error);
  process.exit(1);
});
