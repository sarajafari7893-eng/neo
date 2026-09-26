import NextAuth, { type NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";

/**
 * NEXUS//SIGNALS — control-plane session auth (LIVE-HARDENING Phase 2).
 *
 * Security audit finding (Task P2, 2026-09-26): the previous middleware
 * fallback trusted a client-supplied `Origin` header matching `Host`, which
 * any non-browser client can forge (verified: POST /api/bridge/send with
 * forged Origin → 200 without the control key). Fix: mutations require
 * EITHER the x-nexus-key header (server-to-server) OR a NextAuth session
 * obtained by proving knowledge of NEXUS_CONTROL_KEY at /login.
 *
 * The credential IS the operator control key — single secret, no new
 * password surface. Sessions are JWT (edge-verifiable in middleware).
 * Token value is never logged or echoed.
 */

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      id: "nexus-key",
      name: "NEXUS Control Key",
      credentials: {
        key: { label: "Control Key", type: "password" },
      },
      async authorize(credentials) {
        const expected = process.env.NEXUS_CONTROL_KEY ?? "";
        const provided = credentials?.key ?? "";
        if (expected.length === 0 || provided.length === 0) return null;
        if (constantTimeEqual(provided, expected)) {
          return { id: "operator", name: "operator", role: "operator" };
        }
        return null;
      },
    }),
  ],
  session: {
    strategy: "jwt",
    maxAge: 7 * 24 * 3600, // 7 days — sandbox operator convenience
  },
  pages: {
    signIn: "/login",
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) token.role = (user as { role?: string }).role ?? "operator";
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        (session.user as { role?: string }).role = (token.role as string) ?? "operator";
      }
      return session;
    },
  },
  secret: process.env.NEXTAUTH_SECRET,
};

const handler = NextAuth(authOptions);

export { handler as GET, handler as POST };
