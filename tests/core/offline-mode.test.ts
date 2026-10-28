import { describe, it, expect } from 'vitest';
import { PlotHelper, FillHelper } from '../../src/namespaces/Plots';
import { LabelHelper } from '../../src/namespaces/label/LabelHelper';
import { LineHelper } from '../../src/namespaces/line/LineHelper';
import { BoxHelper } from '../../src/namespaces/box/BoxHelper';
import { TableHelper } from '../../src/namespaces/table/TableHelper';
import { LinefillHelper } from '../../src/namespaces/linefill/LinefillHelper';
import { PolylineHelper } from '../../src/namespaces/polyline/PolylineHelper';
import { PineTS } from '../../src/PineTS.class';
import { Indicator } from '../../src/Indicator/Indicator.class';

const context = (collectVisuals = false): any => ({ collectVisuals, plots: {}, idx: 0,
    marketData: [{ openTime: 0 }], indicator: { overlay: false, max_labels_count: 2 } });

// These utility tests do not execute a Pine script or a PineTS run.
describe('offline helpers', () => {
    it('retains plot handles and fills without accumulating points', () => {
        const ctx = context(), helper = new PlotHelper(ctx);
        ctx.pine = { plot: helper };
        const a = helper.any(10, 'A'), b = helper.any(20, 'B');
        new FillHelper(ctx).any(a, b, 'red', 'fill');
        expect(a._plotKey).toBe('A');
        expect(b._plotKey).toBe('B');
        expect(ctx.plots.fill.options.plot1).toBe('A');
        for (const p of Object.values(ctx.plots) as any[]) expect(p.data).toEqual([]);
    });
    it('preserves the default visual output', () => {
        const ctx = context(true);
        new PlotHelper(ctx).any(10, 'A');
        expect(ctx.plots.A.data[0].value).toBe(10);
    });
    it('suppresses the other per-bar plot families', () => {
        const ctx = context(), p = new PlotHelper(ctx);
        p.plotchar(1, 'char'); p.plotshape(1, 'shape'); p.plotarrow(1, 'arrow');
        p.plotbar(1, 2, 0, 1, 'bar'); p.plotcandle(1, 2, 0, 1, 'candle');
        p.bgcolor('red', { title: 'background' }); p.barcolor('red', { title: 'bars' });
        expect(Object.keys(ctx.plots).length).toBeGreaterThanOrEqual(7);
        for (const p of Object.values(ctx.plots) as any[]) expect(p.data).toEqual([]);
    });
    it('keeps drawing objects and garbage collection active without serialization', () => {
        const ctx = context(), helper = new LabelHelper(ctx);
        const a = helper.new(0, 10, 'first');
        const b = helper.new(1, 11, 'second');
        const c = helper.new(2, 12, 'third');
        helper.syncToPlot();
        expect(a._deleted).toBe(true);
        expect(helper.all).toEqual([b, c]);
        expect((helper as any)._labels).toHaveLength(2);
        expect(ctx.plots).toEqual({});
        ctx.collectVisuals = true;
        helper.syncToPlot();
        expect(ctx.plots.__labels__.data[0].value).toHaveLength(2);
    });
    it('does not serialize empty helpers either', () => {
        const ctx = context();
        for (const Helper of [LineHelper, BoxHelper, TableHelper, LinefillHelper, PolylineHelper]) {
            new Helper(ctx).syncToPlot();
        }
        expect(ctx.plots).toEqual({});
    });
});

const bars = Array.from({ length: 8 }, (_, i) => ({ openTime: 1700000000000 + i * 900000,
    closeTime: 1700000000000 + (i + 1) * 900000, open: 100 + i, high: 102 + i,
    low: 99 + i, close: 101 + i, volume: 10 }));
const script = `//@version=6
strategy("offline parity", max_labels_count=2)
n = input.int(2, "N")
var counter = array.new_int(1, 0)
f_value() =>
    array.set(counter, 0, array.get(counter, 0) + 1)
    close
p = plot(f_value(), "A")
q = plot(close + 1, "B")
fill(p, q, color.red)
label.new(bar_index, close, str.tostring(array.get(counter, 0)))
if array.get(counter, 0) == n
    strategy.entry("L", strategy.long, qty=1)
if bar_index == 3
    strategy.close("L")
`;

describe('offline integration (isolated runtime only)', () => {
    it('keeps trades and side effects of plot arguments identical', async () => {
        const full = await new PineTS(bars).run(script);
        const lean = await new PineTS(bars).setCollectVisuals(false).run(script);
        expect(lean.strategy!.closedtrades).toEqual(full.strategy!.closedtrades);
        expect(lean.strategy!.closedtrades).toHaveLength(1);
        expect(lean.strategy!.closedtrades[0].entry_price).toBe(102);
        expect(lean.strategy!.closedtrades[0].exit_price).toBe(104);
        expect(full.plots.A.data).toHaveLength(8);
        for (const p of Object.values(lean.plots) as any[]) expect(p.data).toEqual([]);
    });
    it('rejects accidental non-boolean host flags', () => {
        expect(() => new PineTS(bars).setCollectVisuals('false' as any)).toThrow(TypeError);
    });
    it('forks share code but never inputs, properties or runtime state', async () => {
        const template = new Indicator(script);
        await template.resolveImports(null);
        template.prepare();
        template.input.N = 3;
        template.prop.initial_capital = 999;
        const a = template.fork(), b = template.fork();
        expect(a.prepare().fn).toBe(template.prepare().fn);
        expect(b.prepare().fn).toBe(a.prepare().fn);
        expect(a.input.N).toBe(2);
        a.input.N = 4;
        a.prop.initial_capital = 1000;
        expect(b.input.N).toBe(2);
        expect(b.getRuntimePropOverrides()).toEqual({});
        expect(template.input.N).toBe(3);
        expect(a.prepare().inputs).not.toEqual(b.prepare().inputs);
        const first = await new PineTS(bars).run(b);
        const second = await new PineTS(bars).run(template.fork());
        expect(second.strategy!.closedtrades).toEqual(first.strategy!.closedtrades);
        expect(second.strategy).not.toBe(first.strategy);
    });
    it('repeats A after B with the original trades and broker properties', async () => {
        const template = new Indicator(script);
        await template.resolveImports(null);
        template.prepare();
        const run = async (n: number, capital: number) => {
            const child = template.fork();
            child.input.N = n;
            child.prop.initial_capital = capital;
            return new PineTS(bars).setCollectVisuals(false).run(child);
        };
        const a = await run(2, 100000), b = await run(3, 200000), again = await run(2, 100000);
        expect(b.strategy!.closedtrades[0].entry_price).toBe(103);
        expect(again.strategy!.closedtrades).toEqual(a.strategy!.closedtrades);
        expect(again.strategy!.netprofit).toBe(a.strategy!.netprofit);
        expect(again.strategy!.config.initial_capital).toBe(100000);
    });
    it('fork metadata is independent of another caller mutation', async () => {
        const template = new Indicator(script);
        await template.resolveImports(null);
        template.prepare();
        const a = template.fork(), b = template.fork();
        a.getInputsMeta()[0].name = 'changed';
        expect(b.getInputsMeta()[0].name).toBe('N');
        expect(template.getInputsMeta()[0].name).toBe('N');
    });
});
