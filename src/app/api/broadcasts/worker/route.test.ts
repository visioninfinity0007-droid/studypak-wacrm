import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ runQueueTick: vi.fn(), verifyGithubActionsToken: vi.fn() }));

vi.mock('@/lib/supabase/admin', () => ({
  supabaseServiceRole: () => ({ service: true }),
}));

vi.mock('@/lib/whatsapp/broadcast-queue', () => ({
  runQueueTick: h.runQueueTick,
}));

vi.mock('@/lib/github-actions-oidc', () => ({
  verifyGithubActionsToken: h.verifyGithubActionsToken,
}));

import { GET } from './route';

const originalAutomationSecret = process.env.AUTOMATION_CRON_SECRET;
const originalCronSecret = process.env.CRON_SECRET;

beforeEach(() => {
  delete process.env.AUTOMATION_CRON_SECRET;
  delete process.env.CRON_SECRET;
  h.runQueueTick.mockReset();
  h.runQueueTick.mockResolvedValue([]);
  h.verifyGithubActionsToken.mockReset();
  h.verifyGithubActionsToken.mockResolvedValue(false);
});

afterEach(() => {
  if (originalAutomationSecret === undefined) delete process.env.AUTOMATION_CRON_SECRET;
  else process.env.AUTOMATION_CRON_SECRET = originalAutomationSecret;
  if (originalCronSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalCronSecret;
});

describe('GET /api/broadcasts/worker authentication', () => {
  it('accepts the Vercel Cron bearer token', async () => {
    process.env.CRON_SECRET = 'vercel-secret';
    const response = await GET(new Request('http://x', {
      headers: { authorization: 'Bearer vercel-secret' },
    }));

    expect(response.status).toBe(200);
    expect(h.runQueueTick).toHaveBeenCalledOnce();
  });

  it('keeps accepting the self-hosted cron header', async () => {
    process.env.AUTOMATION_CRON_SECRET = 'self-hosted-secret';
    const response = await GET(new Request('http://x', {
      headers: { 'x-cron-secret': 'self-hosted-secret' },
    }));

    expect(response.status).toBe(200);
    expect(h.runQueueTick).toHaveBeenCalledOnce();
  });

  it('accepts a verified GitHub Actions identity token', async () => {
    h.verifyGithubActionsToken.mockResolvedValue(true);
    const response = await GET(new Request('http://x', {
      headers: { authorization: 'Bearer github-oidc-token' },
    }));

    expect(response.status).toBe(200);
    expect(h.verifyGithubActionsToken).toHaveBeenCalledWith('github-oidc-token');
    expect(h.runQueueTick).toHaveBeenCalledOnce();
  });

  it('rejects a missing or incorrect token', async () => {
    process.env.CRON_SECRET = 'vercel-secret';

    expect((await GET(new Request('http://x'))).status).toBe(401);
    expect((await GET(new Request('http://x', {
      headers: { authorization: 'Bearer wrong-secret' },
    }))).status).toBe(401);
    expect(h.runQueueTick).not.toHaveBeenCalled();
  });

  it('reports a missing scheduler configuration', async () => {
    expect((await GET(new Request('http://x'))).status).toBe(503);
  });
});
