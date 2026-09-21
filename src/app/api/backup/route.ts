import { NextResponse } from "next/server";
import { exec } from "child_process";
import { readFile, readdir } from "fs/promises";
import path from "path";
import { fireEvent } from "@/lib/engine";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const BACKUPS_DIR = "/home/z/my-project/backups";
const SCRIPT = "/home/z/my-project/scripts/backup.sh";

interface Manifest {
  file: string;
  createdAt: string;
  sizeHuman: string;
  snapshots: number;
  includes: string[];
}

/** GET /api/backup — snapshot status (latest manifest + listing) */
export async function GET() {
  try {
    let manifest: Manifest | null = null;
    try {
      manifest = JSON.parse(await readFile(path.join(BACKUPS_DIR, "latest.json"), "utf8")) as Manifest;
    } catch {
      manifest = null;
    }
    const files = (await readdir(BACKUPS_DIR).catch(() => [] as string[])).filter((f) => f.startsWith("nexus-snapshot-") && f.endsWith(".zip")).sort().reverse();
    return NextResponse.json({ manifest, files, retention: 12 });
  } catch (err) {
    console.error("[backup:GET]", err);
    return NextResponse.json({ error: "backup listing failed" }, { status: 500 });
  }
}

/** POST /api/backup — run scripts/backup.sh NOW (zip source+schema+db+worklog, retention 12) */
export async function POST() {
  try {
    const out = await new Promise<string>((resolve, reject) => {
      exec(`bash ${SCRIPT}`, { timeout: 90_000 }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve(String(stdout).trim());
      });
    });
    let manifest: Manifest | null = null;
    try {
      manifest = JSON.parse(await readFile(path.join(BACKUPS_DIR, "latest.json"), "utf8")) as Manifest;
    } catch {
      /* listing still works */
    }
    if (manifest) await fireEvent(null, null, "SYSTEM", "info", `Operator SNAPSHOT: ${manifest.file} (${manifest.sizeHuman}) zipped — ${manifest.snapshots} snapshots retained (source + schema + DB + worklog)`).catch(() => undefined);
    return NextResponse.json({ ok: true, log: out, manifest });
  } catch (err) {
    console.error("[backup:POST]", err);
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "backup failed" }, { status: 500 });
  }
}
