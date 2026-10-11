import { afterEach, describe, expect, it, vi } from "vitest";
import { createProxy, type Env } from "./harness.ts";

const APP_HOST = "auth.example.com";
const APP_ORIGIN = `https://${APP_HOST}`;
const ORY_HOST = "test-project.projects.oryapis.com";
const ORY_ORIGIN = `https://${ORY_HOST}`;
const API_KEY = "ory_pat_test";

const ENV: Env = {
  APPLICATION_ORIGIN: APP_ORIGIN,
  ORY_PROJECT_HOST: ORY_HOST,
  ORY_API_KEY: API_KEY,
};

type Responder = Response | ((req: Request) => Response);

// Replaces global fetch with a fake Ory. Returns the requests it received.
function mockOry(respond: Responder = new Response("ok")): Request[] {
  const received: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      received.push(req);
      return typeof respond === "function" ? respond(req) : respond;
    }),
  );
  return received;
}

function proxy(input: string | Request, init?: RequestInit) {
  const req = typeof input === "string"
    ? new Request(new URL(input, APP_ORIGIN), init)
    : input;
  return createProxy(ENV)(req);
}

type Cookie = { name: string; value: string; attrs: Map<string, string> };

function parseSetCookie(header: string): Cookie {
  const [pair, ...rest] = header.split(";").map((s) => s.trim());
  const eq = pair.indexOf("=");
  const attrs = new Map(
    rest.map((attr) => {
      const i = attr.indexOf("=");
      return i === -1
        ? [attr.toLowerCase(), ""]
        : [attr.slice(0, i).toLowerCase(), attr.slice(i + 1)];
    }),
  );
  return { name: pair.slice(0, eq), value: pair.slice(eq + 1), attrs };
}

function cookiesOf(res: Response): Map<string, Cookie> {
  return new Map(
    res.headers.getSetCookie().map(parseSetCookie).map((c) => [c.name, c]),
  );
}

// Set-Cookie headers as Ory Network actually sends them (shapes taken from real responses).
const ORY_CSRF_COOKIE =
  `csrf_token_abc=csrf-value=; Path=/; Domain=${ORY_HOST}; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`;
const ORY_SESSION_COOKIE =
  `ory_session_test=session-value; Path=/; Domain=${ORY_HOST}; Expires=Mon, 11 Oct 2027 16:06:46 GMT; HttpOnly; Secure; SameSite=Lax`;
const CF_BM_COOKIE =
  "__cf_bm=cf-bm-value; HttpOnly; SameSite=None; Secure; Path=/; Domain=oryapis.com; Expires=Sun, 11 Oct 2026 16:36:45 GMT";
const CF_LB_COOKIE =
  "__cflb=cflb-value; HttpOnly; SameSite=Lax; Path=/; Expires=Sun, 11 Oct 2026 17:06:45 GMT";

function withCookies(...cookies: string[]): Response {
  const headers = new Headers();
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 204, headers });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("config", () => {
  it.each(["APPLICATION_ORIGIN", "ORY_PROJECT_HOST", "ORY_API_KEY"])(
    "refuses to proxy when %s is missing",
    async (missing) => {
      const received = mockOry();
      const env = { ...ENV, [missing]: undefined };

      let status: number | undefined;
      try {
        const res = await createProxy(env)(
          new Request(`${APP_ORIGIN}/sessions/whoami`),
        );
        status = res.status;
      } catch {
        // Failing at construction or request time are both acceptable.
      }

      expect(received).toHaveLength(0);
      if (status !== undefined) expect(status).toBeGreaterThanOrEqual(500);
    },
  );
});

