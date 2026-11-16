import { randomBytes, createHash } from "node:crypto";
const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
const digest = (value) => createHash("sha256").update(value).digest("hex");
/** @brief Issue bounded memory-only compiler credentials for exact trusted loopback origins.
 * @param options Host-owned origin allowlist and optional clock; credentials expire after one hour.
 * @returns Issuance and authentication functions; these grant no physical-device authority.
 */
export function createSimulationSessions({ origins, now = Date.now }) {
  const sessions = new Map(),
    issuance = new Map();
  const trusted = (origin) => {
    if (typeof origin !== "string" || !origins.includes(origin))
      fail(403, "Simulation session origin denied");
    let url;
    try {
      url = new URL(origin);
    } catch {
      fail(403, "Simulation session origin denied");
    }
    if (
      url.origin !== origin ||
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost"].includes(url.hostname)
    )
      fail(403, "Simulation sessions require a trusted loopback origin");
  };
  const prune = () => {
    const time = now();
    for (const [key, entry] of sessions)
      if (entry.expiresAt <= time) sessions.delete(key);
    for (const [key, entry] of issuance)
      if (entry.since + 60000 <= time) issuance.delete(key);
  };
  return {
    issue(origin) {
      trusted(origin);
      prune();
      const rate = issuance.get(origin) ?? { since: now(), count: 0 };
      if (rate.count >= 12 || sessions.size >= 64)
        fail(429, "Simulation session issuance limit reached; retry later");
      rate.count++;
      issuance.set(origin, rate);
      const session = randomBytes(32).toString("hex"),
        expiresAt = now() + 3600000;
      sessions.set(digest(session), {
        owner: randomBytes(16).toString("hex"),
        origin,
        expiresAt,
      });
      return { session, expiresAt };
    },
    authenticate(authorization, origin) {
      prune();
      if (
        typeof authorization !== "string" ||
        !/^Bearer [a-f0-9]{64}$/.test(authorization)
      )
        return undefined;
      const entry = sessions.get(digest(authorization.slice(7)));
      if (!entry) return undefined;
      trusted(origin);
      if (entry.origin !== origin)
        fail(403, "Simulation session origin mismatch");
      return entry;
    },
  };
}
