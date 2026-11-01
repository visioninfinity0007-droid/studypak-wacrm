import { beforeEach, describe, expect, it, vi } from 'vitest'

const updates: Record<string, unknown>[] = []
let storedConfig: Record<string, unknown> = {}

function makeSupabaseMock() {
  function builder(table: string) {
    const b: Record<string, unknown> = {}
    const chain = () => b
    for (const m of ['select', 'eq']) b[m] = vi.fn(chain)
    b.update = vi.fn((patch: Record<string, unknown>) => {
      if (table === 'whatsapp_config') updates.push(patch)
      return b
    })
    b.maybeSingle = vi.fn(async () =>
      table === 'profiles'
        ? { data: { account_id: 'acct-1' }, error: null }
        : { data: storedConfig, error: null },
    )
    b.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null })
    return b
  }
  return {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } }, error: null })) },
    from: vi.fn((table: string) => builder(table)),
  }
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => makeSupabaseMock()),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: vi.fn(() => 'token') }))

const meta = vi.hoisted(() => ({
  verifyPhoneNumber: vi.fn(),
  getSubscribedApps: vi.fn(),
}))
vi.mock('@/lib/whatsapp/meta-api', () => meta)

import { GET } from './route'

describe('GET /api/whatsapp/config/verify-registration', () => {
  beforeEach(() => {
    updates.length = 0
    storedConfig = {
      phone_number_id: '111',
      waba_id: '222',
      access_token: 'enc',
      registered_at: null,
      last_registration_error: null,
    }
    meta.getSubscribedApps.mockResolvedValue([{ id: 'app' }])
  })

  it('stamps a number Meta already has on the Cloud API', async () => {
    meta.verifyPhoneNumber.mockResolvedValue({ id: '111', platform_type: 'CLOUD_API' })
    const body = await (await GET()).json()
    expect(body.live).toBe(true)
    expect(body.registered_at).toEqual(expect.any(String))
    expect(updates).toEqual([{ registered_at: body.registered_at, last_registration_error: null }])
  })

  it('keeps warning when Meta does not have the number on the Cloud API', async () => {
    meta.verifyPhoneNumber.mockResolvedValue({ id: '111', platform_type: 'NOT_APPLICABLE' })
    const body = await (await GET()).json()
    expect(body.live).toBe(false)
    expect(updates).toEqual([])
  })

  it('keeps warning when no app is subscribed to the WABA', async () => {
    meta.verifyPhoneNumber.mockResolvedValue({ id: '111', platform_type: 'CLOUD_API' })
    meta.getSubscribedApps.mockResolvedValue([])
    const body = await (await GET()).json()
    expect(body.live).toBe(false)
    expect(updates).toEqual([])
  })

  it('leaves an already registered number alone', async () => {
    storedConfig.registered_at = '2026-10-22T11:33:15Z'
    meta.verifyPhoneNumber.mockResolvedValue({ id: '111', platform_type: 'CLOUD_API' })
    const body = await (await GET()).json()
    expect(body.live).toBe(true)
    expect(body.registered_at).toBe('2026-10-22T11:33:15Z')
    expect(updates).toEqual([])
  })
})
