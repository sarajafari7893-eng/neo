"use client";

// ── NEXUS//SIGNALS — operator session badge (Task 34-1, 2026-09-26) ──────────
// Control-plane mutations require an operator session (login at /login with
// the control key). Without this badge the dashboard gave NO signal that the
// desk was locked — buttons just failed with raw 401 toasts. Now the header
// always shows the auth state: LOCKED (amber — click to log in) or OPERATOR
// (neon — session live). Session state comes from the SessionProvider in
// providers.tsx; no key material is ever stored client-side.

import { useSession, signOut } from "next-auth/react";
import { LockKeyhole, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";

export function OperatorBadge() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const authed = status === "authenticated" && !!session?.user;
  const pending = status === "loading";

  if (pending) {
    return (
      <div
        className="hidden h-9 items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 font-terminal text-[10px] tracking-[0.12em] text-ink-3 md:flex"
        role="status"
      >
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-ink-3" aria-hidden />
        AUTH…
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        if (authed) {
          void signOut({ callbackUrl: "/" });
        } else {
          router.push("/login");
        }
      }}
      aria-label={
        authed
          ? "Operator session active — click to sign out"
          : "Desk locked — click to log in with the control key"
      }
      title={
        authed
          ? `جلسه اپراتور فعال (${session?.user?.name ?? "operator"}) — کلیک: خروج`
          : "میز فرمان قفل است — کلیک: ورود با کلید کنترل"
      }
      className={cn(
        "hidden h-9 items-center gap-1.5 rounded-lg border px-2.5 font-terminal text-[10px] font-bold tracking-[0.14em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon/60 md:flex",
        authed
          ? "border-[rgb(var(--neon-rgb)/0.35)] bg-[rgb(var(--neon-rgb)/0.06)] text-neon"
          : "border-[rgba(255,179,71,0.45)] bg-[rgba(255,179,71,0.08)] text-amber-neon hover:bg-[rgba(255,179,71,0.16)]",
      )}
    >
      {authed ? <ShieldCheck size={13} aria-hidden /> : <LockKeyhole size={13} aria-hidden />}
      {authed ? "OPERATOR" : "LOCKED"}
    </button>
  );
}
