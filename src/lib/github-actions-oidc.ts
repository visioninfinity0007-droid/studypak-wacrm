import { createPublicKey, verify } from 'node:crypto';

const ISSUER = 'https://token.actions.githubusercontent.com';
const JWKS_URL = `${ISSUER}/.well-known/jwks`;
export const BROADCAST_WORKER_AUDIENCE = 'studypak-broadcast-worker';
export const BROADCAST_WORKER_REPOSITORY = 'watimedu/studypak-wacrm';

interface JwtHeader {
  alg?: unknown;
  kid?: unknown;
}

interface JwtPayload {
  aud?: unknown;
  exp?: unknown;
  iss?: unknown;
  nbf?: unknown;
  ref?: unknown;
  repository?: unknown;
}

interface Jwk extends JsonWebKey {
  kid?: string;
}

let cachedKeys: { expiresAt: number; keys: Jwk[] } | null = null;

function decodePart<T>(part: string): T | null {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

async function signingKeys(nowMs: number): Promise<Jwk[]> {
  if (cachedKeys && cachedKeys.expiresAt > nowMs) return cachedKeys.keys;
  const response = await fetch(JWKS_URL, { cache: 'no-store' });
  if (!response.ok) throw new Error(`GitHub OIDC keys unavailable (${response.status})`);
  const body = await response.json() as { keys?: unknown };
  const keys = Array.isArray(body.keys) ? body.keys as Jwk[] : [];
  cachedKeys = { keys, expiresAt: nowMs + 60 * 60_000 };
  return keys;
}

/** Verify a short-lived identity token issued to this repository's main branch. */
export async function verifyGithubActionsToken(token: string, nowMs = Date.now()): Promise<boolean> {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const header = decodePart<JwtHeader>(parts[0]);
  const payload = decodePart<JwtPayload>(parts[1]);
  if (!header || !payload || header.alg !== 'RS256' || typeof header.kid !== 'string') return false;

  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  const nowSeconds = Math.floor(nowMs / 1000);
  if (
    payload.iss !== ISSUER ||
    !audience.includes(BROADCAST_WORKER_AUDIENCE) ||
    payload.repository !== BROADCAST_WORKER_REPOSITORY ||
    payload.ref !== 'refs/heads/main' ||
    typeof payload.exp !== 'number' ||
    payload.exp <= nowSeconds ||
    (typeof payload.nbf === 'number' && payload.nbf > nowSeconds)
  ) return false;

  const key = (await signingKeys(nowMs)).find((candidate) => candidate.kid === header.kid);
  if (!key) return false;
  return verify(
    'RSA-SHA256',
    Buffer.from(`${parts[0]}.${parts[1]}`),
    createPublicKey({ key, format: 'jwk' }),
    Buffer.from(parts[2], 'base64url'),
  );
}