describe("request forwarding", () => {
  it("forwards path and query to the Ory project over https", async () => {
    const received = mockOry();
    await proxy("/self-service/login/browser?return_to=https%3A%2F%2Fapp.example.com");

    expect(received).toHaveLength(1);
    expect(received[0].url).toBe(
      `${ORY_ORIGIN}/self-service/login/browser?return_to=https%3A%2F%2Fapp.example.com`,
    );
  });

  it("targets the Ory project regardless of the incoming scheme and port", async () => {
    // e.g. local dev at http://localhost:8787
    const received = mockOry();
    await proxy(new Request("http://localhost:8787/sessions/whoami"));

    expect(received[0].url).toBe(`${ORY_ORIGIN}/sessions/whoami`);
  });

  it("sends the base URL rewrite headers Ory needs", async () => {
    const received = mockOry();
    await proxy("/sessions/whoami");

    const h = received[0].headers;
    expect(h.get("Ory-No-Custom-Domain-Redirect")).toBe("true");
    expect(h.get("Ory-Base-URL-Rewrite")).toBe(APP_ORIGIN);
    expect(h.get("Ory-Base-URL-Rewrite-Token")).toBe(API_KEY);
  });

  it("does not let clients supply their own Ory-* rewrite headers", async () => {
    const received = mockOry();
    await proxy("/sessions/whoami", {
      headers: {
        "Ory-Base-URL-Rewrite": "https://evil.example",
        "Ory-Base-URL-Rewrite-Token": "stolen",
      },
    });

    const h = received[0].headers;
    expect(h.get("Ory-Base-URL-Rewrite")).toBe(APP_ORIGIN);
    expect(h.get("Ory-Base-URL-Rewrite-Token")).toBe(API_KEY);
  });

  it("forwards method, body, cookies and other headers", async () => {
    const received = mockOry();
    await proxy("/self-service/login?flow=abc", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Cookie": "csrf_token_abc=xyz; ory_session_test=abc",
        "Accept": "application/json",
      },
      body: "csrf_token=xyz&method=password&identifier=me%40example.com",
    });

    const req = received[0];
    expect(req.method).toBe("POST");
    expect(req.headers.get("Content-Type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(req.headers.get("Cookie")).toBe(
      "csrf_token_abc=xyz; ory_session_test=abc",
    );
    expect(req.headers.get("Accept")).toBe("application/json");
    expect(await req.text()).toBe(
      "csrf_token=xyz&method=password&identifier=me%40example.com",
    );
  });

  it("passes upstream redirects back to the browser instead of following them", async () => {
    const received = mockOry(
      new Response(null, {
        status: 303,
        headers: { Location: `${ORY_ORIGIN}/ui/login?flow=abc` },
      }),
    );
    const res = await proxy("/self-service/login/browser");

    expect(received[0].redirect).toBe("manual");
    expect(res.status).toBe(303);
  });

  it("redirects / to the account UI without calling Ory", async () => {
    const received = mockOry();
    const res = await proxy("/");

    expect(received).toHaveLength(0);
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("Location")!, APP_ORIGIN).pathname).toBe(
      "/ui",
    );
  });
});

describe("response passthrough", () => {
  it("preserves status, headers and body", async () => {
    mockOry(
      new Response('{"error":{"code":401}}', {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "private, no-cache",
          "X-Request-Id": "req-123",
        },
      }),
    );
    const res = await proxy("/sessions/whoami");

    expect(res.status).toBe(401);
    expect(res.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(res.headers.get("X-Request-Id")).toBe("req-123");
    expect(await res.json()).toEqual({ error: { code: 401 } });
  });

  it("handles empty bodies", async () => {
    mockOry(new Response(null, { status: 204 }));
    const res = await proxy("/self-service/logout?token=abc");

    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("leaves binary bodies byte-for-byte intact", async () => {
    // Contains the upstream origin as ASCII; must not be rewritten.
    const bytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x00, 0xff,
      ...new TextEncoder().encode(ORY_ORIGIN),
      0x00, 0xfe,
    ]);
    mockOry(new Response(bytes, { headers: { "Content-Type": "image/png" } }));
    const res = await proxy("/ui/logo.png");

    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });
});

