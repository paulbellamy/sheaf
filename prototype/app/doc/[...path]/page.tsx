import { DocShell } from "@/components/DocShell";
import { DocView } from "@/components/DocView";

export const dynamic = "force-dynamic";

type Ctx = {
  params: Promise<{ path: string[] }>;
  searchParams: Promise<{ ref?: string }>;
};

export default async function DocPage({ params, searchParams }: Ctx) {
  const { path } = await params;
  const { ref } = await searchParams;
  const p = path.join("/");
  return (
    <DocShell activePath={p} activeRef={ref}>
      <DocView path={p} docRef={ref} />
    </DocShell>
  );
}
