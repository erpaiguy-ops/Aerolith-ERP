import type { Metadata } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: 'Aerolith Platform',
  description: 'Vendor operations — the estate, its entitlements and its lifecycle.',
  // This surface must never be indexed, and must never appear in a referrer.
  // It is not reachable anonymously either, but a login page that shows up in a
  // search result tells the internet where the door is.
  robots: { index: false, follow: false, nocache: true },
  referrer: 'no-referrer',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" dir="ltr">
      <body>{children}</body>
    </html>
  );
}
