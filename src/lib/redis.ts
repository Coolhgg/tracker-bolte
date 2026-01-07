import Redis, { RedisOptions } from 'ioredis';

const environment = process.env.NODE_ENV || 'development';
export const REDIS_KEY_PREFIX = `kenmei:${environment}:`;

/**
 * Determines if Sentinel mode is enabled based on environment variables.
 * Sentinel is ONLY enabled when REDIS_SENTINEL_HOSTS is set.
 */
const isSentinelMode = !!process.env.REDIS_SENTINEL_HOSTS;

/**
 * Parse Sentinel hosts from env var.
 * Format: "host1:port1,host2:port2,host3:port3"
 */
function parseSentinelHosts(): Array<{ host: string; port: number }> {
  const hostsStr = process.env.REDIS_SENTINEL_HOSTS || '';
  if (!hostsStr) return [];
  
  return hostsStr.split(',').map(hostPort => {
    const [host, port] = hostPort.trim().split(':');
    return { host, port: parseInt(port, 10) || 26379 };
  });
}

/**
 * Build Redis connection options based on mode (single-node vs Sentinel).
 * @param url Optional explicit Redis URL. If not provided, defaults based on environment.
 */
export function buildRedisOptions(url?: string): RedisOptions {
  const baseOptions: RedisOptions = {
    maxRetriesPerRequest: null, // REQUIRED for BullMQ
    enableOfflineQueue: false,  // Fail fast if disconnected
    connectTimeout: 5000,
    retryStrategy: (times) => {
      if (times > 3) return null; // Stop retrying after 3 attempts to save connections
      return Math.min(times * 500, 2000);
    },
    reconnectOnError: (err) => {
      const targetErrors = ['READONLY', 'ECONNRESET', 'ETIMEDOUT'];
      return targetErrors.some(e => err.message.includes(e));
    },
  };

  if (isSentinelMode && !url) {
    // Sentinel mode configuration (only if no explicit URL is provided)
    const sentinels = parseSentinelHosts();
    const masterName = process.env.REDIS_SENTINEL_MASTER_NAME || 'mymaster';
    const sentinelPassword = process.env.REDIS_SENTINEL_PASSWORD || undefined;
    const redisPassword = process.env.REDIS_PASSWORD || undefined;

    console.log('[Redis] Sentinel mode enabled with %d sentinels, master: %s', sentinels.length, masterName);

    return {
      ...baseOptions,
      sentinels,
      name: masterName,
      sentinelPassword,
      password: redisPassword,
      enableReadyCheck: true,
      sentinelRetryStrategy: (times) => {
        if (times > 5) return null;
        return Math.min(times * 1000, 5000);
      },
      failoverDetector: true,
    };
  }

  // Single-node mode
  const redisUrl = url || process.env.REDIS_URL || 'redis://localhost:6379';
  const parsedUrl = new URL(redisUrl);

  return {
    ...baseOptions,
    host: parsedUrl.hostname,
    port: parseInt(parsedUrl.port) || 6379,
    password: parsedUrl.password || undefined,
    username: parsedUrl.username || undefined,
  };
}

/**
 * Singleton pattern for Next.js hot reload protection
 */
const globalForRedis = globalThis as unknown as { 
  redisApiClient: Redis | undefined;
  redisWorkerClient: Redis | undefined;
};

/**
 * Creates a configured Redis client.
 */
function createRedisClient(options: RedisOptions, name: string): Redis {
  const client = new Redis({
    ...options,
    lazyConnect: true,
  });

  client.on('error', (err) => {
    if (err.message.includes('ECONNREFUSED') || err.message.includes('ENOTFOUND')) {
      return;
    }
    console.error(`[Redis:${name}] Unexpected error:`, err.message);
  });

  client.on('connect', () => console.log(`[Redis:${name}] Connection initialized`));
  client.on('close', () => console.log(`[Redis:${name}] Connection closed`));
  client.on('ready', () => console.log(`[Redis:${name}] Ready to accept commands`));

  if (isSentinelMode && !options.host) {
    client.on('+switch-master', () => {
      console.log(`[Redis:${name} Sentinel] Master switch detected - reconnecting to new master`);
    });
  }

  return client;
}

