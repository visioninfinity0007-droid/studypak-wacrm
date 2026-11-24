import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from './route';
import { ForbiddenError, requireRole } from '@/lib/auth/account';
import { requirePlatformAdmin } from '@/lib/auth/platform-admin';

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  requireRole: vi.fn(),
}));
vi.mock('@/lib/auth/platform-admin', () => ({ requirePlatformAdmin: vi.fn() }));

function lookup() {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn(),
  };
}
const member = lookup();
const platform = lookup();
const updateUserById = vi.fn();

function issue(userId = 'teammate') {
  return POST(
    new Request(
      'https://example.org/api/account/members/' + userId + '/reset-password',
      {
        method: 'POST',
        headers: { 'X-Requested-With': 'StudyPak' },
      }
    ),
    { params: Promise.resolve({ userId }) }
  );
}

beforeEach(() => {
  vi.mocked(requirePlatformAdmin).mockResolvedValue({
    userId: 'issuer',
    admin: { from: () => platform, auth: { admin: { updateUserById } } },
  } as unknown as Awaited<ReturnType<typeof requirePlatformAdmin>>);
  vi.mocked(requireRole).mockResolvedValue({
    userId: 'issuer',
    accountId: 'workspace',
    supabase: { from: () => member },
  } as unknown as Awaited<ReturnType<typeof requireRole>>);
  platform.maybeSingle.mockResolvedValue({ data: null });
  member.maybeSingle.mockResolvedValue({ data: { user_id: 'teammate' } });
  updateUserById.mockResolvedValue({
    data: { user: { email: 'member@example.org' } },
  });
});

describe('issuing a team member password', () => {
  it('restricts the lookup and returns the issued credential only in an uncached response', async () => {
    const res = await issue();
    expect(res.status).toBe(200);
    expect(member.eq).toHaveBeenCalledWith('account_id', 'workspace');
    expect(member.eq).toHaveBeenCalledWith('user_id', 'teammate');
    expect(member.in).toHaveBeenCalledWith('account_role', [
      'admin',
      'agent',
      'viewer',
    ]);
    expect(res.headers.get('cache-control')).toContain('no-store');
    const { login } = await res.json();
    expect(login.email).toBe('member@example.org');
    expect(login.tempPassword.length).toBeGreaterThanOrEqual(14);
    expect(updateUserById).toHaveBeenCalledWith('teammate', {
      password: login.tempPassword,
    });
  });

  it.each([
    'platform privilege',
    'workspace privilege',
    'outside workspace',
    'protected target',
    'self',
  ])('rejects an ineligible reset (%s)', async (reason) => {
    if (reason === 'platform privilege')
      vi.mocked(requirePlatformAdmin).mockRejectedValue(new ForbiddenError());
    if (reason === 'workspace privilege')
      vi.mocked(requireRole).mockRejectedValue(new ForbiddenError());
    if (reason === 'outside workspace')
      member.maybeSingle.mockResolvedValue({ data: null });
    if (reason === 'protected target')
      platform.maybeSingle.mockResolvedValue({ data: { user_id: 'teammate' } });
    expect(
      (await issue(reason === 'self' ? 'issuer' : 'teammate')).status
    ).toBe(403);
    expect(updateUserById).not.toHaveBeenCalled();
  });
});
