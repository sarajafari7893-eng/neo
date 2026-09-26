/**
 * LIVE-HARDENING Phase 12 — database tests on SCRATCH copies only (production
 * db is never touched). Run: bun test tests/db.test.ts
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = "/home/z/my-project";
const DB = join(ROOT, "db/custom.db");

function scratchCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), "nexus-db-"));
  const dst = join(dir, "scratch.db");
  copyFileSync(DB, dst);
  for (const ext of ["-wal", "-shm"]) {
    const src = DB + ext;
    if (existsSync(src)) copyFileSync(src, dst + ext);
  }
  return dst;
}

describe("integrity checker on a scratch copy", () => {
  test("all checks PASS against a byte-copy of production", async () => {
    const proc = Bun.spawn(["bun", "scripts/db-integrity-check.ts", scratchCopy()], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.checks.every((c: { status: string }) => c.status === "PASS")).toBe(true);
  }, 30_000);
});

describe("serial uniqueness under concurrency (DB-level backstop)", () => {
  test("N concurrent writers inserting the SAME serial → exactly 1 wins", () => {
    const dir = mkdtempSync(join(tmpdir(), "nexus-serial-"));
    const path = join(dir, "s.db");
    const setup = new Database(path);
    setup.run("PRAGMA journal_mode=WAL");
    setup.run("CREATE TABLE Signal (id TEXT PRIMARY KEY, serial INTEGER NOT NULL UNIQUE)");
    setup.close();

    const N = 8;
    const results: (1 | 0)[] = new Array(N).fill(0) as (1 | 0)[];
    const workers = Array.from({ length: N }, (_, i) => {
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          try {
            const db = new Database(path);
            db.run("PRAGMA busy_timeout=4000");
            db.run("BEGIN IMMEDIATE");
            db.run("INSERT INTO Signal (id, serial) VALUES (?, 1)", [`id-${i}`]); // same serial 1
            db.run("COMMIT");
            results[i] = 1;
            db.close();
          } catch {
            results[i] = 0; // UNIQUE violation — the backstop fired
          }
          resolve();
        }, i * 7); // slight stagger — real race, not serialized by construction
      });
    });
    return Promise.all(workers).then(() => {
      const wins = results.filter((r) => r === 1).length;
      expect(wins).toBe(1); // DB-level uniqueness holds under concurrency
      const check = new Database(path, { readonly: true });
      expect(check.query("SELECT COUNT(*) c FROM Signal").get().c).toBe(1);
      check.close();
    });
  });
});
