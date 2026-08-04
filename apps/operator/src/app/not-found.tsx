import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="max-w-sm text-center">
        <h1 className="text-lg font-semibold">Not found</h1>
        <p className="mt-1 text-sm text-(--color-muted)">
          No customer with that id, or the address is wrong.
        </p>
        <Link href="/" className="mt-4 inline-block text-sm text-(--color-accent) hover:underline">
          ← The estate
        </Link>
      </div>
    </main>
  );
}
