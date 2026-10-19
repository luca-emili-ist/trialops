import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@trialops/shell/tokens.css';
import '@trialops/shell/shell.css';
import { ToastProvider, I18nProvider } from '@trialops/shell';
import { CATALOGUES } from './i18n/index.ts';
import { SessionProvider } from './session.tsx';
import { App } from './App.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode><I18nProvider catalogues={CATALOGUES}><ToastProvider><SessionProvider><App /></SessionProvider></ToastProvider></I18nProvider></StrictMode>,
);
