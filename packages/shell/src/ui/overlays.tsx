// Modal, signature dialog (Part 11: meaning + re-authentication + reason) and toasts.
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button, TextField } from './basic.tsx';

export function Modal({ title, onClose, children, actions }: { title: string; onClose: () => void; children: ReactNode; actions?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); prev?.focus(); };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref}>
        <h2 id={titleId}>{title}</h2>
        {children}
        {actions ? <div className="modal-actions">{actions}</div> : null}
      </div>
    </div>
  );
}

/** Electronic signature: states what is signed and its meaning, asks for the password again and the reason. */
export function SignDialog({ title, meaning, what, confirmLabel, onSign, onClose, reasonDefault = '' }: {
  title: string; meaning: string; what: ReactNode; confirmLabel: string; reasonDefault?: string;
  onSign: (password: string, reason: string) => Promise<void>; onClose: () => void;
}) {
  const [password, setPassword] = useState('');
  const [reason, setReason] = useState(reasonDefault);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true); setError(null);
    try { await onSign(password, reason); } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return (
    <Modal title={title} onClose={onClose} actions={<>
      <Button onClick={onClose}>Cancel</Button>
      <Button variant="sign" disabled={!password || !reason.trim() || busy} onClick={submit}>{busy ? 'Signing…' : confirmLabel}</Button>
    </>}>
      <div className="sign-meaning"><strong>Meaning of this signature: {meaning}</strong><span>{what}</span></div>
      <TextField label="Reason" value={reason} onChange={e => setReason(e.target.value)} hint="Recorded in the audit trail" />
      <TextField label="Password" type="password" autoComplete="current-password" value={password}
        onChange={e => setPassword(e.target.value)} hint="Re-enter your password to sign" error={error ?? undefined}
        onKeyDown={e => { if (e.key === 'Enter' && password && reason.trim()) void submit(); }} />
    </Modal>
  );
}

interface Toast { id: number; text: string; error?: boolean }
const ToastCtx = createContext<(text: string, error?: boolean) => void>(() => undefined);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, error?: boolean) => {
    const id = Date.now() + Math.random();
    setToasts(t => [...t, { id, text, error }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 5000);
  }, []);
  return <ToastCtx.Provider value={push}>{children}<div className="toasts" role="status" aria-live="polite">
    {toasts.map(t => <div key={t.id} className={`toast ${t.error ? 'error' : ''}`}>{t.text}</div>)}</div></ToastCtx.Provider>;
}
export const useToast = () => useContext(ToastCtx);

/** Asks for the change reason that every GxP change needs (DM-03). */
export function ReasonDialog({ title, description, confirmLabel, onConfirm, onClose, reasonDefault = '' }: {
  title: string; description?: ReactNode; confirmLabel: string; reasonDefault?: string;
  onConfirm: (reason: string) => Promise<void>; onClose: () => void;
}) {
  const [reason, setReason] = useState(reasonDefault);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true); setError(null);
    try { await onConfirm(reason.trim()); } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return (
    <Modal title={title} onClose={onClose} actions={<>
      <Button onClick={onClose}>Cancel</Button>
      <Button variant="primary" disabled={!reason.trim() || busy} onClick={submit}>{busy ? 'Saving…' : confirmLabel}</Button>
    </>}>
      {description ? <p className="t-muted">{description}</p> : null}
      <TextField label="Reason for change" value={reason} onChange={e => setReason(e.target.value)} hint="Recorded in the audit trail"
        error={error ?? undefined} onKeyDown={e => { if (e.key === 'Enter' && reason.trim()) void submit(); }} />
    </Modal>
  );
}

export function Loading({ what = 'Loading' }: { what?: string }) { return <p className="t-muted" role="status">{what}…</p>; }
export function ErrorNote({ error }: { error: string }) { return <div className="empty" role="alert"><strong>Something went wrong</strong><span>{error}</span></div>; }
