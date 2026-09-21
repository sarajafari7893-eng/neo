// web-research-nextjs-dev-splitbrain.mjs
// Research: Next.js 15/16 dev-mode multi-worker module-state split-brain + route-specific hangs.
// Runs 5 web searches via z-ai-web-dev-sdk, saves full results to research-cache/.
// Usage: node scripts/web-research-nextjs-dev-splitbrain.mjs
import ZAI from 'z-ai-web-dev-sdk';
import { writeFileSync, mkdirSync } from 'node:fs';

const QUERIES = [
  { id: 'q01_workers', q: 'Next.js dev mode multiple workers module state inconsistent API routes' },
  { id: 'q02_hmr_singleton', q: 'Next.js dev server in-memory singleton state reset hot reload worker globalThis' },
  { id: 'q03_slow_route', q: 'Next.js API route slow intermittent timeout dev mode other routes fast' },
  { id: 'q04_persist_state', q: 'Next.js persistent in-memory state best practice file-backed store write-through singleton' },
  { id: 'q05_compile_hang', q: 'Next.js dev server hang specific API route compile on demand worker turbopack' },
];

async function main() {
  const zai = await ZAI.create();
  mkdirSync(new URL('../research-cache/', import.meta.url), { recursive: true });
  const out = {};
  for (const { id, q } of QUERIES) {
    let attempt = 0, results = null;
    while (attempt < 3 && !results) {
      try {
        results = await zai.functions.invoke('web_search', { query: q, num: 8 });
        if (!Array.isArray(results) || results.length === 0) { results = null; throw new Error('empty'); }
      } catch (e) {
        attempt++; console.error(`[${id}] attempt ${attempt} failed: ${e.message}`);
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
    out[id] = { query: q, results: (results || []).map(r => ({ url: r.url, name: r.name, snippet: r.snippet, host: r.host_name, date: r.date })) };
    console.log(`[${id}] ${out[id].results.length} results`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = new URL(`../research-cache/nextjs-dev-splitbrain-${stamp}.json`, import.meta.url);
  writeFileSync(file, JSON.stringify(out, null, 2));
  console.log('saved:', file.pathname);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
