'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { ActivityOverview, BroadcastsOverview } from '@/components/admin/admin-oversight';
import { CollegesAdmin } from '@/components/admin/colleges-admin';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/hooks/use-auth';
import type { CollegeRef } from '@/lib/admin/oversight';

type Tab = 'colleges' | 'broadcasts' | 'activity';

export default function AdminPage() {
  const t = useTranslations('Admin');
  const { isPlatformAdmin } = useAuth();
  const [tab, setTab] = useState<Tab>('colleges');
  const [collegeId, setCollegeId] = useState('');
  const [colleges, setColleges] = useState<CollegeRef[]>([]);

  // Names for the college filter on the Campaigns and Activity tabs;
  // bumped when a college is created so the filter lists it.
  const [collegesVersion, setCollegesVersion] = useState(0);

  useEffect(() => {
    if (!isPlatformAdmin) return;
    let cancelled = false;
    void (async () => {
      const res = await fetch('/api/admin/colleges', { cache: 'no-store' }).catch(() => null);
      if (!res?.ok) return;
      const body = (await res.json()) as { colleges: CollegeRef[] };
      if (!cancelled) setColleges(body.colleges.map(({ id, name }) => ({ id, name })));
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

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
      <TabsList>
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
        <BroadcastsOverview colleges={colleges} collegeId={collegeId} onCollegeChange={setCollegeId} />
      </TabsContent>
      <TabsContent value="activity" className="mt-4">
        <ActivityOverview colleges={colleges} collegeId={collegeId} onCollegeChange={setCollegeId} />
      </TabsContent>
    </Tabs>
  );
}
