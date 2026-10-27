// SPDX-License-Identifier: AGPL-3.0-only

import { ParsedTimeframe, timeframeBarStart } from '../timeframe';
import { localTimeToUTC } from '../marketData/types';
import { getDatePartsInTimezone } from './Time';
import { parseSessionSpec } from './sessionSpec';

const DAY_MS = 86400000;
const MEMO_LIMIT = 4096;

/**
 * Minute of the local day at which the symbol's trading day opens, and whether its session
 * runs overnight (`1700-1600`: a CME day opens at 17:00 the evening before). A session string
 * that is not a window spec (`regular`, `extended`, missing) opens at local midnight.
 */
const openBySession = new Map<string, { open: number; overnight: boolean }>();
function sessionOpen(session: string | undefined) {
    const key = session ?? '';
    let o = openBySession.get(key);
    if (!o) {
        const first = parseSessionSpec(key)?.windows[0];
        o = first ? { open: first.start % 1440, overnight: first.start >= first.end && first.end < 1440 } : { open: 0, overnight: false };
        openBySession.set(key, o);
    }
    return o;
}

/**
 * Exchange holidays of the symbol (`syminfo.holidays`, dates `YYYY-MM-DD` in the exchange
 * timezone), or none. On an exchange holiday a market may still trade an abbreviated session
 * (CME Globex halts at 12:00 CT on Memorial Day, Juneteenth, …); its trades belong to the next
 * business day, so the holiday is not a trading day of its own. Not a TradingView `syminfo`
 * field: a provider that knows the exchange calendar supplies it.
 */
type Holidays = readonly string[] | undefined;
const holidaySets = new WeakMap<readonly string[], { set: Set<string>; key: string }>();
function holidaySet(holidays: Holidays) {
    if (!holidays || holidays.length === 0) return null;
    let h = holidaySets.get(holidays);
    if (!h) {
        h = { set: new Set(holidays), key: [...holidays].sort().join(',') };
        holidaySets.set(holidays, h);
    }
    return h;
}
const isoDay = (dayMs: number) => new Date(dayMs).toISOString().slice(0, 10);
const isWeekend = (dayMs: number) => {
    const d = new Date(dayMs).getUTCDay();
    return d === 0 || d === 6;
};

// A bar asks for its own and the previous bar's period every time it runs.
const dayMemo = new Map<string, number>();
const openMemo = new Map<string, number>();
const remember = (memo: Map<string, number>, key: string, value: number) => {
    if (memo.size >= MEMO_LIMIT) memo.clear();
    memo.set(key, value);
    return value;
};

/**
 * The trading day a timestamp belongs to, as 00:00 UTC of that date: its date in the
 * exchange timezone, one day later for the evening part of an overnight session, and the
 * next business day (not a holiday, not a weekend) when that date is an exchange holiday.
 */
export function tradingDayOf(timestamp: number, timezone: string, session: string | undefined, holidays?: Holidays): number {
    const h = holidaySet(holidays);
    const key = `${timezone}|${session}|${timestamp}|${h ? h.key : ''}`;
    const hit = dayMemo.get(key);
    if (hit !== undefined) return hit;
    const p = getDatePartsInTimezone(timestamp, timezone);
    const date = Date.UTC(p.year, p.month - 1, p.day);
    const { open, overnight } = sessionOpen(session);
    let day = overnight && p.hour * 60 + p.minute >= open ? date + DAY_MS : date;
    if (h && h.set.has(isoDay(day))) {
        do {
            day += DAY_MS;
        } while (h.set.has(isoDay(day)) || isWeekend(day));
    }
    return remember(dayMemo, key, day);
}

/** The first calendar date whose session belongs to trading day `day`: earlier holidays roll into it. */
function firstSessionDay(day: number, holidays: Holidays): number {
    const h = holidaySet(holidays);
    if (!h) return day;
    let first = day;
    for (let d = day - DAY_MS; h.set.has(isoDay(d)) || isWeekend(d); d -= DAY_MS) {
        if (h.set.has(isoDay(d))) first = d;
    }
    return first;
}

/**
 * The daily / weekly / monthly period a timestamp belongs to on the symbol's trading calendar,
 * as 00:00 UTC of the period's first day. As on TradingView, a CME day starts at the 17:00 CT
 * open, not at UTC midnight. Equal keys mean the same period.
 */
export function tradingPeriodKey(timestamp: number, tf: ParsedTimeframe, timezone: string, session: string | undefined, holidays?: Holidays): number {
    if (tf.unit !== 'D' && tf.unit !== 'W' && tf.unit !== 'M') return timeframeBarStart(timestamp, tf);
    return timeframeBarStart(tradingDayOf(timestamp, timezone, session, holidays), tf);
}

/** Open time of the `tf` bar holding `timestamp`: the session open of its period's first trading day. */
export function tradingPeriodStart(timestamp: number, tf: ParsedTimeframe, timezone: string, session: string | undefined, holidays?: Holidays): number {
    if (tf.unit !== 'D' && tf.unit !== 'W' && tf.unit !== 'M') return timeframeBarStart(timestamp, tf);
    const periodDay = tradingPeriodKey(timestamp, tf, timezone, session, holidays);
    const h = holidaySet(holidays);
    const key = `${timezone}|${session}|${periodDay}|${h ? h.key : ''}`;
    const hit = openMemo.get(key);
    if (hit !== undefined) return hit;
    const { open, overnight } = sessionOpen(session);
    const firstDay = firstSessionDay(periodDay, holidays);
    const openDay = new Date(overnight ? firstDay - DAY_MS : firstDay).toISOString().slice(0, 10);
    const hhmm = `${String(Math.floor(open / 60)).padStart(2, '0')}:${String(open % 60).padStart(2, '0')}`;
    return remember(openMemo, key, localTimeToUTC(openDay, hhmm, timezone));
}
