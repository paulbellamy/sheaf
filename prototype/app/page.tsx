import { Dashboard } from "@/components/Dashboard";

export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <main className="page-shell">
      <Dashboard />
    </main>
  );
}
