"use client";

// ── NEXUS//SIGNALS — control-plane client helper (Task 34-1, 2026-09-26) ─────
// Since LIVE-HARDENING Phase 2, every mutating /api/* call requires either the
// x-nexus-key header (server-to-server) or an operator session cookie (login
// at /login). Dashboard cards fire mutations from the BROWSER, so the session
// cookie is the only legitimate path — and when it is missing, the middleware
// answers 401 and cards used to surface a raw technical error with no path
// forward. This helper makes 401 a FIRST-CLASS UX state: a single toast with
// a login action, consistently, everywhere.

import { toast } from "sonner";

/** Thrown by nexusMutate when the middleware rejects the call (401/403). */
export class OperatorAuthRequiredError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(
      status === 401
        ? "برای اجرای دستورات، ابتدا به‌عنوان اپراتور وارد شوید"
        : "دسترسی مجاز نیست",
    );
    this.name = "OperatorAuthRequiredError";
    this.status = status;
  }
}

/**
 * Auth-aware mutating fetch for dashboard control cards.
 * - Sends JSON + same-origin cookies automatically (session-aware).
 * - On 401/403: raises OperatorAuthRequiredError AND shows the guided toast
 *   once per burst (toast dedupes identical messages anyway).
 * - On other non-ok: throws with the server's error message when present.
 * Returns the parsed JSON body on success.
 */
export async function nexusMutate<T = { ok?: boolean; error?: string }>(
  url: string,
  body: unknown,
  opts?: { method?: "POST" | "PUT" | "PATCH" | "DELETE" },
): Promise<T> {
  const res = await fetch(url, {
    method: opts?.method ?? "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
    cache: "no-store",
  });
  const payload = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (res.status === 401 || res.status === 403) {
    toast.error("برای اجرای دستورات ابتدا وارد شوید", {
      description: "کلید کنترل را در صفحه ورود وارد کنید — دکمه زیر را بزنید",
      action: {
        label: "ورود اپراتور",
        onClick: () => {
          window.location.href = "/login";
        },
      },
      duration: 12_000,
    });
    throw new OperatorAuthRequiredError(res.status);
  }
  if (!res.ok) {
    throw new Error(payload?.error ?? `HTTP ${res.status}`);
  }
  return payload;
}
