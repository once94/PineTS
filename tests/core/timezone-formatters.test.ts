import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDatePartsInTimezone } from '../../src/namespaces/Time';

afterEach(() => vi.restoreAllMocks());

describe('timezone formatter reuse', () => {
    it('reuses a formatter while still computing each timestamp across DST', async () => {
        vi.resetModules();
        const { getDatePartsInTimezone: parts } = await import('../../src/namespaces/Time');
        const Original = Intl.DateTimeFormat;
        const ctor = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (locales, options) {
            return new Original(locales, options);
        } as typeof Intl.DateTimeFormat);
        expect(parts(Date.parse('2026-03-08T06:59:59Z'), 'America/New_York')).toEqual({
            year: 2026, month: 3, day: 8, hour: 1, minute: 59, second: 59, dayOfWeek: 0,
        });
        expect(parts(Date.parse('2026-03-08T07:00:00Z'), 'America/New_York')).toEqual({
            year: 2026, month: 3, day: 8, hour: 3, minute: 0, second: 0, dayOfWeek: 0,
        });
        expect(parts(Date.parse('2026-11-01T05:30:00Z'), 'America/New_York').hour).toBe(1);
        expect(parts(Date.parse('2026-11-01T06:30:00Z'), 'America/New_York').hour).toBe(1);
        expect(ctor).toHaveBeenCalledTimes(1);
    });

    it('keeps different zones separate and returns independent result objects', () => {
        const t = Date.parse('2026-01-01T00:00:00Z');
        const ny = getDatePartsInTimezone(t, 'America/New_York');
        const tokyo = getDatePartsInTimezone(t, 'Asia/Tokyo');
        expect(ny).toEqual({ year: 2025, month: 12, day: 31, hour: 19, minute: 0, second: 0, dayOfWeek: 3 });
        expect(tokyo).toEqual({ year: 2026, month: 1, day: 1, hour: 9, minute: 0, second: 0, dayOfWeek: 4 });
        ny.hour = 99;
        expect(getDatePartsInTimezone(t, 'America/New_York').hour).toBe(19);
    });

    it('preserves UTC, fixed offsets, midnight and invalid-zone fallback', () => {
        const t = Date.parse('2026-01-01T00:00:00Z');
        const utc = { year: 2026, month: 1, day: 1, hour: 0, minute: 0, second: 0, dayOfWeek: 4 };
        for (const zone of ['UTC', 'GMT', 'Etc/UTC', ' UTC ', 'Not/A_Zone', ' America/New_York ']) {
            expect(getDatePartsInTimezone(t, zone)).toEqual(utc);
        }
        expect(getDatePartsInTimezone(t, 'UTC+5:30')).toEqual({ ...utc, hour: 5, minute: 30 });
        expect(getDatePartsInTimezone(t, 'GMT-03:30')).toEqual({
            year: 2025, month: 12, day: 31, hour: 20, minute: 30, second: 0, dayOfWeek: 3,
        });
        expect(getDatePartsInTimezone(Date.parse('2026-01-01T05:00:00Z'), 'America/New_York')).toEqual(utc);
        expect(getDatePartsInTimezone(NaN, 'America/New_York').hour).toBeNaN();
        expect(getDatePartsInTimezone(t, 'America/New_York').hour).toBe(19);
    });

    it('bounds retention and rebuilds evicted formatters without changing values', async () => {
        vi.resetModules();
        const { getDatePartsInTimezone: parts } = await import('../../src/namespaces/Time');
        const Original = Intl.DateTimeFormat;
        const ctor = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (locales, options) {
            return new Original(locales, options);
        } as typeof Intl.DateTimeFormat);
        const t = Date.parse('2026-01-01T00:00:00Z');
        const expected = parts(t, 'America/New_York');
        // 33 other valid identifiers exceed the 32-entry bound.
        for (let i = 0; i < 33; i++) {
            const zone = `Etc/GMT${i < 12 ? '-' : '+'}${i < 12 ? i + 1 : (i - 12) % 12}`;
            // Include aliases to exercise distinct cache keys without relying on host zone enumeration.
            parts(t, i < 24 ? zone : ['Europe/Prague', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland',
                'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Asia/Kolkata', 'Europe/London'][i - 24]);
        }
        const before = ctor.mock.calls.length;
        expect(parts(t, 'America/New_York')).toEqual(expected);
        expect(ctor.mock.calls.length).toBe(before + 1);
        parts(t + 900000, 'America/New_York');
        expect(ctor.mock.calls.length).toBe(before + 1);
    });
});