// REDIS A: API + caching
export const redisApiClient = globalForRedis.redisApiClient ?? createRedisClient(
  { 
    ...buildRedisOptions(process.env.REDIS_API_URL || process.env.REDIS_URL),
    enableReadyCheck: true 
  },
  'API'
);

// REDIS B: Workers + BullMQ queues
export const redisWorkerClient = globalForRedis.redisWorkerClient ?? createRedisClient(
  { 
    ...buildRedisOptions(process.env.REDIS_WORKER_URL || process.env.REDIS_URL),
    enableReadyCheck: false // Requested for workers
  },
  'Worker'
);

// Default export for backward compatibility (points to API client)
export const redis = redisApiClient;

if (process.env.NODE_ENV !== 'production') {
  globalForRedis.redisApiClient = redisApiClient;
  globalForRedis.redisWorkerClient = redisWorkerClient;
}

/**
 * Connection options for BullMQ (uses Worker Redis).
 */
export const redisConnection: RedisOptions = buildRedisOptions(process.env.REDIS_WORKER_URL || process.env.REDIS_URL);

/**
 * Check if Redis is currently connected and responsive.
 */
export function isRedisAvailable(client: Redis = redisApiClient): boolean {
  return client.status === 'ready';
}

/**
 * Wait for Redis to be ready (with timeout).
 */
export async function waitForRedis(client: Redis = redisApiClient, timeoutMs: number = 3000): Promise<boolean> {
  if (client.status === 'ready') return true;
  if (client.status === 'end' || client.status === 'close') return false;
  
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    const onReady = () => { clearTimeout(timeout); client.off('error', onError); resolve(true); };
    const onError = () => { clearTimeout(timeout); client.off('ready', onReady); resolve(false); };
    client.once('ready', onReady);
    client.once('error', onError);
  });
}

/**
 * Check if workers are online (status stored in API Redis).
 */
export async function areWorkersOnline(): Promise<boolean> {
  const redisReady = await waitForRedis(redisApiClient, 3000);
  if (!redisReady) return false;
  
  try {
    const heartbeat = await redisApiClient.get(`${REDIS_KEY_PREFIX}workers:heartbeat`);
    if (!heartbeat) return false;
    
    const data = JSON.parse(heartbeat);
    const age = Date.now() - data.timestamp;
    return age < 15000;
  } catch (err) {
    console.error('[Redis] Error checking worker heartbeat:', err);
    return false;
  }
}

/**
 * Set worker heartbeat (stored in API Redis).
 */
export async function setWorkerHeartbeat(healthData?: any): Promise<void> {
  try {
    const payload = {
      timestamp: Date.now(),
      health: healthData || { status: 'healthy' },
      pid: process.pid,
    };
    await redisApiClient.set(`${REDIS_KEY_PREFIX}workers:heartbeat`, JSON.stringify(payload), 'EX', 10);
  } catch (err) {
    console.error('[Redis] Error setting worker heartbeat:', err);
    throw err;
  }
}

/**
 * Distributed lock using Worker Redis.
 */
export async function withLock<T>(
  lockKey: string,
  ttlMs: number,
  fn: () => Promise<T>
): Promise<T> {
  const fullLockKey = `${REDIS_KEY_PREFIX}lock:${lockKey}`;
  const lockValue = Math.random().toString(36).slice(2);
  const acquired = await redisWorkerClient.set(fullLockKey, lockValue, 'PX', ttlMs, 'NX');
  
  if (!acquired) throw new Error(`Failed to acquire lock: ${lockKey}`);
  
  try {
    return await fn();
  } finally {
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    await redisWorkerClient.eval(script, 1, fullLockKey, lockValue);
  }
}

/**
 * Safely disconnects from both Redis clients.
 */
export async function disconnectRedis(): Promise<void> {
  const disconnect = async (client: Redis, name: string) => {
    if (client.status === 'end') return;
    try {
      await client.quit();
      console.log(`[Redis:${name}] Disconnected`);
    } catch (err) {
      client.disconnect();
    }
  };

  await Promise.all([
    disconnect(redisApiClient, 'API'),
    disconnect(redisWorkerClient, 'Worker')
  ]);
}

export const redisMode = isSentinelMode ? 'sentinel' : 'single-node';