describe("body rewriting", () => {
  it("rewrites the Ory origin in HTML", async () => {
    mockOry(
      new Response(
        `<form action="${ORY_ORIGIN}/self-service/login?flow=abc"><a href="${ORY_ORIGIN}/ui/registration">`,
        { headers: { "Content-Type": "text/html; charset=utf-8" } },
      ),
    );
    const res = await proxy("/ui/login?flow=abc");
    const body = await res.text();

    expect(body).toBe(
      `<form action="${APP_ORIGIN}/self-service/login?flow=abc"><a href="${APP_ORIGIN}/ui/registration">`,
    );
  });

  it("rewrites the Ory origin in JSON", async () => {
    mockOry(
      new Response(
        JSON.stringify({
          request_url: `${ORY_ORIGIN}/self-service/login/api`,
          ui: { action: `${ORY_ORIGIN}/self-service/login?flow=abc` },
        }),
        { headers: { "Content-Type": "application/json; charset=utf-8" } },
      ),
    );
    const res = await proxy("/self-service/login/api");

    expect(await res.json()).toEqual({
      request_url: `${APP_ORIGIN}/self-service/login/api`,
      ui: { action: `${APP_ORIGIN}/self-service/login?flow=abc` },
    });
  });

  it("does not send a stale Content-Length after rewriting", async () => {
    const original = `<a href="${ORY_ORIGIN}/ui/login">login</a>`;
    mockOry(
      new Response(original, {
        headers: {
          "Content-Type": "text/html",
          "Content-Length": String(new TextEncoder().encode(original).length),
        },
      }),
    );
    const res = await proxy("/ui/welcome");
    const actual = new Uint8Array(await res.arrayBuffer()).length;

    const declared = res.headers.get("Content-Length");
    if (declared !== null) expect(Number(declared)).toBe(actual);
  });
});

describe("Location rewriting", () => {
  function redirectTo(location: string) {
    mockOry(new Response(null, { status: 303, headers: { Location: location } }));
    return proxy("/self-service/login/browser");
  }

  it("rewrites absolute redirects to the Ory origin", async () => {
    const res = await redirectTo(`${ORY_ORIGIN}/ui/login?flow=abc`);
    expect(res.headers.get("Location")).toBe(`${APP_ORIGIN}/ui/login?flow=abc`);
  });

  it("leaves relative redirects alone", async () => {
    // Ory's /ui/login really does this.
    const loc = "../self-service/login/browser?aal=&refresh=&return_to=";
    const res = await redirectTo(loc);
    expect(res.headers.get("Location")).toBe(loc);
  });

  it("leaves third-party redirects pointing at the third party", async () => {
    const loc =
      "https://github.com/login/oauth/authorize?client_id=x&state=y";
    const res = await redirectTo(loc);
    expect(res.headers.get("Location")).toBe(loc);
  });
});

describe("Set-Cookie rewriting", () => {
  it("keeps every cookie intact, including Expires dates containing commas", async () => {
    mockOry(
      withCookies(ORY_CSRF_COOKIE, ORY_SESSION_COOKIE, CF_BM_COOKIE, CF_LB_COOKIE),
    );
    const res = await proxy("/self-service/login?flow=abc", { method: "POST" });
    const cookies = cookiesOf(res);

    expect([...cookies.keys()].sort()).toEqual(
      ["__cf_bm", "__cflb", "csrf_token_abc", "ory_session_test"],
    );
    const session = cookies.get("ory_session_test")!;
    expect(session.value).toBe("session-value");
    expect(session.attrs.get("expires")).toBe("Mon, 11 Oct 2027 16:06:46 GMT");
    expect(session.attrs.get("path")).toBe("/");
    expect(session.attrs.has("httponly")).toBe(true);
    expect(session.attrs.has("secure")).toBe(true);
    expect(session.attrs.get("samesite")?.toLowerCase()).toBe("lax");
  });

  it("scopes cookies for the Ory project host to the proxy host", async () => {
    mockOry(withCookies(ORY_CSRF_COOKIE));
    const res = await proxy("/self-service/login/browser");
    const csrf = cookiesOf(res).get("csrf_token_abc")!;

    // Either host-only (no Domain) or exactly the proxy host.
    expect([undefined, APP_HOST, `.${APP_HOST}`]).toContain(
      csrf.attrs.get("domain"),
    );
    expect(csrf.value).toBe("csrf-value=");
    expect(csrf.attrs.get("max-age")).toBe("31536000");
  });

  it("does not widen Ory's parent-domain cookies to the whole parent domain", async () => {
    mockOry(withCookies(CF_BM_COOKIE));
    const res = await proxy("/sessions/whoami");
    const cfbm = cookiesOf(res).get("__cf_bm")!;

    expect([undefined, APP_HOST, `.${APP_HOST}`]).toContain(
      cfbm.attrs.get("domain"),
    );
  });

  it("leaves host-only cookies unchanged", async () => {
    mockOry(withCookies(CF_LB_COOKIE));
    const res = await proxy("/sessions/whoami");

    expect(res.headers.getSetCookie()).toEqual([CF_LB_COOKIE]);
  });
});
