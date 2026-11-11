import { DatabaseSync } from "node:sqlite";
import {
  randomBytes,
  createHash,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
export const THEMES = [
  "corporate-navy",
  "midnight",
  "graphite",
  "corporate-light",
  "pearl",
  "sand",
];
export const secret = () => randomBytes(32).toString("hex");
export const hash = (s) => createHash("sha256").update(s).digest("hex");
export function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}
/** @brief Persistent account domain with trusted operator functions. @param {object} options Explicit storage, clock, mail and payment configuration. */
export function createAccountService({
  dbPath,
  configPath,
  mailer,
  baseUrl = "http://127.0.0.1:5173",
  trialDays = 30,
  billing = {},
  now = Date.now,
}) {
  if (!Number.isFinite(trialDays) || trialDays <= 0 || trialDays > 3650)
    throw new Error("Invalid trialDays");
  if (
    billing.paidDays !== undefined &&
    (!Number.isFinite(billing.paidDays) ||
      billing.paidDays <= 0 ||
      billing.paidDays > 3650)
  )
    throw new Error("Invalid paidDays");
  mkdirSync(dirname(dbPath), { recursive: true });
  mkdirSync(dirname(configPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(
    `PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE,password TEXT,role TEXT,verified INTEGER,trialExpires INTEGER,paidExpires INTEGER DEFAULT 0);CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,userId TEXT,csrf TEXT,expires INTEGER);CREATE TABLE IF NOT EXISTS tokens(token TEXT PRIMARY KEY,userId TEXT,purpose TEXT,expires INTEGER);CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,userId TEXT,name TEXT,data TEXT,updatedAt INTEGER);CREATE TABLE IF NOT EXISTS payments(id TEXT PRIMARY KEY,userId TEXT,amount INTEGER,currency TEXT,status TEXT,reference TEXT,createdAt INTEGER);CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,paymentId TEXT UNIQUE);CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,actor TEXT,action TEXT,subject TEXT,createdAt INTEGER);`,
  );
  const one = (sql, ...args) => db.prepare(sql).get(...args),
    run = (sql, ...args) => db.prepare(sql).run(...args);
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    config = { users: {} };
  }
  const audit = (actor, action, subject) =>
    run(
      "INSERT INTO audit VALUES(?,?,?,?,?)",
      secret(),
      actor,
      action,
      subject,
      now(),
    );
  const user = (id) => one("SELECT * FROM users WHERE id=?", id),
    publicUser = (u) => ({
      id: u.id,
      email: u.email,
      role: u.role,
      verified: !!u.verified,
    });
  const subscription = (u) => ({
    mode:
      u.paidExpires > now()
        ? "paid"
        : u.trialExpires > now()
          ? "trial"
          : "expired",
    expiresAt: u.paidExpires > now() ? u.paidExpires : u.trialExpires,
  });
  const preferences = (id) => ({ theme: config.users[id]?.theme || THEMES[0] });
  const setTheme = (id, theme) => {
    if (!THEMES.includes(theme)) fail(400, "Unknown theme");
    const next = { ...config, users: { ...config.users, [id]: { theme } } },
      temp = configPath + "." + secret() + ".tmp";
    writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(temp, configPath);
        break;
      } catch (e) {
        if (!["EPERM", "EBUSY"].includes(e.code) || attempt >= 8) throw e;
        Atomics.wait(
          new Int32Array(new SharedArrayBuffer(4)),
          0,
          0,
          20 * (attempt + 1),
        );
      }
    }
    config = next;
    return preferences(id);
  };
  const passwordHash = (password) => {
    if (
      typeof password !== "string" ||
      password.length < 12 ||
      password.length > 256
    )
      fail(400, "Password must contain 12 to 256 characters");
    const salt = secret();
    return salt + ":" + scryptSync(password, salt, 64).toString("hex");
  };
  const tokenFor = (id, purpose) => {
    const token = secret();
    run(
      "INSERT INTO tokens VALUES(?,?,?,?)",
      hash(token),
      id,
      purpose,
      now() + (purpose === "verify" ? 86400000 : 3600000),
    );
    return token;
  };
  const consume = (token, purpose) => {
    const row = one(
      "SELECT * FROM tokens WHERE token=? AND purpose=?",
      hash(String(token)),
      purpose,
    );
    if (!row || row.expires <= now()) fail(400, "Invalid or expired token");
    run("DELETE FROM tokens WHERE token=?", row.token);
    return row.userId;
  };
  const issueSession = (id, remember = true) => {
    const u = user(id);
    if (!u?.verified) fail(403, "Verified account required");
    const token = secret(),
      csrf = secret(),
      expires = now() + (remember ? 30 : 1) * 86400000;
    run("INSERT INTO sessions VALUES(?,?,?,?)", hash(token), id, csrf, expires);
    return { token, csrf, expires, user: u };
  };
  const admin = (u) => {
    if (u.role !== "admin") fail(403, "Administrator required");
  };
  const writeAccess = (u) => {
    if (
      !["admin", "editor"].includes(u.role) ||
      subscription(u).mode !== "paid"
    )
      fail(403, "Active paid subscription and write permission required");
  };
  const grantPaid = (id, expiresAt, actor) => {
    if (!user(id) || !Number.isSafeInteger(expiresAt) || expiresAt <= now())
      fail(400, "Invalid subscription");
    run("UPDATE users SET paidExpires=? WHERE id=?", expiresAt, id);
    audit(actor, "grant-paid", id);
  };
  const payment = (id) => one("SELECT * FROM payments WHERE id=?", id);
  const approveInternal = (id, actor) => {
    const p = payment(id);
    if (!p) fail(404, "Payment not found");
    if (p.status === "approved") return p;
    run("UPDATE payments SET status='approved' WHERE id=?", id);
    grantPaid(
      p.userId,
      Math.max(now(), user(p.userId).paidExpires) +
        (billing.paidDays || 30) * 86400000,
      actor,
    );
    return payment(id);
  };
  const transaction = (fn) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const v = fn();
      db.exec("COMMIT");
      return v;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  return {
    db,
    now,
    user,
    publicUser,
    subscription,
    preferences,
    setTheme,
    admin,
    writeAccess,
    grantPaid,
    payment,
    issueSession,
    close: () => db.close(),
    bootstrapAdmin(email) {
      const u = one("SELECT * FROM users WHERE email=?", email.toLowerCase());
      if (!u?.verified) fail(400, "Verify administrator first");
      run("UPDATE users SET role='admin' WHERE id=?", u.id);
      audit("trusted-bootstrap", "role-admin", u.id);
    },
    async signup({ email, password, theme = THEMES[0] }) {
      email = String(email || "")
        .trim()
        .toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)
        fail(400, "Valid email required");
      if (!THEMES.includes(theme)) fail(400, "Unknown theme");
      const digest = passwordHash(password);
      const existing = one("SELECT * FROM users WHERE email=?", email);
      if (existing) {
        const [salt, stored] = existing.password.split(":");
        if (
          existing.verified ||
          !timingSafeEqual(
            scryptSync(password, salt, 64),
            Buffer.from(stored, "hex"),
          )
        )
          fail(409, "Account already exists");
        await this.resendVerification(email);
        return {
          status: "pending-verification",
          delivery: mailer.mode || "injected",
        };
      }
      const id = secret();
      run(
        "INSERT INTO users(id,email,password,role,verified,trialExpires) VALUES(?,?,?,?,?,?)",
        id,
        email,
        digest,
        "editor",
        0,
        0,
      );
      setTheme(id, theme);
      const token = tokenFor(id, "verify");
      await mailer.send({
        to: email,
        subject: "Verify your Simulab account",
        url: baseUrl + "/?verify=" + token,
      });
      return {
        status: "pending-verification",
        delivery: mailer.mode || "injected",
      };
    },
    verify(token) {
      const id = consume(token, "verify");
      run(
        "UPDATE users SET verified=1,trialExpires=? WHERE id=? AND verified=0",
        now() + trialDays * 86400000,
        id,
      );
      return { status: "verified", userId: id };
    },
    /** @brief Reissue expiring ownership proof; responses reveal neither account existence nor tokens. */
    async resendVerification(email) {
      const u = one(
        "SELECT * FROM users WHERE email=?",
        String(email || "")
          .trim()
          .toLowerCase(),
      );
      if (u && !u.verified) {
        run("DELETE FROM tokens WHERE userId=? AND purpose=?", u.id, "verify");
        const token = tokenFor(u.id, "verify");
        await mailer.send({
          to: u.email,
          subject: "Verify your Simulab account",
          url: baseUrl + "/?verify=" + token,
        });
      }
      return {
        status:
          "If verification is pending, a new verification message has been requested",
        delivery: mailer.mode || "injected",
      };
    },
    login({ email, password, remember }) {
      const u = one(
        "SELECT * FROM users WHERE email=?",
        String(email || "")
          .toLowerCase()
          .trim(),
      );
      const [salt, digest] = (u?.password || "dummy:" + "00".repeat(64)).split(
        ":",
      );
      const candidate = scryptSync(
        String(password || "").slice(0, 256),
        salt,
        64,
      );
      if (!u || !timingSafeEqual(candidate, Buffer.from(digest, "hex")))
        fail(401, "Invalid credentials");
      return issueSession(u.id, remember);
    },
    session(token) {
      if (!token) return null;
      const s = one("SELECT * FROM sessions WHERE token=?", hash(token));
      return s && s.expires > now() ? { ...s, user: user(s.userId) } : null;
    },
    logout(token) {
      if (token) run("DELETE FROM sessions WHERE token=?", hash(token));
    },
    async forgot(email) {
      const u = one(
        "SELECT * FROM users WHERE email=?",
        String(email || "").toLowerCase(),
      );
      if (u) {
        const token = tokenFor(u.id, "reset");
        await mailer.send({
          to: u.email,
          subject: "Reset your Simulab password",
          url: baseUrl + "/?reset=" + token,
        });
      }
      return {
        status:
          "If the account exists, reset instructions are available through the configured mail transport",
        delivery: mailer.mode || "injected",
      };
    },
    reset({ token, password }) {
      const digest = passwordHash(password),
        id = consume(token, "reset");
      run("UPDATE users SET password=? WHERE id=?", digest, id);
      run("DELETE FROM sessions WHERE userId=?", id);
      run("DELETE FROM tokens WHERE userId=? AND purpose=?", id, "reset");
      return { status: "password-reset" };
    },
    sessionPayload(s, csrf) {
      return {
        user: s ? publicUser(s.user) : null,
        subscription: s
          ? subscription(s.user)
          : { mode: "expired", expiresAt: null },
        permissions: s
          ? [
              "projects.read",
              "simulation.run",
              "hardware.upload",
              ...(["admin", "editor"].includes(s.user.role) &&
              subscription(s.user).mode === "paid"
                ? ["projects.write"]
                : []),
              ...(s.user.role === "admin"
                ? ["users.manage", "billing.manage"]
                : []),
            ]
          : [],
        preferences: s ? preferences(s.user.id) : { theme: THEMES[0] },
        csrfToken: csrf,
      };
    },
    projects(u) {
      return db
        .prepare("SELECT * FROM projects WHERE userId=?")
        .all(u.id)
        .map((p) => ({ ...p, data: JSON.parse(p.data) }));
    },
    project(u, id) {
      const p = one("SELECT * FROM projects WHERE id=? AND userId=?", id, u.id);
      if (!p) fail(404, "Project not found");
      return { ...p, data: JSON.parse(p.data) };
    },
    save(u, id, { name, data }) {
      writeAccess(u);
      if (
        typeof name !== "string" ||
        !name.trim() ||
        name.length > 200 ||
        !data ||
        typeof data !== "object"
      )
        fail(400, "Project name and data required");
      if (id) this.project(u, id);
      else id = secret();
      run(
        "INSERT INTO projects VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,data=excluded.data,updatedAt=excluded.updatedAt",
        id,
        u.id,
        name,
        JSON.stringify(data),
        now(),
      );
      return this.project(u, id);
    },
    remove(u, id) {
      writeAccess(u);
      this.project(u, id);
      run("DELETE FROM projects WHERE id=?", id);
      return { status: "deleted" };
    },
    billingConfig() {
      return {
        enabled:
          Number.isSafeInteger(billing.amount) &&
          billing.amount > 0 &&
          /^[A-Z]{3}$/.test(billing.currency || "") &&
          !!billing.qrImage,
        amount: billing.amount || null,
        currency: billing.currency || null,
        qrImage: billing.qrImage || null,
        confirmation: "provider-or-administrator",
      };
    },
    checkout(u) {
      if (!this.billingConfig().enabled)
        fail(503, "Checkout is not configured");
      const id = secret();
      run(
        "INSERT INTO payments VALUES(?,?,?,?,?,?,?)",
        id,
        u.id,
        billing.amount,
        billing.currency,
        "pending",
        null,
        now(),
      );
      return payment(id);
    },
    reference(u, id, reference) {
      const p = payment(id);
      if (!p || p.userId !== u.id) fail(404, "Payment not found");
      if (
        typeof reference !== "string" ||
        reference.length < 3 ||
        reference.length > 200
      )
        fail(400, "Payment reference required");
      run("UPDATE payments SET reference=? WHERE id=?", reference, id);
      return payment(id);
    },
    approve(id, actor) {
      return transaction(() => approveInternal(id, actor));
    },
    payments(u) {
      admin(u);
      return db.prepare("SELECT * FROM payments ORDER BY createdAt DESC").all();
    },
    users(u) {
      admin(u);
      return db.prepare("SELECT id,email,role,verified FROM users").all();
    },
    role(u, id, role) {
      admin(u);
      if (!["admin", "editor", "viewer"].includes(role) || !user(id))
        fail(400, "Invalid role or user");
      if (
        user(id).role === "admin" &&
        role !== "admin" &&
        one("SELECT COUNT(*) AS n FROM users WHERE role=?", "admin").n === 1
      )
        fail(409, "Cannot demote the last administrator");
      run("UPDATE users SET role=? WHERE id=?", role, id);
      audit(u.id, "role-" + role, id);
      return publicUser(user(id));
    },
    webhook(event) {
      if (
        !event ||
        typeof event.eventId !== "string" ||
        !event.eventId ||
        typeof event.paymentId !== "string" ||
        event.status !== "paid"
      )
        fail(400, "Invalid payment event");
      return transaction(() => {
        const p = payment(event.paymentId);
        if (!p || event.amount !== p.amount || event.currency !== p.currency)
          fail(400, "Payment details do not match");
        const prior = one(
          "SELECT * FROM events WHERE id=? OR paymentId=?",
          event.eventId,
          event.paymentId,
        );
        if (prior) {
          if (prior.paymentId !== event.paymentId) fail(409, "Event conflict");
          return { status: "duplicate" };
        }
        approveInternal(p.id, "provider:" + event.eventId);
        run("INSERT INTO events VALUES(?,?)", event.eventId, p.id);
        return { status: "approved" };
      });
    },
  };
}
