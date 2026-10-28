import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.restoreAllMocks());

async function timeModule() {
    vi.resetModules();
    return import('../../src/namespaces/Time');
}

async function sessionFixture(timestamp = Date.parse('2026-01-05T09:45:00Z')) {
    const time = await timeModule();
    const sessions = await import('../../src/namespaces/sessionSpec');
    const parsed = vi.spyOn(sessions, 'parseSessionSpec');
    const data = { openTime: [timestamp] };
    const helper = new time.TimeHelper({ data, timeframe: '15', pine: { syminfo: { timezone: 'UTC' } } });
    return { helper, data, parsed, sessions };
}

describe('bounded calendar parts memo', () => {
    it('reuses only the exact timestamp and zone, including across DST', async () => {
        const { getDatePartsInTimezone: parts } = await timeModule();
        const format = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
        const before = Date.parse('2026-03-08T06:59:59Z');
        for (let i = 0; i < 5; i++) expect(parts(before, 'America/New_York').hour).toBe(1);
        expect(format).toHaveBeenCalledTimes(1);
        expect(parts(before + 1000, 'America/New_York').hour).toBe(3);
        expect(parts(before, 'America/Chicago').hour).toBe(0);
        expect(format).toHaveBeenCalledTimes(3);
        expect(parts(Date.parse('2026-11-01T05:30:00Z'), 'America/New_York').hour).toBe(1);
        expect(parts(Date.parse('2026-11-01T06:30:00Z'), 'America/New_York').hour).toBe(1);
    });

    it('never exposes stored results to mutation', async () => {
        const { getDatePartsInTimezone: parts } = await timeModule();
        const format = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
        const t = Date.parse('2026-01-01T00:00:00Z');
        const first = parts(t, 'America/New_York');
        first.hour = 99;
        const second = parts(t, 'America/New_York');
        expect(second.hour).toBe(19);
        second.year = 0;
        expect(parts(t, 'America/New_York').year).toBe(2025);
        expect(format).toHaveBeenCalledTimes(1);
    });

    it('evicts old timestamps after eight entries for one zone', async () => {
        const { getDatePartsInTimezone: parts } = await timeModule();
        const format = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
        for (let i = 0; i < 9; i++) parts(i * 1000, 'Asia/Tokyo');
        expect(format).toHaveBeenCalledTimes(9);
        expect(parts(8000, 'Asia/Tokyo').second).toBe(8);
        expect(format).toHaveBeenCalledTimes(9);
        expect(parts(0, 'Asia/Tokyo').second).toBe(0);
        expect(format).toHaveBeenCalledTimes(10);
    });

    it('does not memoize invalid dates or mutable non-number timestamps', async () => {
        const { getDatePartsInTimezone: parts } = await timeModule();
        for (const t of [NaN, Infinity, -Infinity, 8640000000000001]) {
            expect(parts(t, 'America/New_York').hour).toBeNaN();
            expect(parts(t, 'America/New_York').hour).toBeNaN();
        }
        const date = new Date('2026-01-01T05:00:00Z');
        expect(parts(date as any, 'America/New_York').hour).toBe(0);
        date.setUTCHours(6);
        expect(parts(date as any, 'America/New_York').hour).toBe(1);
        expect(parts(Date.parse('2026-01-01T00:00:00Z'), ' America/New_York ').hour).toBe(0);
    });
});

describe('time helper session memo', () => {
    it('parses a repeated session once while evaluating each bar separately', async () => {
        const { helper, data, parsed } = await sessionFixture();
        expect(helper.any('15', '0930-1000', 'UTC')).toBe(data.openTime[0]);
        data.openTime.push(Date.parse('2026-01-05T10:00:00Z'));
        expect(helper.any('15', '0930-1000', 'UTC')).toBeNaN();
        expect(parsed).toHaveBeenCalledTimes(1);
        expect(helper.any('15', '1000-1100', 'UTC')).toBe(data.openTime[1]);
        expect(parsed).toHaveBeenCalledTimes(2);
    });

    it('retains malformed-session errors on every invocation', async () => {
        const { helper, parsed } = await sessionFixture();
        for (let i = 0; i < 2; i++) {
            expect(() => helper.any('15', 'invalid', 'UTC')).toThrow('Invalid session specification: "invalid"');
        }
        expect(parsed).toHaveBeenCalledTimes(1);
    });

    it('keeps the exported parser results mutable and independent', async () => {
        const { sessions } = await sessionFixture();
        const first = sessions.parseSessionSpec('0930-1600:23456')!;
        first.windows[0].start = 0;
        first.days.clear();
        const second = sessions.parseSessionSpec('0930-1600:23456')!;
        expect(second.windows[0].start).toBe(570);
        expect([...second.days]).toEqual([2, 3, 4, 5, 6]);
    });

    it('bounds session retention to 32 entries per helper', async () => {
        const { helper, parsed } = await sessionFixture(Date.parse('2026-01-05T00:00:00Z'));
        const names = Array.from({ length: 33 }, (_, i) => `0000-00${String(i + 1).padStart(2, '0')}`);
        for (const name of names) helper.any('15', name, 'UTC');
        expect(parsed).toHaveBeenCalledTimes(33);
        helper.any('15', names[32], 'UTC');
        expect(parsed).toHaveBeenCalledTimes(33);
        helper.any('15', names[0], 'UTC');
        expect(parsed).toHaveBeenCalledTimes(34);
    });
});
