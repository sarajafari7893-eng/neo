// ── FlowRadar Neo v10.5 ENGINE TERMINAL — resident-agent thought log ────────
// Operator mandate (2026-09-15): «بهتر است در ENGINE TERMINAL تمام اتفاقات و
// تفکرات ثبت شوند تا یک ایجنت در سندباکس مسئول پیگیری و نظارت باشد».
// SignalEvent already logs WHAT happened; AgentThought logs WHY the supervising
// agents judged it that way. This module is the write/read surface for both.
//
// Invariants:
//  - Append-only. No agent may edit or delete a thought (audit trail).
//  - Thoughts never mutate trading state — the terminal is observation-only;
//    any state change still has to go through governor/advisor approval paths.
//  - Every cron watchdog (run-watch, pace-watch, bridge-watch) and the
//    resident SUPERVISOR agent append here alongside worklog.md.

import { db } from "@/lib/db";
import type { AgentThought } from "@prisma/client";

export type AgentName = "SUPERVISOR" | "RUN-WATCH" | "PACE-WATCH" | "BRIDGE-WATCH" | "ENGINE";
export type ThoughtPhase = "observe" | "diagnose" | "propose" | "decide" | "act";

const MAX_THOUGHT_LEN = 4000;

export interface AppendThoughtInput {
  agent: AgentName | string;
  phase?: ThoughtPhase | string;
  thought: string;
  evidence?: unknown;
}

export async function appendThought(input: AppendThoughtInput): Promise<AgentThought> {
  const agent = String(input.agent || "SUPERVISOR").toUpperCase().slice(0, 40);
  const phase = String(input.phase || "observe").toLowerCase().slice(0, 20);
  const thought = String(input.thought || "").trim().slice(0, MAX_THOUGHT_LEN);
  if (!thought) throw new Error("thought text required");
  const evidence = JSON.stringify(input.evidence ?? {});
  return db.agentThought.create({ data: { agent, phase, thought, evidence } });
}

export interface TerminalEntry {
  id: string;
  ts: string;
  source: "THOUGHT" | "EVENT";
  agent?: string;
  phase?: string;
  kind?: string; // SignalEvent type
  level?: string; // SignalEvent level
  text: string;
  evidence?: unknown;
}

/** Merged terminal feed: agent thoughts + engine/system events, newest first. */
export async function terminalSnapshot(n = 60): Promise<{
  thoughts: number;
  events: number;
  agents: Record<string, number>;
  entries: TerminalEntry[];
}> {
  const take = Math.min(200, Math.max(1, n));
  const [thoughts, events, counts] = await Promise.all([
    db.agentThought.findMany({ orderBy: { createdAt: "desc" }, take }),
    db.signalEvent.findMany({
      where: { type: { in: ["ENGINE", "SYSTEM"] } },
      orderBy: { createdAt: "desc" },
      take,
    }),
    db.agentThought.groupBy({ by: ["agent"], _count: { agent: true } }),
  ]);

  const entries: TerminalEntry[] = [
    ...thoughts.map((t) => ({
      id: t.id,
      ts: t.createdAt.toISOString(),
      source: "THOUGHT" as const,
      agent: t.agent,
      phase: t.phase,
      text: t.thought,
      evidence: safeParse(t.evidence),
    })),
    ...events.map((e) => ({
      id: e.id,
      ts: e.createdAt.toISOString(),
      source: "EVENT" as const,
      kind: e.type,
      level: e.level,
      text: e.symbol ? `[${e.symbol}] ${e.message}` : e.message,
    })),
  ]
    .sort((a, b) => (a.ts < b.ts ? 1 : -1))
    .slice(0, take);

  const agents: Record<string, number> = {};
  for (const c of counts) agents[c.agent] = c._count.agent;

  return { thoughts: thoughts.length, events: events.length, agents, entries };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
