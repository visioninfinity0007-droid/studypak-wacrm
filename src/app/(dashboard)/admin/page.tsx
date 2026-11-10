'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Building2, Megaphone, MessageCircleMore, Users } from 'lucide-react';

import {
  ActivityOverview,
  BroadcastsOverview,
} from '@/components/admin/admin-oversight';
import { CollegesAdmin } from '@/components/admin/colleges-admin';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/hooks/use-auth';
import type { CollegeRef } from '@/lib/admin/oversight';

type Tab = 'colleges' | 'broadcasts' | 'activity';

interface CollegeSummary extends CollegeRef {
  status: 'active' | 'pending' | 'suspended';
  members: number;
  contacts: number;
  broadcasts: number;
  whatsapp: { connected: boolean } | null;
}

function MetricCard({
  label,
  value,
  detail,
  icon: Icon,
}: {
  label: string;
  value: number;
  detail: string;
  icon: typeof Building2;
}) {
  return (
    <Card className="border-border bg-card overflow-hidden">
      <CardContent className="flex items-center gap-4 p-4 sm:p-5">
        <span className="bg-primary/10 text-primary flex size-11 shrink-0 items-center justify-center rounded-xl">
          <Icon className="size-5" />
        </span>
        <div className="min-w-0">
          <p className="text-foreground text-2xl font-semibold tabular-nums">
            {value.toLocaleString()}
          </p>
          <p className="text-foreground text-sm font-medium">{label}</p>
          <p className="text-muted-foreground truncate text-xs">{detail}</p>
        </div>
      </CardContent>
    </Card>
  );
}

export default function AdminPage() {
  const t = useTranslations('Admin');
  const { isPlatformAdmin } = useAuth();
  const [tab, setTab] = useState<Tab>('colleges');
  const [collegeId, setCollegeId] = useState('');
  const [colleges, setColleges] = useState<CollegeSummary[]>([]);

  // Names for the college filter on the Campaigns and Activity tabs;
  // bumped when a college is created so the filter lists it.
  const [collegesVersion, setCollegesVersion] = useState(0);

  useEffect(() => {
    if (!isPlatformAdmin) return;
    let cancelled = false;
    void (async () => {
      const res = await fetch('/api/admin/colleges', {
        cache: 'no-store',
      }).catch(() => null);
      if (!res?.ok) return;
      const body = (await res.json()) as { colleges: CollegeSummary[] };
      if (!cancelled) setColleges(body.colleges);
    })();
    return () => {
      cancelled = true;
    };
  }, [isPlatformAdmin, collegesVersion]);

  const show = (next: Tab) => (id: string) => {
    setCollegeId(id);
    setTab(next);
  };

  if (!isPlatformAdmin) return <CollegesAdmin />;

  const activeColleges = colleges.filter(
    (college) => college.status === 'active'
  ).length;
  const connectedColleges = colleges.filter(
    (college) => college.whatsapp?.connected
  ).length;
  const members = colleges.reduce(
    (total, college) => total + college.members,
    0
  );
  const contacts = colleges.reduce(
    (total, college) => total + college.contacts,
    0
  );
  const broadcasts = colleges.reduce(
    (total, college) => total + college.broadcasts,
    0
  );

  return (
    <div className="space-y-6">
      <div>
        <p className="text-primary text-xs font-semibold tracking-[0.18em] uppercase">
          {t('platformLabel')}
        </p>
        <h1 className="text-foreground mt-1 text-3xl font-semibold tracking-tight">
          {t('portalTitle')}
        </h1>
        <p className="text-muted-foreground mt-2 max-w-2xl text-sm">
          {t('portalDescription')}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label={t('metricColleges')}
          value={colleges.length}
          detail={t('metricCollegesDetail', { active: activeColleges })}
          icon={Building2}
        />
        <MetricCard
          label={t('metricUsers')}
          value={members}
          detail={t('metricUsersDetail')}
          icon={Users}
        />
        <MetricCard
          label={t('metricContacts')}
          value={contacts}
          detail={t('metricContactsDetail', { connected: connectedColleges })}
          icon={MessageCircleMore}
        />
        <MetricCard
          label={t('metricCampaigns')}
          value={broadcasts}
          detail={t('metricCampaignsDetail')}
          icon={Megaphone}
        />
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList className="w-full justify-start overflow-x-auto sm:w-auto">
          <TabsTrigger value="colleges">{t('tabColleges')}</TabsTrigger>
          <TabsTrigger value="broadcasts">{t('tabCampaigns')}</TabsTrigger>
          <TabsTrigger value="activity">{t('tabActivity')}</TabsTrigger>
        </TabsList>
        <TabsContent value="colleges" className="mt-4">
          <CollegesAdmin
            onShowBroadcasts={show('broadcasts')}
            onShowActivity={show('activity')}
            onChanged={() => setCollegesVersion((v) => v + 1)}
          />
        </TabsContent>
        <TabsContent value="broadcasts" className="mt-4">
          <BroadcastsOverview
            colleges={colleges}
            collegeId={collegeId}
            onCollegeChange={setCollegeId}
          />
        </TabsContent>
        <TabsContent value="activity" className="mt-4">
          <ActivityOverview
            colleges={colleges}
            collegeId={collegeId}
            onCollegeChange={setCollegeId}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
