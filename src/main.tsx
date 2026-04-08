import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { AuthProvider } from './lib/AuthContext';
import { Toaster } from 'sonner';
import { ErrorBoundary } from './components/ErrorBoundary';

// Polyfill process for libraries that expect it in the browser
if (typeof window !== 'undefined' && !(window as any).process) {
  (window as any).process = { env: {} };
}

console.log('App starting...');

try {
  const rootElement = document.getElementById('root');
  if (!rootElement) throw new Error('Root element not found');

  createRoot(rootElement).render(
    <ErrorBoundary>
      <AuthProvider>
        <App />
        <Toaster position="top-center" richColors />
      </AuthProvider>
    </ErrorBoundary>
  );
  console.log('App rendered');
} catch (err) {
  console.error('Failed to render app:', err);
}

