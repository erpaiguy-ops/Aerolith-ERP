import { Empty, PageHeader } from '@/components/ui';

/**
 * The project list.
 *
 * A placeholder that says so, rather than a fake table. The API has no list
 * endpoint for `kernel.project` yet — every screen so far reaches a project by
 * id — and inventing rows here would make the gap invisible in a demo.
 */
export default function ProjectsPage() {
  return (
    <>
      <PageHeader title="Projects" subtitle="Delivery, budgets and job costing." />
      <Empty
        title="No project list endpoint yet"
        detail="Open a project directly at /projects/{id}. The list needs GET /projects in the API, which is not built."
      />
    </>
  );
}
