'use client';

import { Copy } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export interface Login {
  email: string;
  tempPassword: string;
}

export function LoginDialog({
  value,
  onClose,
}: {
  value: { title: string; login: Login } | null;
  onClose: () => void;
}) {
  const t = useTranslations('Admin');

  async function copy() {
    try {
      if (!value) return;
      await navigator.clipboard.writeText(
        t('loginShareText', {
          url: window.location.origin,
          email: value.login.email,
          password: value.login.tempPassword,
        })
      );
      toast.success(t('copied'));
    } catch {
      toast.error(t('clipboardBlocked'));
    }
  }

  return (
    <Dialog open={!!value} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="bg-popover border-border sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {value?.title}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t('loginOnce')}
          </DialogDescription>
        </DialogHeader>
        {value && (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-muted-foreground">{t('loginEmail')}</Label>
              <Input readOnly value={value.login.email} />
            </div>
            <div className="space-y-1">
              <Label className="text-muted-foreground">
                {t('loginPassword')}
              </Label>
              <Input
                readOnly
                value={value.login.tempPassword}
                className="font-mono"
              />
            </div>
          </div>
        )}
        <DialogFooter className="bg-popover border-border">
          <Button variant="outline" onClick={() => void copy()}>
            <Copy className="h-4 w-4" />
            {t('copy')}
          </Button>
          <Button onClick={onClose}>{t('done')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
