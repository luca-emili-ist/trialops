// TRO-098 Page not found.
import { EmptyState, Button } from '@trialops/shell';
import { go } from '../router.ts';

export function NotFound() {
  return <EmptyState title="This page does not exist" action={<Button variant="primary" onClick={() => go('/')}>Go to the platform overview</Button>}>
    The link may be out of date.</EmptyState>;
}
