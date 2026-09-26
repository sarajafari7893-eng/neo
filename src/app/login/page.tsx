"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ShieldCheck, Loader2 } from "lucide-react";

/**
 * NEXUS//SIGNALS — operator login (LIVE-HARDENING Phase 2).
 * The credential is the operator control key (NEXUS_CONTROL_KEY).
 * On success, a 7-day HttpOnly session cookie authorizes control-plane
 * mutations from the dashboard. No key material is stored client-side.
 */
export default function LoginPage() {
  const router = useRouter();
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await signIn("nexus-key", { key, redirect: false });
      if (res?.error) {
        setError("کلید نامعتبر است");
        setBusy(false);
        return;
      }
      router.push("/");
      router.refresh();
    } catch {
      setError("خطای شبکه — دوباره تلاش کنید");
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <ShieldCheck className="h-6 w-6 text-primary" aria-hidden="true" />
          </div>
          <CardTitle className="text-xl">NEXUS//SIGNALS</CardTitle>
          <CardDescription>ورود اپراتور — کلید کنترل را وارد کنید</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <Input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="Control Key"
              autoComplete="current-password"
              aria-label="Control Key"
              required
              autoFocus
            />
            {error && (
              <p className="text-sm text-destructive text-center" role="alert">
                {error}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={busy || key.length === 0}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
              ورود
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
