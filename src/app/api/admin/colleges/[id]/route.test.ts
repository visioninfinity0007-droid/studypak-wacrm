import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DELETE } from './route';
import { ForbiddenError } from '@/lib/auth/account';
import { requirePlatformAdmin } from '@/lib/auth/platform-admin';

vi.mock('@/lib/auth/platform-admin', () => ({ requirePlatformAdmin: vi.fn() }));

const rpc = vi.fn();
const remove = vi.fn();
const bucket = vi.fn(() => ({ remove }));
const id = '0aba3694-451c-4c21-bbe1-90c5b3810792';

function deleteCollege(confirmation = 'Example College', includeHeader = true) {
  return DELETE(
    new Request(`https://example.org/api/admin/colleges/${id}`, {
      method: 'DELETE',
      headers: includeHeader ? { 'X-Requested-With': 'StudyPak' } : {},
      body: JSON.stringify({ confirmation }),
    }),
    { params: Promise.resolve({ id }) },
  );
}

beforeEach(() => {
  vi.mocked(requirePlatformAdmin).mockReset();
  rpc.mockReset();
  remove.mockReset();
  bucket.mockClear();
  vi.mocked(requirePlatformAdmin).mockResolvedValue({
    userId: 'platform-admin',
    admin: { rpc, storage: { from: bucket } },
  } as unknown as Awaited<ReturnType<typeof requirePlatformAdmin>>);
  remove.mockResolvedValue({ error: null });
});

describe('permanently deleting a suspended college', () => {
  it('requires the platform session, request header, and typed confirmation', async () => {
    expect((await deleteCollege('Example College', false)).status).toBe(403);
    expect((await deleteCollege(' ')).status).toBe(400);
    vi.mocked(requirePlatformAdmin).mockRejectedValue(new ForbiddenError());
    expect((await deleteCollege()).status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['not_suspended', 409],
    ['name_mismatch', 409],
    ['protected', 409],
    ['not_found', 404],
  ])('does not touch Storage when the database reports %s', async (status, expected) => {
    rpc.mockResolvedValue({ data: { status } });
    expect((await deleteCollege()).status).toBe(expected);
    expect(rpc).toHaveBeenCalledWith('delete_suspended_college', {
      p_account_id: id,
      p_actor_id: 'platform-admin',
      p_confirmation: 'Example College',
    });
    expect(remove).not.toHaveBeenCalled();
  });

  it('removes only the files returned by the database before finishing', async () => {
    rpc.mockResolvedValueOnce({
      data: {
        status: 'remove_files',
        objects: [
          { bucket: 'chat-media', path: 'account-target/chat.pdf' },
          { bucket: 'avatars', path: 'member/avatar.png' },
          { bucket: 'chat-media', path: 'account-target/inbound/photo.png' },
        ],
      },
    }).mockResolvedValueOnce({ data: { status: 'deleted' } });

    expect((await deleteCollege()).status).toBe(204);
    expect(bucket).toHaveBeenNthCalledWith(1, 'chat-media');
    expect(bucket).toHaveBeenNthCalledWith(2, 'avatars');
    expect(remove).toHaveBeenNthCalledWith(1, ['account-target/chat.pdf', 'account-target/inbound/photo.png']);
    expect(remove).toHaveBeenNthCalledWith(2, ['member/avatar.png']);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('leaves the college ready to retry when Storage rejects a batch', async () => {
    rpc.mockResolvedValue({
      data: { status: 'remove_files', objects: [{ bucket: 'avatars', path: 'member/avatar.png' }] },
    });
    remove.mockResolvedValue({ error: { name: 'StorageError' } });

    expect((await deleteCollege()).status).toBe(502);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
