import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("account factory implements verified sessions, ownership, entitlements and persistent themes", async () => {
  const { createAccountServer } = await import("../src/accounts/server.mjs");
  const dir = mkdtempSync(join(tmpdir(), "simulab-account-"));
  const messages = [];
  const api = createAccountServer({
    dbPath: join(dir, "db.sqlite"),
    configPath: join(dir, "system.json"),
    origins: ["http://localhost:5173"],
    mailer: { send: async (m) => messages.push(m) },
    billing: {
      amount: 100,
      currency: "INR",
      qrImage: "https://example.com/qr.png",
    },
  });
  await new Promise((r) => api.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${api.server.address().port}`;
  let cookie = "",
    csrf = "";
  const req = async (path, method = "GET", body) => {
    const r = await fetch(base + "/api" + path, {
      method,
      headers: {
        origin: "http://localhost:5173",
        cookie,
        "content-type": "application/json",
        "x-csrf-token": csrf,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const cs = r.headers.getSetCookie();
    if (cs.length) cookie = cs.map((c) => c.split(";")[0]).join("; ");
    const data = await r.json();
    if (data.csrfToken) csrf = data.csrfToken;
    return { status: r.status, data, headers: r.headers };
  };
  try {
    assert.equal((await req("/auth/session")).data.user, null);
    assert.equal(
      (
        await req("/auth/signup", "POST", {
          email: "editor@example.com",
          password: "strong-password-123",
        })
      ).status,
      201,
    );
    const token = new URL(messages[0].url).searchParams.get("verify");
    assert.equal((await req("/auth/verify?token=" + token)).status, 200);
    assert.equal((await req("/auth/verify?token=" + token)).status, 400);
    const login = await req("/auth/login", "POST", {
      email: "editor@example.com",
      password: "strong-password-123",
      remember: true,
    });
    assert.equal(login.data.user.role, "editor");
    assert.match(login.headers.get("set-cookie"), /HttpOnly/);
    assert.equal(
      (await req("/projects", "POST", { name: "Trial", data: {} })).status,
      403,
    );
    const id = login.data.user.id;
    api.service.grantPaid(id, Date.now() + 86400000, "test administrator");
    assert.equal(
      (
        await req("/projects", "POST", {
          name: "Saved",
          data: { schema: "1.3" },
        })
      ).status,
      201,
    );
    assert.equal(
      (await req("/preferences", "PUT", { theme: "pearl" })).status,
      200,
    );
    assert.equal(
      JSON.parse(readFileSync(join(dir, "system.json"))).users[id].theme,
      "pearl",
    );
    const checkout = await req("/billing/checkout", "POST", {});
    assert.equal(checkout.data.payment.status, "pending");
    await req("/auth/logout", "POST", {});
    assert.equal((await req("/auth/session")).data.user, null);
  } finally {
    await new Promise((r) => api.server.close(r));
    api.close();
  }
});

test("security boundaries deny CSRF, ownership, forged payments and session replay", async () => {
  const { createAccountServer } = await import("../src/accounts/server.mjs");
  const { createHmac } = await import("node:crypto");
  const dir = mkdtempSync(join(tmpdir(), "simulab-security-"));
  const messages = [];
  let clock = Date.now();
  const api = createAccountServer({
    dbPath: join(dir, "db"),
    configPath: join(dir, "config"),
    origins: ["http://localhost:5173"],
    mailer: { send: async (m) => messages.push(m) },
    webhookSecret: "test-only-secret",
    now: () => clock,
    billing: {
      amount: 100,
      currency: "INR",
      qrImage: "https://example.com/qr",
      paidDays: 1,
    },
  });
  await new Promise((r) => api.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${api.server.address().port}/api`;
  const request = async (path, method = "GET", data, extra = {}) => {
    const r = await fetch(base + path, {
      method,
      headers: {
        origin: "http://localhost:5173",
        "content-type": "application/json",
        ...extra,
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return { r, data: await r.json() };
  };
  try {
    const anon = await request("/auth/session");
    const ac = anon.r.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const ah = { cookie: ac, "x-csrf-token": anon.data.csrfToken };
    assert.equal(
      (
        await request("/auth/signup", "POST", {
          email: "x@example.com",
          password: "long-password-123",
        })
      ).r.status,
      403,
    );
    assert.equal(
      (
        await request(
          "/auth/signup",
          "POST",
          { email: "x@example.com", password: "long-password-123" },
          { ...ah, origin: "https://evil.example" },
        )
      ).r.status,
      403,
    );
    await api.service.signup({
      email: "a@example.com",
      password: "long-password-123",
    });
    api.service.verify(new URL(messages.at(-1).url).searchParams.get("verify"));
    const login = await request(
      "/auth/login",
      "POST",
      { email: "a@example.com", password: "long-password-123", remember: true },
      ah,
    );
    const cookie = login.r.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const headers = { cookie, "x-csrf-token": login.data.csrfToken };
    const id = login.data.user.id;
    const row = api.service.user(id);
    assert.ok(!row.password.includes("long-password-123"));
    assert.equal(
      api.service.db
        .prepare("SELECT token FROM sessions")
        .get()
        .token.includes(cookie.split("=")[1]),
      false,
    );
    api.service.bootstrapAdmin("a@example.com");
    assert.equal(
      (
        await request(
          "/admin/users/" + id + "/role",
          "PUT",
          { role: "viewer" },
          headers,
        )
      ).r.status,
      409,
    );
    assert.equal(
      (await request("/projects", "POST", { name: "trial", data: {} }, headers))
        .r.status,
      403,
    );
    const pending = api.service.checkout(row);
    const event = {
      eventId: "e1",
      paymentId: pending.id,
      status: "paid",
      amount: 100,
      currency: "INR",
    };
    const postEvent = async (e, signature) =>
      request("/billing/webhook", "POST", e, {
        "x-payment-signature":
          signature ||
          createHmac("sha256", "test-only-secret")
            .update(JSON.stringify(e))
            .digest("hex"),
      });
    assert.equal((await postEvent(event, "0".repeat(64))).r.status, 401);
    assert.equal((await postEvent({ ...event, amount: 1 })).r.status, 400);
    assert.equal((await postEvent(event)).data.status, "approved");
    const expires = api.service.user(id).paidExpires;
    assert.equal((await postEvent(event)).data.status, "duplicate");
    assert.equal(api.service.user(id).paidExpires, expires);
    const project = await request(
      "/projects",
      "POST",
      { name: "private", data: {} },
      headers,
    );
    assert.equal(project.r.status, 201);
    await api.service.signup({
      email: "b@example.com",
      password: "long-password-123",
    });
    api.service.verify(new URL(messages.at(-1).url).searchParams.get("verify"));
    const second = api.service.login({
      email: "b@example.com",
      password: "long-password-123",
    });
    const sh = {
      cookie: `simulab_session=${second.token}`,
      "x-csrf-token": second.csrf,
    };
    assert.equal(
      (
        await request(
          "/projects/" + project.data.project.id,
          "GET",
          undefined,
          sh,
        )
      ).r.status,
      404,
    );
    clock = expires + 1;
    assert.equal(
      (
        await request(
          "/projects",
          "POST",
          { name: "expired", data: {} },
          headers,
        )
      ).r.status,
      403,
    );
    clock = Date.now();
    await api.service.forgot("a@example.com");
    const reset = new URL(messages.at(-1).url).searchParams.get("reset");
    api.service.reset({ token: reset, password: "new-password-123" });
    assert.throws(() =>
      api.service.reset({ token: reset, password: "another-password-123" }),
    );
    assert.equal(
      (await request("/auth/session", "GET", undefined, headers)).data.user,
      null,
    );
  } finally {
    await new Promise((r) => api.server.close(r));
    api.close();
  }
});

test("expiry, viewer denial and storage survive service restart", async () => {
  const { createAccountService } = await import("../src/accounts/service.mjs");
  const dir = mkdtempSync(join(tmpdir(), "simulab-persist-"));
  const messages = [];
  let clock = Date.now();
  const options = {
    dbPath: join(dir, "db"),
    configPath: join(dir, "SYSTEM.json"),
    mailer: { send: async (m) => messages.push(m) },
    now: () => clock,
  };
  let s = createAccountService(options);
  await s.signup({
    email: "persist@example.com",
    password: "persistent-password",
    theme: "sand",
  });
  const token = new URL(messages[0].url).searchParams.get("verify");
  clock += 86400001;
  assert.throws(() => s.verify(token), /expired/);
  clock -= 86400001;
  const id = s.verify(token).userId;
  const session = s.issueSession(id);
  s.grantPaid(id, clock + 86400000, "trusted test");
  s.bootstrapAdmin("persist@example.com");
  const admin = s.user(id);
  s.close();
  s = createAccountService(options);
  assert.equal(s.preferences(id).theme, "sand");
  assert.equal(s.session(session.token).user.id, id);
  assert.equal(s.subscription(s.user(id)).mode, "paid");
  await s.signup({
    email: "viewer@example.com",
    password: "persistent-password",
  });
  const viewer = s.verify(
    new URL(messages.at(-1).url).searchParams.get("verify"),
  ).userId;
  s.role(admin, viewer, "viewer");
  s.grantPaid(viewer, clock + 86400000, "trusted test");
  assert.throws(
    () => s.save(s.user(viewer), null, { name: "no", data: {} }),
    /write permission/,
  );
  s.close();
});

test("mail responses identify local delivery safely and frontend reset links use reset query", async () => {
  const { createAccountService } = await import("../src/accounts/service.mjs");
  const dir = mkdtempSync(join(tmpdir(), "simulab-mail-"));
  const messages = [];
  const s = createAccountService({
    dbPath: join(dir, "db"),
    configPath: join(dir, "SYSTEM.json"),
    mailer: { mode: "development-outbox", send: async (m) => messages.push(m) },
  });
  try {
    const signup = await s.signup({
      email: "mail@example.com",
      password: "long-password-123",
    });
    assert.equal(signup.delivery, "development-outbox");
    assert.equal(signup.url, undefined);
    const forgot = await s.forgot("mail@example.com");
    assert.equal(forgot.delivery, "development-outbox");
    assert.ok(new URL(messages.at(-1).url).searchParams.get("reset"));
  } finally {
    s.close();
  }
});

test("revocation while a request body is streaming prevents the pending protected write", async () => {
  const { createAccountServer } = await import("../src/accounts/server.mjs");
  const { request } = await import("node:http");
  const dir = mkdtempSync(join(tmpdir(), "simulab-revoke-")),
    messages = [];
  const api = createAccountServer({
    dbPath: join(dir, "db"),
    configPath: join(dir, "SYSTEM.json"),
    origins: ["http://localhost:5173"],
    mailer: { send: async (m) => messages.push(m) },
  });
  await api.service.signup({
    email: "stream@example.com",
    password: "stream-password-123",
  });
  const id = api.service.verify(
    new URL(messages[0].url).searchParams.get("verify"),
  ).userId;
  api.service.grantPaid(id, Date.now() + 86400000, "test operator");
  const session = api.service.issueSession(id);
  await new Promise((r) => api.server.listen(0, "127.0.0.1", r));
  try {
    const response = await new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port: api.server.address().port,
          path: "/api/projects",
          method: "POST",
          headers: {
            origin: "http://localhost:5173",
            cookie: `simulab_session=${session.token}`,
            "x-csrf-token": session.csrf,
            "content-type": "application/json",
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        },
      );
      req.on("error", reject);
      req.write('{"name":"stream",');
      setTimeout(() => {
        api.service.logout(session.token);
        req.end('"data":{}}');
      }, 50);
    });
    assert.equal(response, 401);
  } finally {
    await new Promise((r) => api.server.close(r));
    api.close();
  }
});

test("failed signup mail can be retried and expired verification can be resent without exposing links", async () => {
  const { createAccountService } = await import("../src/accounts/service.mjs");
  const dir = mkdtempSync(join(tmpdir(), "simulab-retry-")),
    messages = [];
  let rejectMail = true;
  const service = createAccountService({
    dbPath: join(dir, "db"),
    configPath: join(dir, "SYSTEM.json"),
    mailer: {
      mode: "smtp",
      send: async (m) => {
        if (rejectMail) throw Error("SMTP unavailable");
        messages.push(m);
      },
    },
  });
  try {
    const account = {
      email: "retry@example.com",
      password: "retry-password-123",
    };
    await assert.rejects(() => service.signup(account), /SMTP/);
    rejectMail = false;
    const retry = await service.signup(account);
    assert.equal(retry.status, "pending-verification");
    const first = new URL(messages.at(-1).url).searchParams.get("verify");
    const result = await service.resendVerification(account.email);
    assert.equal(result.delivery, "smtp");
    assert.equal(result.url, undefined);
    const latest = new URL(messages.at(-1).url).searchParams.get("verify");
    assert.notEqual(first, latest);
    assert.throws(() => service.verify(first));
    service.verify(latest);
    assert.equal(
      (await service.resendVerification("unknown@example.com")).status,
      result.status,
    );
  } finally {
    service.close();
  }
});

test("SMTP refuses plaintext authentication when STARTTLS is unavailable", async () => {
  const { createServer } = await import("node:net");
  const { createMailer } = await import("../src/accounts/mailer.mjs");
  let authenticationAttempted = false;
  const sockets = new Set();
  const smtp = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.write("220 local-test ESMTP\r\n");
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk.toString();
      let end;
      while ((end = input.indexOf("\r\n")) >= 0) {
        const line = input.slice(0, end);
        input = input.slice(end + 2);
        if (line.startsWith("EHLO"))
          socket.write("250-local-test\r\n250 AUTH PLAIN LOGIN\r\n");
        else if (line.startsWith("STARTTLS"))
          socket.write("454 TLS unavailable\r\n");
        else if (line.startsWith("AUTH")) {
          authenticationAttempted = true;
          socket.write("535 Rejected test credentials\r\n");
        } else socket.write("500 Unsupported test command\r\n");
      }
    });
  });
  await new Promise((r) => smtp.listen(0, "127.0.0.1", r));
  try {
    const mailer = createMailer({
      host: "127.0.0.1",
      port: smtp.address().port,
      user: "test",
      password: "not-real",
      from: "test@example.com",
    });
    await assert.rejects(() =>
      mailer.send({
        to: "recipient@example.com",
        subject: "Local test only",
        url: "http://localhost",
      }),
    );
    assert.equal(authenticationAttempted, false);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((r) => smtp.close(r));
  }
});

test("the configurable trial begins at successful verification rather than signup", async () => {
  const { createAccountService } = await import("../src/accounts/service.mjs");
  const dir = mkdtempSync(join(tmpdir(), "simulab-trial-"));
  let clock = Date.now();
  const messages = [];
  const s = createAccountService({
    dbPath: join(dir, "db"),
    configPath: join(dir, "SYSTEM.json"),
    trialDays: 7,
    now: () => clock,
    mailer: { send: async (m) => messages.push(m) },
  });
  try {
    await s.signup({
      email: "delayed@example.com",
      password: "delayed-password-123",
    });
    clock += 12 * 3600000;
    const result = s.verify(
      new URL(messages.at(-1).url).searchParams.get("verify"),
    );
    assert.equal(s.user(result.userId).trialExpires, clock + 7 * 86400000);
  } finally {
    s.close();
  }
});
