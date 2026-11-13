/**
 * @jest-environment node
 */
import {
  currentLocalMonthIso,
  formatLocalIsoDate,
  todayLocalIso,
  yesterdayLocalIso,
} from '@/utils/localDate';

describe('localDate helpers', () => {
  it('formats local calendar dates without UTC shift', () => {
    // 2026-11-12 22:30 in UTC-3 == 2026-11-13 01:30 UTC
    const lateEveningBrt = new Date(2026, 10, 12, 22, 30, 0);
    expect(formatLocalIsoDate(lateEveningBrt)).toBe('2026-11-12');
    expect(todayLocalIso(lateEveningBrt)).toBe('2026-11-12');
    expect(yesterdayLocalIso(lateEveningBrt)).toBe('2026-11-11');
    expect(currentLocalMonthIso(lateEveningBrt)).toBe('2026-11');
  });

  it('does not use UTC day boundary for late BRT evenings', () => {
    const lateEveningBrt = new Date(2026, 10, 12, 22, 30, 0);
    const utcSlice = lateEveningBrt.toISOString().slice(0, 10);
    expect(utcSlice).toBe('2026-11-13');
    expect(todayLocalIso(lateEveningBrt)).not.toBe(utcSlice);
  });
});
