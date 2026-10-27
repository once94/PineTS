// SPDX-License-Identifier: AGPL-3.0-only
// Exchange holidays (`syminfo.holidays`). CME Globex trades an abbreviated session on some
// holidays (12:00 CT halt on Memorial Day, Juneteenth, …) and gives those trades the next
// business day's trade date, so the holiday is not a trading day of its own: the daily period,
// `time("D")` and the default `ta.vwap` reset all skip it. Without `holidays` nothing changes.

import { describe, it, expect } from 'vitest';
import { PineTS } from '../../src/PineTS.class';

const HOUR = 3_600_000;
// CDT is UTC-5 for both windows below.
const ct = (iso: string) => Date.parse(`${iso}:00-05:00`);

// Hourly CME bars: 16:00 CT break, weekend from Friday 16:00 to Sunday 17:00, and on `halt`
// (YYYY-MM-DD) no bars from 12:00 CT until the 17:00 CT open.
function cmeBars(from: string, to: string, halt: string) {
    const rows: any[] = [];
    let n = 0;
    for (let t = ct(from); t < ct(to); t += HOUR) {
        const local = new Date(t - 5 * HOUR);
        const hour = local.getUTCHours();
        const dow = local.getUTCDay();
        const date = local.toISOString().slice(0, 10);
        if (hour === 16) continue;
        if ((dow === 5 && hour >= 16) || dow === 6 || (dow === 0 && hour < 17)) continue;
        if (date === halt && hour >= 12 && hour < 17) continue;
        n++;
        rows.push({ openTime: t, closeTime: t + HOUR, open: n, high: n, low: n, close: n, volume: 1 });
    }
    return rows;
}

function provider(rows: any[], symbol: Record<string, any>) {
    return {
        async getMarketData() {
            return rows.map((r) => ({ ...r }));
        },
        async getSymbolInfo() {
            return { ticker: 'T', tickerid: 'X:T', type: 'futures', mintick: 0.25, pricescale: 4, minmove: 1, ...symbol };
        },
    };
}

const code = `//@version=6
indicator("holidays")
plot(timeframe.change("D") ? 1 : 0, "chgD")
plot(time("D"), "tD")
plot(ta.vwap(close), "vwap")
`;

async function run(rows: any[], symbol: Record<string, any>) {
    const pine = new PineTS(provider(rows, symbol) as any, 'T', '60', undefined, rows[0].openTime);
    const { plots } = await pine.run(code);
    const at = (name: string, t: number) => plots[name].data.find((d: any) => d.time === t)?.value;
    const changes = plots.chgD.data.filter((d: any) => d.value === 1).map((d: any) => d.time);
    const resets = plots.vwap.data.filter((d: any, i: number) => i > 0 && d.value === rows[i].close).map((d: any) => d.time);
    return { at, changes, resets };
}

const cme = { timezone: 'America/Chicago', session: '1700-1600' };

describe('exchange holidays on a session market', () => {
    // Memorial Day, Monday 2026-05-25: Sunday 17:00 to Monday 12:00 and Monday 17:00 onwards
    // are both trade date Tuesday 2026-05-26.
    const memorial = cmeBars('2026-05-21T17:00', '2026-05-27T16:00', '2026-05-25');

    it('a Monday holiday session belongs to Tuesday: no new day at its 17:00 reopen', async () => {
        const { changes, resets } = await run(memorial, { ...cme, holidays: ['2026-05-25'] });
        expect(changes).toEqual([ct('2026-05-24T17:00'), ct('2026-05-26T17:00')]);
        expect(resets).toEqual(changes);
    });

    it('time("D") of the reopen bar is the Sunday 17:00 open of trade date Tuesday', async () => {
        const { at } = await run(memorial, { ...cme, holidays: ['2026-05-25'] });
        expect(at('tD', ct('2026-05-25T18:00'))).toBe(ct('2026-05-24T17:00'));
    });

    it('without holidays the 17:00 reopen starts a new day, as before', async () => {
        const { changes } = await run(memorial, cme);
        expect(changes).toEqual([ct('2026-05-24T17:00'), ct('2026-05-25T17:00'), ct('2026-05-26T17:00')]);
    });

    // Juneteenth, Friday 2026-06-19: Thursday 17:00 to Friday 12:00 and the Sunday 17:00 open are
    // both trade date Monday 2026-06-22.
    const juneteenth = cmeBars('2026-06-17T17:00', '2026-06-23T16:00', '2026-06-19');

    it('a Friday holiday session rolls over the weekend into Monday', async () => {
        const { changes, resets, at } = await run(juneteenth, { ...cme, holidays: ['2026-06-19'] });
        expect(changes).toEqual([ct('2026-06-18T17:00'), ct('2026-06-22T17:00')]);
        expect(resets).toEqual(changes);
        expect(at('tD', ct('2026-06-21T18:00'))).toBe(ct('2026-06-18T17:00'));
    });
});
