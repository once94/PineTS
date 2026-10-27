// SPDX-License-Identifier: AGPL-3.0-only
// `ta.vwap(source)` resets at the start of each trading day on the symbol's trading calendar,
// the same day `timeframe.change("D")` sees. A CME future (`America/Chicago`, session
// `1700-1600`) starts its trading day at the 17:00 CT open, so VWAP resets there and keeps
// accumulating across local midnight. A symbol without an overnight session still resets at
// local midnight.

import { describe, it, expect } from 'vitest';
import { PineTS } from '../../../src/PineTS.class';

const HOUR = 3_600_000;
// CDT is UTC-5 for the whole window below.
const ct = (iso: string) => Date.parse(`${iso}:00-05:00`);

// Hourly CME bars from Wednesday 2024-09-25 17:00 CT to Friday 2024-09-27 16:00 CT, with the
// 16:00 CT break. Price = bar number, volume 1, so VWAP is the mean close since the last reset.
function cmeBars() {
    const rows: any[] = [];
    let n = 0;
    for (let t = ct('2024-09-25T17:00'); t < ct('2024-09-27T16:00'); t += HOUR) {
        if (new Date(t - 5 * HOUR).getUTCHours() === 16) continue;
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
indicator("vwap day")
plot(ta.vwap(close), "vwap")
plot(ta.vwap, "vwapVar")
plot(timeframe.change("D") ? 1 : 0, "chgD")
`;

async function run(rows: any[], symbol: Record<string, any>) {
    const pine = new PineTS(provider(rows, symbol) as any, 'T', '60', undefined, rows[0].openTime);
    const { plots } = await pine.run(code);
    const at = (name: string, t: number) => plots[name].data.find((d: any) => d.time === t)?.value;
    // A reset bar is one whose VWAP equals its own close (single bar since the reset).
    const resets = (name: string) =>
        plots[name].data.filter((d: any, i: number) => i > 0 && d.value === rows[i].close).map((d: any) => d.time);
    const changes = plots.chgD.data.filter((d: any) => d.value === 1).map((d: any) => d.time);
    return { at, resets, changes };
}

describe('ta.vwap resets on the trading day', () => {
    const rows = cmeBars();

    it('a CME future resets at the 17:00 CT open, as timeframe.change("D")', async () => {
        const { resets, changes } = await run(rows, { timezone: 'America/Chicago', session: '1700-1600' });
        expect(resets('vwap')).toEqual([ct('2024-09-26T17:00')]);
        expect(resets('vwapVar')).toEqual([ct('2024-09-26T17:00')]);
        expect(resets('vwap')).toEqual(changes);
    });

    it('a CME future keeps accumulating across local midnight', async () => {
        const { at } = await run(rows, { timezone: 'America/Chicago', session: '1700-1600' });
        // 2024-09-26 00:00 CT is bar 8 of the day that opened 2024-09-25 17:00 CT (closes 1..8).
        expect(at('vwap', ct('2024-09-26T00:00'))).toBeCloseTo(4.5, 10);
    });

    it('a symbol without an overnight session still resets at local midnight', async () => {
        const { resets } = await run(rows, { timezone: 'America/Chicago' });
        expect(resets('vwap')).toEqual([ct('2024-09-26T00:00'), ct('2024-09-27T00:00')]);
    });
});
