import { NextResponse } from 'next/server';

import { currentToken } from '@/lib/session';

/**
 * Streams a payment application PDF from the API to the browser.
 *
 * A proxy rather than a link straight at the API, because the session token
 * lives in an httpOnly cookie: client JavaScript cannot read it, which is the
 * whole reason it is httpOnly, so the browser cannot put it in an
 * `Authorization` header. The alternative — a signed download URL — is the right
 * answer for documents in object storage and overkill for a document this
 * server can generate on demand.
 *
 * `apiFetch` is not used here on purpose. It parses the body as text and then
 * JSON, which for a PDF means decoding several kilobytes of binary through a
 * string and handing back something unusable.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const token = await currentToken();
  if (!token) return NextResponse.redirect(new URL('/login', _request.url), { status: 303 });

  const baseUrl = process.env.AEROLITH_API_URL ?? 'http://localhost:3001';
  const response = await fetch(`${baseUrl}/api/v1/contracts/applications/${id}/pdf`, {
    headers: { authorization: `Bearer ${token}` },
    cache: 'no-store',
  });

  if (!response.ok) {
    // The API's own status, not a generic failure: 403 and 404 mean different
    // things to whoever clicked, and both are answers rather than errors.
    return new NextResponse(null, { status: response.status });
  }

  return new NextResponse(await response.arrayBuffer(), {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      // Carried through so the file lands under its own document number rather
      // than as `pdf`, which is what a route segment would otherwise name it.
      'content-disposition':
        response.headers.get('content-disposition') ?? 'attachment; filename="application.pdf"',
      'cache-control': 'no-store',
    },
  });
}
