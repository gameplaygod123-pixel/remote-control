import { timingSafeEqual } from "crypto";
import bcrypt from "bcryptjs";

// Gates who may register an agent on this server, so it can't be used as an
// open relay by strangers. Personal-use default; override via env var.
const AGENT_TOKEN = process.env.AGENT_TOKEN ?? "dev-token-change-me";

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
