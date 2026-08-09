/**
 * "2 hours ago", falling back to a date past a week.
 *
 * Relative is what a handover reads as — "did this happen while I was at lunch,
 * or in March?" — and it stops being useful once the answer is "a while ago",
 * where an actual date is the more informative thing.
 *
 * Shared by the Delegation page and its cards so the same handback cannot be
 * described two ways on one screen.
 */
export function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(hours / 24);
  if (days <= 7) return `${days} ${days === 1 ? "day" : "days"} ago`;
  return new Date(iso).toLocaleString();
}
