import http from "node:http";
import { timingSafeEqual, createHmac } from "node:crypto";
import { createAccountService, secret, fail } from "./service.mjs";
/** @brief Create the reusable account HTTP host with explicitly injected dependencies. @param {object} options storage, mail and payment options. */
export function createAccountServer(options) {
  const {
    origins = ["http://localhost:5173"],
    secureCookies = false,
    paymentVerifier,
    webhookSecret,
  } = options;
  if (!options.mailer?.send)
    throw new Error("Configure SMTP or an explicit development outbox");
  const service = createAccountService(options),
    limits = new Map();
  const cookie = (name, value, age) =>
    `${name}=${value}; Path=/; HttpOnly; SameSite=Strict${secureCookies ? "; Secure" : ""}${age === undefined ? "" : "; Max-Age=" + age}`;
  const server = http.createServer(async (req, res) => {
    const send = (status, data) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    try {
      const path = new URL(req.url, "http://localhost").pathname,
        url = new URL(req.url, "http://localhost"),
        method = req.method,
        origin = req.headers.origin;
      if (origin && !origins.includes(origin))
        fail(403, "Origin is not allowed");
      if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
        res.setHeader("Vary", "Origin");
      }
      if (method === "OPTIONS") {
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Content-Type, X-CSRF-Token",
        );
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE");
        res.writeHead(204);
        return res.end();
      }
      const cookies = Object.fromEntries(
        (req.headers.cookie || "")
          .split(";")
          .filter(Boolean)
          .map((v) => {
            const i = v.indexOf("=");
            return [v.slice(0, i).trim(), v.slice(i + 1)];
          }),
      );
      let session = service.session(cookies.simulab_session);
      let csrf = session?.csrf || cookies.simulab_csrf;
      if (!/^[a-f0-9]{64}$/.test(csrf || "")) {
        csrf = secret();
        res.setHeader("Set-Cookie", cookie("simulab_csrf", csrf, 86400));
      }
      const webhook = path === "/api/billing/webhook";
      if (!["GET", "HEAD"].includes(method) && !webhook) {
        if (!origin || !origins.includes(origin))
          fail(403, "Trusted Origin required");
        if (req.headers["x-csrf-token"] !== csrf)
          fail(403, "Invalid CSRF token");
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 2097152) fail(413, "Request too large");
        chunks.push(chunk);
      }
      const rawBuffer = Buffer.concat(chunks),
        raw = rawBuffer.toString("utf8");
      // Re-read authority after asynchronous body I/O so logout, reset or role changes take effect.
      session = service.session(cookies.simulab_session);
      let body = {};
      if (raw && !webhook) {
        try {
          body = JSON.parse(raw);
          if (!body || typeof body !== "object" || Array.isArray(body))
            fail(400, "JSON object required");
        } catch {
          fail(400, "Invalid JSON");
        }
      }
      if (path === "/api/auth/session" && method === "GET")
        return send(200, service.sessionPayload(session, csrf));
      if (
        [
          "/api/auth/signup",
          "/api/auth/login",
          "/api/auth/forgot-password",
          "/api/auth/resend-verification",
        ].includes(path)
      ) {
        const key = req.socket.remoteAddress + path;
        const hit = limits.get(key);
        const count =
          hit && hit.until > Date.now()
            ? hit
            : { n: 0, until: Date.now() + 60000 };
        if (++count.n > 20) fail(429, "Too many attempts");
        limits.set(key, count);
      }
      if (path === "/api/auth/signup" && method === "POST")
        return send(201, await service.signup(body));
      if (path === "/api/auth/resend-verification" && method === "POST")
        return send(200, await service.resendVerification(body.email));
      if (path === "/api/auth/verify" && method === "GET") {
        const result = service.verify(url.searchParams.get("token"));
        service.logout(cookies.simulab_session);
        const s = service.issueSession(result.userId);
        res.setHeader("Set-Cookie", [
          cookie("simulab_session", s.token, 2592000),
          cookie("simulab_csrf", s.csrf, 86400),
        ]);
        return send(200, {
          ...service.sessionPayload(s, s.csrf),
          status: "verified",
        });
      }
      if (path === "/api/auth/login" && method === "POST") {
        const s = service.login(body);
        service.logout(cookies.simulab_session);
        res.setHeader("Set-Cookie", [
          cookie(
            "simulab_session",
            s.token,
            body.remember ? 2592000 : undefined,
          ),
          cookie("simulab_csrf", s.csrf, 86400),
        ]);
        return send(200, service.sessionPayload(s, s.csrf));
      }
      if (path === "/api/auth/logout" && method === "POST") {
        service.logout(cookies.simulab_session);
        res.setHeader("Set-Cookie", [
          cookie("simulab_session", "", 0),
          cookie("simulab_csrf", secret(), 86400),
        ]);
        return send(200, { status: "signed-out" });
      }
      if (path === "/api/auth/forgot-password" && method === "POST")
        return send(200, await service.forgot(body.email));
      if (path === "/api/auth/reset-password" && method === "POST")
        return send(200, service.reset(body));
      if (path === "/api/billing/config" && method === "GET")
        return send(200, service.billingConfig());
      if (webhook && method === "POST") {
        let event;
        if (paymentVerifier)
          event = await paymentVerifier({
            rawBody: rawBuffer,
            headers: req.headers,
          });
        else {
          if (!webhookSecret) fail(503, "Payment provider is not configured");
          const sig = req.headers["x-payment-signature"],
            expected = createHmac("sha256", webhookSecret)
              .update(rawBuffer)
              .digest("hex");
          if (
            typeof sig !== "string" ||
            !/^[a-f0-9]{64}$/.test(sig) ||
            !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
          )
            fail(401, "Invalid payment signature");
          try {
            event = JSON.parse(raw);
          } catch {
            fail(400, "Invalid JSON");
          }
        }
        return send(200, service.webhook(event));
      }
      if (!session) fail(401, "Sign in required");
      const u = session.user;
      if (path === "/api/preferences" && method === "GET")
        return send(200, service.preferences(u.id));
      if (path === "/api/preferences" && method === "PUT")
        return send(200, service.setTheme(u.id, body.theme));
      if (path === "/api/projects" && method === "GET")
        return send(200, { projects: service.projects(u) });
      if (path === "/api/projects" && method === "POST")
        return send(201, { project: service.save(u, null, body) });
      const p = path.match(/^\/api\/projects\/([a-f0-9]+)$/);
      if (p) {
        if (method === "GET")
          return send(200, { project: service.project(u, p[1]) });
        if (method === "PUT")
          return send(200, { project: service.save(u, p[1], body) });
        if (method === "DELETE") return send(200, service.remove(u, p[1]));
      }
      if (path === "/api/billing/checkout" && method === "POST")
        return send(201, {
          payment: service.checkout(u),
          ...service.billingConfig(),
        });
      const pm = path.match(
        /^\/api\/billing\/payments\/([a-f0-9]+)(\/submit-reference)?$/,
      );
      if (pm) {
        const payment = service.payment(pm[1]);
        if (!payment || payment.userId !== u.id) fail(404, "Payment not found");
        if (method === "GET" && !pm[2]) return send(200, { payment });
        if (method === "POST" && pm[2])
          return send(200, {
            payment: service.reference(u, pm[1], body.reference),
          });
      }
      if (path === "/api/admin/payments" && method === "GET")
        return send(200, { payments: service.payments(u) });
      if (path === "/api/admin/users" && method === "GET")
        return send(200, { users: service.users(u) });
      const role = path.match(/^\/api\/admin\/users\/([a-f0-9]+)\/role$/);
      if (role && method === "PUT")
        return send(200, { user: service.role(u, role[1], body.role) });
      const approval = path.match(
        /^\/api\/admin\/payments\/([a-f0-9]+)\/approve$/,
      );
      if (approval && method === "POST") {
        service.admin(u);
        return send(200, { payment: service.approve(approval[1], u.id) });
      }
      fail(404, "Route not found");
    } catch (e) {
      send(e.status || 500, {
        error: e.status ? e.message : "Account service error",
      });
    }
  });
  return { server, service, close: () => service.close() };
}
