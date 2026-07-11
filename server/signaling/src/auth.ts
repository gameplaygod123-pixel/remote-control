import { timingSafeEqual } from "crypto";
import bcrypt from "bcryptjs";

// Gates who may register an agent on this server, so it can't be used as an
// open relay by strangers. Personal-use default; override via env var.
const DEFAULT_AGENT_TOKEN = "dev-token-change-me";
const AGENT_TOKEN = process.env.AGENT_TOKEN ?? DEFAULT_AGENT_TOKEN;

// Fail LOUD instead of silently booting with the public default token. This
// happened for real once (a leftover dev server held port 8080, so the
// supervisor ran dev code with the default token that lives in this public
// repo -- an open relay). The prod supervisor sets AGENT_TOKEN in the
// LaunchAgent plist, so it boots fine; dev opts in with ALLOW_DEFAULT_TOKEN=1.
if (AGENT_TOKEN === DEFAULT_AGENT_TOKEN && process.env.ALLOW_DEFAULT_TOKEN !== "1") {
  throw new Error(
    "AGENT_TOKEN is not set -- refusing to boot with the public default token. " +
      "Set AGENT_TOKEN (production) or ALLOW_DEFAULT_TOKEN=1 (dev)."
  );
}

export function isValidAgentToken(token: string): boolean {
  const a = Buffer.from(token);
  const b = Buffer.from(AGENT_TOKEN);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function hashPin(pin: string): Promise<string> {
  return bcrypt.hash(pin, 10);
}

export async function verifyPin(pin: string, pinHash: string): Promise<boolean> {
  return bcrypt.compare(pin, pinHash);
}
