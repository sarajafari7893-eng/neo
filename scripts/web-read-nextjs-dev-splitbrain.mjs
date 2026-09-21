// web-read-nextjs-dev-splitbrain.mjs
// Follow-up: fetch key pages found by web-research-nextjs-dev-splitbrain.mjs to verify claims.
import ZAI from 'z-ai-web-dev-sdk';
import { writeFileSync } from 'node:fs';

const URLS = [
  { id: 'gh_65350_singleton', url: 'https://github.com/vercel/next.js/issues/65350' },
  { id: 'gh_26427_hmr', url: 'https://github.com/vercel/next.js/issues/26427' },
  { id: 'nextjs_local_dev', url: 'https://nextjs.org/docs/app/guides/local-development' },
  { id: 'prisma_globalthis', url: 'https://www.prisma.io/docs/orm/prisma-client/setup-and-configuration/instantiate-prisma-client' },
];

const strip = (h) => (h || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

async function main() {
  const zai = await ZAI.create();
  for (const { id, url } of URLS) {
    try {
      const res = await zai.functions.invoke('page_reader', { url });
      const d = res.data || res;
      const text = strip(d.html);
      writeFileSync(new URL(`../research-cache/read-${id}.txt`, import.meta.url), `${d.title}\n${url}\n${text}`);
      console.log(`[${id}] OK "${d.title}" len=${text.length}`);
    } catch (e) {
      console.error(`[${id}] FAIL ${e.message}`);
    }
  }
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
