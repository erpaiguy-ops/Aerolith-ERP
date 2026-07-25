import { Empty, PageHeader } from '@/components/ui';

/** See the note on the projects list: no list endpoint exists yet. */
export default function ContractsPage() {
  return (
    <>
      <PageHeader title="Contracts" subtitle="Variations, payment applications and retention." />
      <Empty
        title="No contract list endpoint yet"
        detail="Open a contract directly at /contracts/{id}. The list needs GET /contracts in the API, which is not built."
      />
    </>
  );
}
