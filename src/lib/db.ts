import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
  __nexusPragmasApplied?: boolean
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['warn', 'error'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db

// ── v6.2 SQLite durability/perf pragmas (architecture review P2: WAL) ──
// The engine writes on every 4s tick (prices, price points, events) while
// readers poll continuously; the default rollback journal serializes writers
// against readers and occasionally surfaces "database is locked". WAL mode
// allows concurrent readers with a single writer. Applied once per process,
// best-effort — a failure here must never take the pulse down.
if (!globalForPrisma.__nexusPragmasApplied) {
  globalForPrisma.__nexusPragmasApplied = true
  void (async () => {
    try {
      await db.$queryRawUnsafe('PRAGMA journal_mode=WAL;')
      // NB: SQLite PRAGMAs RETURN a row, so every one must go through
      // $queryRawUnsafe — $executeRawUnsafe rejects statements that return
      // results ("Execute returned results, which is not allowed in SQLite").
      await db.$queryRawUnsafe('PRAGMA synchronous=NORMAL;')
      await db.$queryRawUnsafe('PRAGMA busy_timeout=5000;')
      console.log('[db] SQLite pragmas applied — journal_mode=WAL, synchronous=NORMAL, busy_timeout=5000')
    } catch (e) {
      console.error('[db] pragma application failed (continuing with defaults):', e)
    }
  })()
}
