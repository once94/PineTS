// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 LuxAlgo
import { describe, it, expect } from 'vitest';
import { PineTS, Provider } from 'index';

// TV evaluates the operations required by expression, not independent chart
// validation. Reference: Pine manual, Other timeframes and data, "Declared
// variables". Regression observed on fw1 15m Variant guards with HTF requests.
const make = (tf = 'D') => new PineTS(Provider.Mock, 'BTCUSDC', tf, null,
    Date.UTC(2018, 11, 15), Date.UTC(2019, 1, 15));
const code = `//@version=6
indicator("Chart guard with HTF expression")
if timeframe.in_seconds() != 86400
    runtime.error("primary chart must be daily")
higher = request.security(syminfo.tickerid, "W", close)
plot(higher, "higher")
`;

describe('request expression does not inherit unrelated chart error guards', () => {
    it('evaluates HTF close without the independent primary chart guard', async () => {
        const ctx = await make().run(code);
        expect(ctx.plots.higher.data.some((p: any) => Number.isFinite(p.value))).toBe(true);
    });
    it('still raises the primary error on an invalid chart timeframe', async () => {
        await expect(make('W').run(code)).rejects.toThrow('primary chart must be daily');
    });
    it('still raises an error inside the requested expression function', async () => {
        const expressionGuard = `//@version=6
indicator("Expression guard")
value() =>
    if timeframe.in_seconds() > 86400
        runtime.error("requested expression rejected")
    close
higher = request.security(syminfo.tickerid, "W", value())
plot(higher, "higher")
`;
        await expect(make().run(expressionGuard)).rejects.toThrow('requested expression rejected');
    });
});
