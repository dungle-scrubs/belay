const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** A compact relative-time label from two ISO timestamps (e.g. "2h ago", "just now"). */
export function relativeTime(thenIso: string, nowMs: number): string {
  const then = Date.parse(thenIso);
  if (Number.isNaN(then)) {
    return "";
  }
  const deltaMs = Math.max(0, nowMs - then);
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 45) {
    return "just now";
  }
  const min = Math.floor(sec / 60);
  if (min < 60) {
    return `${min}m ago`;
  }
  const hr = Math.floor(min / 60);
  if (hr < 24) {
    return `${hr}h ago`;
  }
  const day = Math.floor(hr / 24);
  if (day < 7) {
    return `${day}d ago`;
  }
  const wk = Math.floor(day / 7);
  if (wk <= 10) {
    return `${wk}w ago`;
  }
  // Past ~10 weeks the relative label stops growing and switches to a specific date. Formatting in
  // UTC keeps the label deterministic across viewer timezones.
  const d = new Date(then);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}
