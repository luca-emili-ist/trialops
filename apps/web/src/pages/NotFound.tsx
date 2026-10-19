// TRO-098 Page not found.
import { EmptyState, Button, useT } from '@trialops/shell';
import { go } from '../router.ts';

export function NotFound() {
  const t = useT();
  return <EmptyState title={t('This page does not exist')} action={<Button variant="primary" onClick={() => go('/')}>{t('Go to the platform overview')}</Button>}>
    {t('The link may be out of date.')}</EmptyState>;
}
