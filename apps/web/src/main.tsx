import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@trialops/shell/tokens.css';
import '@trialops/shell/shell.css';
import { ToastProvider } from '@trialops/shell';
import { SessionProvider } from './session.tsx';
import { App } from './App.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode><ToastProvider><SessionProvider><App /></SessionProvider></ToastProvider></StrictMode>,
);
