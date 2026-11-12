import path from 'node:path';
import type { NextConfig } from 'next';

const API_URL = process.env.API_URL ?? 'http://localhost:4000';
const isDev = process.env.NODE_ENV !== 'production';

// Strict CSP. Next.js needs inline bootstrap scripts; nothing is loaded from third-party origins.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

const config: NextConfig = {
  // Monorepo root (stops Next picking up unrelated lockfiles higher up the disk).
  outputFileTracingRoot: path.join(__dirname, '../..'),
  poweredByHeader: false,
  devIndicators: false,
  reactStrictMode: true,
  transpilePackages: ['@einv/shared'],
  // The browser only ever talks to this origin; /api/* is proxied to the Nest API.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API_URL}/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
      { source: '/i/:token*', headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }] },
      // E8-1: the IRN check may scan a QR code with this site's own camera access (later rules win).
      { source: '/verify', headers: [{ key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' }] },
      { source: '/billing/test-checkout', headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }] },
    ];
  },
};

export default config;
