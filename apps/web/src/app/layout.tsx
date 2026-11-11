import type { Metadata, Viewport } from 'next';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'E-Invoice — cleared invoices for Nigerian businesses', template: '%s · E-Invoice' },
  description: 'Create invoices that NRS clears through MBS, share them on WhatsApp, and stay compliant.',
  robots: { index: false },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#166534' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-NG">
      <body className="min-h-dvh font-sans">
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-white focus:px-3 focus:py-2 focus:shadow">
          Skip to content
        </a>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
