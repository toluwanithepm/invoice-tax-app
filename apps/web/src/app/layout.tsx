import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { Providers } from './providers';
import './globals.css';

// Self-hosted at build time by next/font: no request to Google from the browser (CSP stays 'self').
const geist = Geist({ subsets: ['latin'], display: 'swap', variable: '--font-geist' });
const geistMono = Geist_Mono({ subsets: ['latin'], display: 'swap', variable: '--font-geist-mono' });

export const metadata: Metadata = {
  title: { default: 'E-Invoice — NRS-cleared invoices for Nigerian businesses', template: '%s · E-Invoice' },
  description: 'Create invoices the Nigeria Revenue Service clears in seconds, send them on WhatsApp, and file VAT without the headache.',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#13643a' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-NG" className={`${geist.variable} ${geistMono.variable}`}>
      <body className="min-h-dvh font-sans">
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-white focus:px-3 focus:py-2 focus:shadow-pop">
          Skip to content
        </a>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
