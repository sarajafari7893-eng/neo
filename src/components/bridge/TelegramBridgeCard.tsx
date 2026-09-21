"use client";

// ── TELEGRAM BRIDGE CARD — operator round 2026-09-11 ────────────────────────
// Two-way operator↔sandbox comms surface on the COMMAND DECK. Polls the
// bridge inbox (via /api/bridge → :3005), shows unread operator messages and
// a reply box that sends straight to the operator's Telegram chat.

import { useCallback, useEffect, useRef, useState } from "react";
import { Send, RefreshCw, CheckCheck, Radio } from "lucide-react";

interface BridgeMsg {
  id: number;
  from: string;
  username?: string;
  text: string;
  at: string;
  read: boolean;
}

interface BridgeData {
  ok: boolean;
  error?: string;
  unread: number;
  total: number;
  messages?: BridgeMsg[] | null; // relay error bodies may omit the array — never assume
}

const TEHRAN_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Tehran", hour: "2-digit", minute: "2-digit",
});

export default function TelegramBridgeCard() {
  const [data, setData] = useState<BridgeData | null>(null);
  const [offline, setOffline] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sentFlash, setSentFlash] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/bridge/inbox?n=8", { cache: "no-store" });
      const j = (await res.json()) as BridgeData;
      setData(j);
      setOffline(!j.ok);
    } catch {
      setOffline(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const res = await fetch("/api/bridge/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const j = (await res.json()) as { ok: boolean };
      if (j.ok) {
        setDraft("");
        setSentFlash(true);
        setTimeout(() => setSentFlash(false), 2500);
        await fetch("/api/bridge/read-all", { method: "POST" }).catch(() => undefined);
        void load();
      }
    } finally {
      setSending(false);
    }
  }, [draft, sending, load]);

  const markAllRead = useCallback(async () => {
    await fetch("/api/bridge/read-all", { method: "POST" }).catch(() => undefined);
    void load();
  }, [load]);

  const unread = data?.unread ?? 0;
  // v10.6.1 crash-fix: relay degradation returns error bodies without `messages`
  // (operator-reported console TypeError: Cannot read properties of undefined
  // (reading 'length')). Normalize once here — every render path uses `msgs`.
  const msgs = Array.isArray(data?.messages) ? data.messages : [];

  return (
    <section className="bento flex min-h-0 flex-col gap-3 p-4" aria-label="Telegram bridge — operator messages and reply">
      {/* header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-terminal text-[11px] tracking-[0.22em] text-ink-2">
          <Radio className="h-3.5 w-3.5 text-neon" aria-hidden />
          TELEGRAM BRIDGE
          <span className={offline ? "text-danger-neon" : "text-neon"} aria-hidden>
            ● {offline ? "OFFLINE" : "ARMED"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {unread > 0 && (
            <span className="rounded-full bg-danger-neon/15 px-2 py-0.5 font-terminal text-[10px] tracking-widest text-danger-neon" aria-label={`${unread} unread`}>
              {unread} UNREAD
            </span>
          )}
          <button
            onClick={markAllRead}
            title="Mark all read"
            className="rounded-md p-1 text-ink-3 transition-colors hover:bg-white/5 hover:text-neon"
            aria-label="Mark all bridge messages read"
          >
            <CheckCheck className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => void load()}
            title="Refresh inbox"
            className="rounded-md p-1 text-ink-3 transition-colors hover:bg-white/5 hover:text-neon"
            aria-label="Refresh bridge inbox"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* message list */}
      <div ref={listRef} className="max-h-72 min-h-[7rem] flex-1 space-y-1.5 overflow-y-auto pr-1" role="log" aria-live="polite">
        {!data && <div className="py-6 text-center font-terminal text-[10px] tracking-widest text-ink-3 anim-flicker">ESTABLISHING BRIDGE…</div>}
        {data && msgs.length === 0 && (
          <div className="py-6 text-center font-terminal text-[10px] tracking-widest text-ink-3">
            NO MESSAGES YET — TEXT THE BOT AND IT LANDS HERE
          </div>
        )}
        {msgs.map((m) => (
          <div
            key={m.id}
            className={`rounded-lg border px-3 py-2 text-xs leading-relaxed ${
              m.read
                ? "border-white/5 bg-white/[0.02] text-ink-2"
                : "border-neon/25 bg-neon/[0.06] text-ink-1"
            }`}
          >
            <div className="mb-0.5 flex items-center gap-2 font-terminal text-[9px] tracking-widest text-ink-3">
              {!m.read && <span className="inline-block h-1.5 w-1.5 rounded-full bg-danger-neon" aria-label="unread" />}
              <span className="text-neon/80">{m.username ? `@${m.username}` : m.from}</span>
              <span>{TEHRAN_TIME.format(new Date(m.at))} TEHRAN</span>
            </div>
            <div className="whitespace-pre-wrap break-words">{m.text}</div>
          </div>
        ))}
      </div>

      {/* reply box */}
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => { e.preventDefault(); void send(); }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="reply → operator telegram…"
          aria-label="Reply text to send via Telegram bridge"
          className="min-h-[44px] w-full rounded-lg border border-white/10 bg-black/30 px-3 font-terminal text-[11px] text-ink-1 outline-none transition-colors placeholder:text-ink-3 focus:border-neon/40"
          maxLength={4000}
        />
        <button
          type="submit"
          disabled={!draft.trim() || sending}
          aria-label="Send reply via Telegram bridge"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-neon/30 bg-neon/10 text-neon transition-all hover:bg-neon/20 disabled:cursor-not-allowed disabled:opacity-35"
        >
          {sending ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </button>
      </form>
      <div className="flex items-center justify-between font-terminal text-[9px] tracking-widest text-ink-3">
        <span>{sentFlash ? <span className="text-neon">SENT ✓ — DELIVERED TO OPERATOR CHAT</span> : "SANDBOX ⇄ @Neo_agentaibot · PERSISTED INBOX"}</span>
        <span>:3005</span>
      </div>
    </section>
  );
}
