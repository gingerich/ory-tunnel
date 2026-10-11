// The only place the tests touch the implementation. When the implementation
// changes shape (e.g. the Cloudflare Worker rewrite), update this adapter and
// leave the behavior tests alone.
import { newConfig, newHandler } from "../main.ts";

export type Env = Record<string, string | undefined>;
export type Proxy = (req: Request) => Promise<Response>;

export function createProxy(env: Env): Proxy {
  const denoEnv = { get: (key: string) => env[key] } as Parameters<
    typeof newConfig
  >[0];
  return newHandler(newConfig(denoEnv));
}
