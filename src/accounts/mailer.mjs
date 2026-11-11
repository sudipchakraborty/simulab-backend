import nodemailer from "nodemailer";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { secret } from "./service.mjs";
/** @brief Build an SMTP transport or explicitly enabled local development outbox. @param {object} options SMTP parameters or outboxPath. */
export function createMailer({
  host,
  port = 587,
  secure = false,
  user,
  password,
  from,
  outboxPath,
}) {
  if (host) {
    if (!from) throw new Error("SMTP_FROM required");
    const transport = nodemailer.createTransport({
      host,
      port: Number(port),
      secure,
      requireTLS: !secure,
      auth: user ? { user, pass: password } : undefined,
    });
    return {
      mode: "smtp",
      send: (m) =>
        transport.sendMail({
          from,
          to: m.to,
          subject: m.subject,
          text: m.subject + "\n\n" + m.url,
        }),
    };
  }
  if (!outboxPath)
    throw new Error("SMTP_HOST or explicit ACCOUNT_DEV_OUTBOX is required");
  mkdirSync(outboxPath, { recursive: true });
  return {
    mode: "development-outbox",
    send: async (m) =>
      writeFileSync(
        join(outboxPath, Date.now() + "-" + secret() + ".json"),
        JSON.stringify(
          { ...m, delivery: "LOCAL DEVELOPMENT ONLY - not sent" },
          null,
          2,
        ),
        { mode: 0o600 },
      ),
  };
}
