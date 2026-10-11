// The only place the tests touch the implementation. When the implementation
// changes shape, update this adapter and leave the behavior tests alone.
import worker from "../src/index.ts";

export type Env = Record<string, string | undefined>;
export type Proxy = (req: Request) => Promise<Response>;

export function createProxy(env: Env): Proxy {
  return (req) => worker.fetch(req as Parameters<typeof worker.fetch>[0], env as unknown as Cloudflare.Env);
}
