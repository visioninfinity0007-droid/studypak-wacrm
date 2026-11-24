import { NextResponse } from 'next/server';
import { generateTempPassword } from '@/lib/admin/colleges';
import {
  ForbiddenError,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import { requirePlatformAdmin } from '@/lib/auth/platform-admin';
import { getT } from '@/lib/i18n/translate';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

const t = getT('Api.account.members');

export async function POST(
  request: Request,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    if (request.headers.get('x-requested-with') !== 'StudyPak')
      throw new ForbiddenError();
    const { admin, userId: actorId } = await requirePlatformAdmin();
    const ctx = await requireRole('admin');
    const { userId } = await params;
    if (actorId !== ctx.userId || userId === actorId)
      throw new ForbiddenError();

    const limit = checkRateLimit(
      `admin:memberPassword:${actorId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const [member, platformAdmin] = await Promise.all([
      ctx.supabase
        .from('profiles')
        .select('user_id')
        .eq('account_id', ctx.accountId)
        .eq('user_id', userId)
        .in('account_role', ['admin', 'agent', 'viewer'])
        .maybeSingle(),
      admin
        .from('platform_admins')
        .select('user_id')
        .eq('user_id', userId)
        .maybeSingle(),
    ]);
    if (member.error || platformAdmin.error) {
      return NextResponse.json({ error: t('updateFailed') }, { status: 500 });
    }
    if (!member.data || platformAdmin.data) throw new ForbiddenError();

    const tempPassword = generateTempPassword();
    const { data, error } = await admin.auth.admin.updateUserById(userId, {
      password: tempPassword,
    });
    if (error || !data.user) {
      return NextResponse.json({ error: t('updateFailed') }, { status: 500 });
    }
    return NextResponse.json(
      { login: { email: data.user.email, tempPassword } },
      { headers: { 'Cache-Control': 'private, no-store' } }
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}
