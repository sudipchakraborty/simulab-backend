import { resolve } from "node:path";
import { createAccountServer } from "./accounts/server.mjs";
import { createMailer } from "./accounts/mailer.mjs";
const e = process.env;
const mailer = createMailer({
  host: e.SMTP_HOST,
  port: e.SMTP_PORT,
  secure: e.SMTP_TLS === "true",
  user: e.SMTP_USER,
  password: e.SMTP_PASSWORD,
  from: e.SMTP_FROM,
  outboxPath: e.ACCOUNT_DEV_OUTBOX,
});
const api = createAccountServer({
  dbPath: resolve(e.ACCOUNT_DB || ".local/accounts.sqlite"),
  configPath: resolve(e.ACCOUNT_SYSTEM_CONFIG || ".local/SYSTEM.json"),
  origins: (
    e.ACCOUNT_ORIGINS || "http://localhost:5173,http://127.0.0.1:5173"
  ).split(","),
  baseUrl: e.APP_URL || "http://localhost:5173",
  secureCookies: e.ACCOUNT_SECURE_COOKIES === "true",
  trialDays: Number(e.ACCOUNT_TRIAL_DAYS || 30),
  mailer,
  webhookSecret: e.PAYMENT_WEBHOOK_SECRET,
  billing: {
    amount: Number(e.PAYMENT_AMOUNT_MINOR),
    currency: e.PAYMENT_CURRENCY,
    qrImage: e.PAYMENT_QR_IMAGE,
    paidDays: Number(e.PAYMENT_PAID_DAYS || 30),
  },
});
if (e.ACCOUNT_BOOTSTRAP_ADMIN)
  api.service.bootstrapAdmin(e.ACCOUNT_BOOTSTRAP_ADMIN);
api.server.listen(
  Number(e.ACCOUNT_PORT || 4320),
  e.ACCOUNT_HOST || "127.0.0.1",
  () =>
    console.log(
      `Account API on ${e.ACCOUNT_HOST || "127.0.0.1"}:${e.ACCOUNT_PORT || 4320}; mail transport: ${mailer.mode}`,
    ),
);
for (const event of ["SIGINT", "SIGTERM"])
  process.on(event, () =>
    api.server.close(() => {
      api.close();
      process.exit(0);
    }),
  );
