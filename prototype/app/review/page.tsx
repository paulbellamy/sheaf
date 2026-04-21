import { DraftReview } from "@/components/DraftReview";

export const dynamic = "force-dynamic";

export default function ReviewPage() {
  return (
    <main className="review-root">
      <DraftReview />
    </main>
  );
}
