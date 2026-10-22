import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Issue #277: an in-memory fake standing in for ioredis, so these tests never
// need a real Redis instance (matching this repo's stance that Redis is
// strictly optional for local dev / CI). Mocked at the module level, before
// importing src/cache/redis.js, so the module's own `new Redis(...)` picks
// this up instead of opening a real socket.
const store = new Map<string, string>()

class FakeRedis {
  static shouldFailConnection = false
  // Issue #348: lets tests inspect the options the module passed to ioredis
  // (retryStrategy) and drive connection events on the live instance.
  static instances: FakeRedis[] = []
  static lastOptions: { retryStrategy?: (times: number) => number | null | undefined } | undefined

  constructor(_url: string, opts?: { retryStrategy?: (times: number) => number | null | undefined }) {
    FakeRedis.instances.push(this)
    FakeRedis.lastOptions = opts
    if (FakeRedis.shouldFailConnection) {
      // Simulate a client that immediately errors on first use, the way a
      // refused connection would.
      queueMicrotask(() => this.emitError())
    }
  }

  private listeners: Record<string, ((err: unknown) => void)[]> = {}

  on(event: string, cb: (err: unknown) => void): this {
    this.listeners[event] ??= []
    this.listeners[event].push(cb)
    return this
  }

  emit(event: string, arg?: unknown): void {
    for (const cb of this.listeners[event] ?? []) cb(arg)
  }

  private emitError(): void {
    this.emit('error', new Error('ECONNREFUSED (fake)'))
  }

  async get(key: string): Promise<string | null> {
    if (FakeRedis.shouldFailConnection) throw new Error('ECONNREFUSED (fake)')
    return store.has(key) ? store.get(key)! : null
  }

  async set(key: string, value: string, _ex: 'EX', _ttl: number): Promise<'OK'> {
    if (FakeRedis.shouldFailConnection) throw new Error('ECONNREFUSED (fake)')
    store.set(key, value)
    return 'OK'
  }

  async del(...keys: string[]): Promise<number> {
    let n = 0
    for (const k of keys) {
      if (store.delete(k)) n++
    }
    return n
  }

  async scan(_cursor: string, _match: 'MATCH', pattern: string, _count: 'COUNT', _n: number): Promise<[string, string[]]> {
    const re = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$')
    return ['0', [...store.keys()].filter((k) => re.test(k))]
  }

  disconnect(): void {}
}

vi.mock('ioredis', () => ({ default: FakeRedis }))

