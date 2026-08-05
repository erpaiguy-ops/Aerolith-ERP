import type { Metadata } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: 'Aerolith ERP',
  description: 'Joinery ERP — estimating, production, projects and contract administration.',
};

/**
 * The root layout is deliberately thin.
 *
 * The `lang` and `dir` here are the pre-authentication defaults — the sign-in
 * page, which has no user and therefore no locale. Only the root layout may
 * render `<html>` in the App Router, so the authenticated shell sets `lang` and
 * `dir` again on its own wrapper once the user is known; that is valid, scoped
 * to the subtree that matters, and the reason these are not left unset.
 *
 * (This comment previously claimed the authenticated layout set them "per
 * request" as though these values were never used. They are: every unauthed
 * page renders under them.)
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" dir="ltr">
      <body>{children}</body>
    </html>
  );
}
