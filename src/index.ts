// Reverse proxy that puts an Ory Network project behind our own domain, using
// the same Ory-Base-URL-Rewrite handshake as `ory proxy` / `ory tunnel`.

type Config = Readonly<{
  appOrigin: string; // e.g. https://auth.example.com
  oryOrigin: string; // e.g. https://my-project.projects.oryapis.com
  oryHost: string;
  apiKey: string;
}>;

function parseConfig(env: Env): Config {
  const missing = (["APPLICATION_ORIGIN", "ORY_PROJECT_HOST", "ORY_API_KEY"] as const)
    .filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`missing config: ${missing.join(", ")}`);
  }
  const oryHost = env.ORY_PROJECT_HOST;
  return {
    appOrigin: new URL(env.APPLICATION_ORIGIN).origin,
    oryOrigin: `https://${oryHost}`,
    oryHost,
    apiKey: env.ORY_API_KEY,
  };
}

function toOryRequest(req: Request, cfg: Config): Request {
  const { pathname, search } = new URL(req.url);
  const oryReq = new Request(cfg.oryOrigin + pathname + search, req);

  oryReq.headers.delete("Host");
  // Never let clients choose the rewrite target or token.
  for (const name of [...oryReq.headers.keys()]) {
    if (name.startsWith("ory-")) oryReq.headers.delete(name);
  }
  oryReq.headers.set("Ory-No-Custom-Domain-Redirect", "true");
  oryReq.headers.set("Ory-Base-URL-Rewrite", cfg.appOrigin);
  oryReq.headers.set("Ory-Base-URL-Rewrite-Token", cfg.apiKey);
  return oryReq;
}

function isTextual(contentType: string | null): boolean {
  const type = contentType?.split(";")[0].trim().toLowerCase() ?? "";
  return type.startsWith("text/") ||
    type === "application/json" || type.endsWith("+json") ||
    type === "application/javascript" ||
    type === "application/xml" || type.endsWith("+xml");
}

// Absolute redirects to Ory point back at us; relative and third-party
// redirects are left alone.
function rewriteLocation(location: string, cfg: Config): string {
  if (!URL.canParse(location)) return location;
  const url = new URL(location);
  if (url.origin !== cfg.oryOrigin) return location;
  return cfg.appOrigin + url.pathname + url.search + url.hash;
}

// Cookies Ory scopes to its own host, or a parent like oryapis.com, become
// host-only cookies for the proxy host by dropping the Domain attribute.
function rewriteSetCookie(cookie: string, cfg: Config): string {
  return cookie
    .split(";")
    .filter((part, i) => {
      if (i === 0) return true; // name=value
      const [name, value = ""] = part.split("=", 2);
      if (name.trim().toLowerCase() !== "domain") return true;
      const domain = value.trim().replace(/^\./, "").toLowerCase();
      return !(cfg.oryHost === domain || cfg.oryHost.endsWith(`.${domain}`));
    })
    .join(";");
}

async function fromOryResponse(res: Response, cfg: Config): Promise<Response> {
  const headers = new Headers(res.headers);

  const location = headers.get("Location");
  if (location !== null) {
    headers.set("Location", rewriteLocation(location, cfg));
  }

  const cookies = res.headers.getSetCookie();
  if (cookies.length > 0) {
    headers.delete("Set-Cookie");
    for (const cookie of cookies) {
      headers.append("Set-Cookie", rewriteSetCookie(cookie, cfg));
    }
  }

  let body: BodyInit | null = res.body;
  if (body !== null && isTextual(headers.get("Content-Type"))) {
    body = (await res.text()).replaceAll(cfg.oryOrigin, cfg.appOrigin);
    // The length changed. Content-Encoding stays: the Workers runtime has
    // already decoded the body and re-encodes it to match on the way out.
    headers.delete("Content-Length");
  }

  return new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

export default {
  async fetch(req, env): Promise<Response> {
    let cfg: Config;
    try {
      cfg = parseConfig(env);
    } catch (err) {
      console.error(err);
      return new Response("proxy misconfigured", { status: 500 });
    }

    const url = new URL(req.url);
    if (url.pathname === "/") {
      return Response.redirect(new URL("/ui", url).href, 303);
    }

    let res: Response;
    try {
      res = await fetch(toOryRequest(req, cfg), { redirect: "manual" });
    } catch (err) {
      console.error(err);
      return new Response("upstream unavailable", { status: 502 });
    }
    return fromOryResponse(res, cfg);
  },
} satisfies ExportedHandler<Env>;