describe('cache/redis', () => {
  beforeEach(async () => {
    vi.resetModules()
    store.clear()
    FakeRedis.shouldFailConnection = false
    FakeRedis.instances = []
    FakeRedis.lastOptions = undefined
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('no-ops and always calls the fetcher when REDIS_URL is not configured', async () => {
    vi.doMock('../src/config.js', () => ({
      config: { cache: { redisUrl: undefined, memberCacheTtlSeconds: 30 } },
    }))
    const { getOrSetCache } = await import('../src/cache/redis.js')

    const fetcher = vi.fn().mockResolvedValue({ hello: 'world' })
    const result1 = await getOrSetCache('k', 30, fetcher)
    const result2 = await getOrSetCache('k', 30, fetcher)

    expect(result1).toEqual({ hello: 'world' })
    expect(result2).toEqual({ hello: 'world' })
    // No caching happened at all — every call re-invokes the fetcher.
    expect(fetcher).toHaveBeenCalledTimes(2)
    // And nothing was ever written to the fake Redis store.
    expect(store.size).toBe(0)
  })

  it('cache miss calls the fetcher and populates the cache', async () => {
    vi.doMock('../src/config.js', () => ({
      config: { cache: { redisUrl: 'redis://fake:6379', memberCacheTtlSeconds: 30 } },
    }))
    const { getOrSetCache } = await import('../src/cache/redis.js')

    const fetcher = vi.fn().mockResolvedValue({ n: 1 })
    const result = await getOrSetCache('members:list:50', 30, fetcher)

    expect(result).toEqual({ n: 1 })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(store.get('members:list:50')).toBe(JSON.stringify({ n: 1 }))
  })

  it('cache hit avoids the fetcher', async () => {
    vi.doMock('../src/config.js', () => ({
      config: { cache: { redisUrl: 'redis://fake:6379', memberCacheTtlSeconds: 30 } },
    }))
    const { getOrSetCache } = await import('../src/cache/redis.js')

    const fetcher = vi.fn().mockResolvedValue({ n: 1 })
    await getOrSetCache('members:list:50', 30, fetcher)
    const second = await getOrSetCache('members:list:50', 30, fetcher)

    expect(second).toEqual({ n: 1 })
    // Only the first call actually hit the fetcher — the second was served
    // from the fake store.
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('invalidation clears the specific key', async () => {
    vi.doMock('../src/config.js', () => ({
      config: { cache: { redisUrl: 'redis://fake:6379', memberCacheTtlSeconds: 30 } },
    }))
    const { getOrSetCache, invalidateCache, memberSummaryCacheKey } = await import('../src/cache/redis.js')

    const address = 'GABC'
    const fetcher = vi.fn().mockResolvedValue({ member: address })
    await getOrSetCache(memberSummaryCacheKey(address), 30, fetcher)
    expect(store.has(memberSummaryCacheKey(address))).toBe(true)

    await invalidateCache(memberSummaryCacheKey(address))
    expect(store.has(memberSummaryCacheKey(address))).toBe(false)

    // A subsequent read is a fresh cache miss.
    await getOrSetCache(memberSummaryCacheKey(address), 30, fetcher)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('invalidateMembersListCache clears every cached limit', async () => {
    vi.doMock('../src/config.js', () => ({
      config: { cache: { redisUrl: 'redis://fake:6379', memberCacheTtlSeconds: 30 } },
    }))
    const { getOrSetCache, invalidateMembersListCache, membersListCacheKey } = await import('../src/cache/redis.js')

    await getOrSetCache(membersListCacheKey(50), 30, vi.fn().mockResolvedValue([1]))
    await getOrSetCache(membersListCacheKey(200), 30, vi.fn().mockResolvedValue([2]))
    expect(store.size).toBe(2)

    await invalidateMembersListCache()
    expect(store.size).toBe(0)
  })

  it('degrades to calling the fetcher when Redis is unreachable, without throwing', async () => {
    vi.doMock('../src/config.js', () => ({
      config: { cache: { redisUrl: 'redis://fake:6379', memberCacheTtlSeconds: 30 } },
    }))
    FakeRedis.shouldFailConnection = true
    const { getOrSetCache } = await import('../src/cache/redis.js')

    const fetcher = vi.fn().mockResolvedValue({ ok: true })
    await expect(getOrSetCache('some-key', 30, fetcher)).resolves.toEqual({ ok: true })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('keeps reconnecting with a capped backoff instead of giving up (issue #348)', async () => {
    vi.doMock('../src/config.js', () => ({
      config: { cache: { redisUrl: 'redis://fake:6379', memberCacheTtlSeconds: 30 } },
    }))
    const { getOrSetCache } = await import('../src/cache/redis.js')
    await getOrSetCache('members:list:50', 30, vi.fn().mockResolvedValue([]))

    const retryStrategy = FakeRedis.lastOptions?.retryStrategy
    expect(retryStrategy).toBeTypeOf('function')
    expect(retryStrategy!(1)).toBe(200)
    expect(retryStrategy!(5)).toBe(1000)
    // Never null (that would stop reconnection for good), and never above the cap.
    expect(retryStrategy!(1000)).toBe(5000)
  })

  it('resumes caching after a Redis restart and logs the next outage again (issue #348)', async () => {
    vi.doMock('../src/config.js', () => ({
      config: { cache: { redisUrl: 'redis://fake:6379', memberCacheTtlSeconds: 30 } },
    }))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { getOrSetCache } = await import('../src/cache/redis.js')
      // The shared client is created lazily on first use, so warm it up first.
      await getOrSetCache('warm', 30, vi.fn().mockResolvedValue(1))
      const redis = FakeRedis.instances[0]

      // First outage: fallback to fetcher, logged once.
      FakeRedis.shouldFailConnection = true
      const fetcher = vi.fn().mockResolvedValue({ n: 2 })
      await getOrSetCache('members:list:50', 30, fetcher)
      await getOrSetCache('members:list:50', 30, fetcher)
      expect(fetcher).toHaveBeenCalledTimes(2)
      expect(errorSpy).toHaveBeenCalledTimes(1)

      // Redis returns: ioredis emits `ready`, which re-arms the log-once flag.
      FakeRedis.shouldFailConnection = false
      redis!.emit('ready')
      await getOrSetCache('members:list:50', 30, fetcher)
      expect(store.has('members:list:50')).toBe(true)
      // Cache hits resume: the fetcher is not called again.
      const cached = await getOrSetCache('members:list:50', 30, fetcher)
      expect(cached).toEqual({ n: 2 })
      expect(fetcher).toHaveBeenCalledTimes(3)

      // Second outage is logged again, not swallowed by the earlier one.
      FakeRedis.shouldFailConnection = true
      await getOrSetCache('members:list:50', 30, fetcher)
      expect(errorSpy).toHaveBeenCalledTimes(2)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('reindexFromEventLog and replayFailedEvent invalidate member and summary caches', async () => {
    vi.doMock('../src/config.js', () => (
      {
        config: {
          cache: { redisUrl: 'redis://fake:6379', memberCacheTtlSeconds: 30 },
          stellar: { contractId: 'CTEST', contractIds: ['CTEST'] },
        },
      }
    ))
    const { getOrSetCache, membersListCacheKey, memberSummaryCacheKey } = await import('../src/cache/redis.js')
    const { reindexFromEventLog } = await import('../src/indexer/reindex.js')
    const { replayFailedEvent } = await import('../src/indexer/replay.js')
    const { pool, query } = await import('../src/db/index.js')
    const { decodedEvent } = await import('./fixtures.js')
    const { resetDb } = await import('./db.js')

    await resetDb()

    // Populate cache entries
    await getOrSetCache(membersListCacheKey(50), 30, vi.fn().mockResolvedValue([{ address: 'G1' }]))
    const sumKey = memberSummaryCacheKey('G1')
    await getOrSetCache(sumKey, 30, vi.fn().mockResolvedValue({ address: 'G1', joined: true }))

    expect(store.has(membersListCacheKey(50))).toBe(true)
    expect(store.has(sumKey)).toBe(true)

    // Insert a dummy event so reindex has something to process
    const ev = decodedEvent('joined', { member: 'G1', fee: '100' }, { id: '0000000001-000000-00000001', ledger: 1 })
    await query(
      `INSERT INTO events (id, ledger, closed_at, contract_id, symbol, topics, data, tx_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [ev.id, ev.ledger, ev.closedAt, ev.contractId, ev.symbol, JSON.stringify(ev.topics), JSON.stringify(ev.data), ev.txHash]
    )

    await reindexFromEventLog()
    // reindexFromEventLog should invalidate members list cache
    expect(store.has(membersListCacheKey(50))).toBe(false)

    // Re-populate caches for replay test
    await getOrSetCache(membersListCacheKey(50), 30, vi.fn().mockResolvedValue([{ address: 'G1' }]))
    await getOrSetCache(sumKey, 30, vi.fn().mockResolvedValue({ address: 'G1', joined: true }))
    expect(store.has(membersListCacheKey(50))).toBe(true)
    expect(store.has(sumKey)).toBe(true)

    // Insert a failed event record pointing to our event
    await query(
      `INSERT INTO failed_events (contract_id, event_id, symbol, ledger, error, resolved_at)
       VALUES ($1, $2, $3, $4, $5, NULL)`,
      [ev.contractId, ev.id, ev.symbol, ev.ledger, 'some error']
    )

    const outcome = await replayFailedEvent(ev.id)
    expect(outcome.status).toBe('replayed')

    // replayFailedEvent should invalidate both members list cache and member summary cache for membership-modifying events ('joined')
    expect(store.has(membersListCacheKey(50))).toBe(false)
    expect(store.has(sumKey)).toBe(false)
  })
})
