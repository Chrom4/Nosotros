/**
 * Local-calendar ISO helpers. Avoid `Date#toISOString().slice(0, 10)`, which
 * uses UTC and shifts the calendar day after ~21h in Brazil (UTC-3).
 */

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

export function formatLocalIsoDate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function todayLocalIso(now: Date = new Date()): string {
  return formatLocalIsoDate(now);
}

export function yesterdayLocalIso(now: Date = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  return formatLocalIsoDate(d);
}

export function currentLocalMonthIso(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;
}
