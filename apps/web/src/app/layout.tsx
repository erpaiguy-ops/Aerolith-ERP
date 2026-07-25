import type { Metadata } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: 'Aerolith ERP',
  description: 'Joinery ERP — estimating, production, projects and contract administration.',
};

/**
 * The root layout is deliberately thin.
 *
 * `lang` and `dir` are set per-request in the authenticated layout, from the
 * signed-in user's locale, because Arabic is a first-class requirement rather
 * than a later translation pass. Setting them here would freeze them to English.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" dir="ltr">
      <body>{children}</body>
    </html>
  );
}
