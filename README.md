# ory-tunnel

Cloudflare Worker that serves an Ory Network project from `id.gingerich.io`,
standing in for Ory's paid custom domain feature. It proxies to the project and
rewrites Ory URLs, redirects and cookie domains back to our origin.

Config lives in `wrangler.jsonc`; the Ory API key is a Worker secret, sourced
from 1Password via the reference in `.env.op` (`ORY_API_KEY="op://..."`).

```sh
devbox shell          # provides node
npm install
npm test              # behavior tests (test/proxy.test.ts)
npm run typecheck
npm run dev           # local proxy on http://localhost:8787
npx wrangler login    # once
npm run secrets       # push ORY_API_KEY from 1Password
npm run deploy
```
