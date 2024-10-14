type Config = Readonly<{
  port: number;
  appOrigin: string;
  ory: Readonly<{
    projectHost: string;
    apiKey: string;
  }>;
}>;

function newConfig(env: Deno.Env): Config {
  const port = parseInt(env.get("PORT") ?? "8080");
  const appOrigin = env.get("APPLICATION_ORIGIN") ?? "";
  const oryProjectHost = env.get("ORY_PROJECT_HOST") ?? "";
  const oryApiKey = env.get("ORY_API_KEY") ?? "";

  return {
    port,
    appOrigin,
    ory: {
      projectHost: oryProjectHost,
      apiKey: oryApiKey,
    },
  };
}

async function rewriteBody(
  res: Response,
  upstreamHost: string,
  newOrigin: string,
) {
  if (res.body == null) {
    return null;
  }
  const contentType = res.headers.get("Content-Type");
  if (contentType === null || !contentType.startsWith("text/")) {
    return res.body;
  }
  const content = await res.text();
  return content.replaceAll(upstreamHost, newOrigin);
}

function rewriteCookieDomain(
  headers: Headers,
  upstreamURL: URL,
  newURL: URL,
) {
  // order matters: broadest to narrowest
  const cookieRewriters = [
    (url: URL) => url.host,
    (url: URL) => url.host.split(".").slice(-2).join(".")
  ]
  const setCookieHeader = headers.get("Set-Cookie");
  if (setCookieHeader === null) {
    return;
  }
  headers.delete("Set-Cookie");
  setCookieHeader.split(",").forEach((cookie) => {
    headers.append(
      "Set-Cookie",
      cookieRewriters.reduce((result, getURLComponent) => {
        return result.replaceAll(
          encodeURIComponent(getURLComponent(upstreamURL)),
          encodeURIComponent(getURLComponent(newURL))
        )
      }, cookie.trimStart())
    );
  });
}

function rewriteLocation(
  headers: Headers,
  upstreamHost: string,
  newOrigin: string,
) {
  const locationHeader = headers.get("Location");
  if (locationHeader === null) {
    return;
  }
  headers.set("Location", locationHeader.replace(upstreamHost, newOrigin));
}

function newRequestRewriter(cfg: Config): (r: Request) => Request {
  return (req: Request): Request => {
    const url = new URL(req.url);
    url.hostname = cfg.ory.projectHost;
    const proxyReq = new Request(url, req);
    proxyReq.headers.set("Ory-No-Custom-Domain-Redirect", "true");
    proxyReq.headers.set("Ory-Base-URL-Rewrite", cfg.appOrigin);
    proxyReq.headers.set("Ory-Base-URL-Rewrite-Token", cfg.ory.apiKey);
    proxyReq.headers.set("Ory-Network-Ingress", "T")
    return proxyReq;
  };
}

function newResponseRewriter(
  upstreamHost: string,
  newOrigin: string,
): (res: Response) => Promise<Response> {
  return async (r: Response) => {
    const upstreamURL = new URL(`https://${upstreamHost}`);

    const body = await rewriteBody(r, upstreamURL.origin, newOrigin);
    const res = new Response(body, r);

    if (res.headers.has("Set-Cookie")) {
      const newURL = new URL(newOrigin);
      rewriteCookieDomain(res.headers, upstreamURL, newURL);
    }
    if (res.headers.has("Location")) {
      rewriteLocation(res.headers, upstreamURL.origin, newOrigin);
    }

    return res;
  };
}

type HTTPHandler = (req: Request) => Promise<Response>;

function newHandler(cfg: Config): HTTPHandler {
  const rewriteRequest = newRequestRewriter(cfg);
  const rewriteResponse = newResponseRewriter(
    cfg.ory.projectHost,
    cfg.appOrigin,
  );

  return async (req: Request) => {
    const url = new URL(req.url)
    if (url.pathname === "/") {
      url.pathname = "/ui"
      return Response.redirect(url, 303)
    }

    const proxyReq = rewriteRequest(req);
    const res = await fetch(proxyReq, { redirect: "manual" });
    return rewriteResponse(res);
  };
}

// Learn more at https://docs.deno.com/runtime/manual/examples/module_metadata#concepts
if (import.meta.main) {
  const cfg = newConfig(Deno.env);
  const handler = newHandler(cfg);

  Deno.serve({ port: cfg.port }, handler);
}
