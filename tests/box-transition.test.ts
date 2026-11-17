import { describe, test, expect } from 'bun:test'
import {
    cubicBezier, standardEasing, Presentation, planComposite, BoxTransitions,
    type Band, type Snapshot,
} from '../src/box-transition'

const snap = (top = 0): Snapshot => ({ image: { width: 10, height: 10 } as any, top, scale: 1 })

function band(top: number, final: number, shown: number, extra: Partial<Band> = {}): Band
{
    return {
        top, final, shown, cap: 8,
        source: final >= shown ? 'live' : 'before',
        before: snap(), beforeTop: top, beforeHeight: Math.max(final, shown),
        ...extra,
    }
}

describe('easing', () =>
{
    test('a linear curve is the identity, and every curve pins its ends', () =>
    {
        const linear = cubicBezier(0, 0, 1, 1)
        for (const x of [0, 0.1, 0.37, 0.5, 0.9, 1]) expect(linear(x)).toBeCloseTo(x, 5)
        expect(standardEasing(0)).toBe(0)
        expect(standardEasing(1)).toBe(1)
    })

    test('the standard curve rises monotonically and front-loads the motion', () =>
    {
        let prev = 0
        for (let i = 1; i <= 100; i++)
        {
            const v = standardEasing(i / 100)
            expect(v).toBeGreaterThanOrEqual(prev)
            prev = v
        }
        expect(standardEasing(0.5)).toBeGreaterThan(0.75)
    })
})

describe('Presentation', () =>
{
    // A box at 100 whose final height is 300, drawn 150 tall (expanding).
    const p = new Presentation([band(100, 300, 150)])

    test('above the box is untouched; below it moves by shown - final', () =>
    {
        expect(p.mapY(50)).toEqual({ y: 50, hidden: false })
        expect(p.mapY(450)).toEqual({ y: 300, hidden: false })
        expect(p.offset).toBe(-150)
    })

    test('the interior is visible down to the drawn height, hidden past it', () =>
    {
        expect(p.mapY(120).hidden).toBe(false)
        expect(p.mapY(260).hidden).toBe(true)
    })

    test('unmapY inverts mapY everywhere that is visible', () =>
    {
        const q = new Presentation([band(100, 300, 150), band(700, 40, 200)])
        for (let y = 0; y < 1200; y += 7)
        {
            const m = q.mapY(y)
            if (!m.hidden) expect(q.unmapY(m.y)).toBe(y)
        }
    })
})

describe('planComposite', () =>
{
    /** Every drawn row of the viewport is written exactly once. */
    function expectTiles(ops: ReturnType<typeof planComposite>, top: number, height: number)
    {
        const spans = ops.map((o) => [o.dest, o.dest + (o.to - o.from)] as const)
            .sort((a, b) => a[0] - b[0])
        let at = top
        for (const [a, b] of spans)
        {
            expect(a).toBeCloseTo(at, 6)
            at = b
        }
        expect(at).toBeCloseTo(top + height, 6)
    }

    test('an expanding box reveals live rows, closes with its own bottom edge, and pulls up what follows', () =>
    {
        const ops = planComposite(new Presentation([band(100, 300, 150)]), 0, 600)
        expect(ops).toEqual([
            { source: 'live', from: 0, to: 100, dest: 0 },
            { source: 'live', from: 100, to: 242, dest: 100 },
            { source: 'live', from: 392, to: 400, dest: 242 },
            { source: 'live', from: 400, to: 750, dest: 250 },
        ])
        expectTiles(ops, 0, 600)
    })

    test('a collapsing box draws its interior from the snapshot', () =>
    {
        const before = snap(0)
        // Final height 30 (header only), drawn 120, from a 300-tall box at 100.
        const b = band(100, 30, 120, { source: 'before', before, beforeTop: 100, beforeHeight: 300 })
        const ops = planComposite(new Presentation([b]), 0, 500)
        expect(ops[1]).toEqual({ source: before, from: 100, to: 212, dest: 100 })
        expect(ops[2]).toEqual({ source: before, from: 392, to: 400, dest: 212 })
        // Below the box: final rows from 130 land at 220, 90 lower.
        expect(ops[3]).toEqual({ source: 'live', from: 130, to: 410, dest: 220 })
        expectTiles(ops, 0, 500)
    })

    test('random bands and viewports always tile the viewport exactly', () =>
    {
        let seed = 7
        const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
        for (let n = 0; n < 300; n++)
        {
            const bands: Band[] = []
            let y = rand() * 200
            for (let k = Math.floor(rand() * 3); k >= 0; k--)
            {
                const final = 20 + rand() * 300
                const shown = 20 + rand() * 300
                bands.push(band(y, final, shown))
                y += final + 10 + rand() * 300
            }
            const top = rand() * 900
            const height = 100 + rand() * 600
            expectTiles(planComposite(new Presentation(bands), top, height), top, height)
        }
    })
})

describe('BoxTransitions', () =>
{
    const box = (pos: number, y: number, height: number, collapsed: boolean) =>
        ({ pos, y, height, collapsed, radius: 6 })

    function clocked()
    {
        let t = 0
        const tx = new BoxTransitions(() => t)
        let shots = 0
        const shot = () => { shots++; return snap() }
        return { tx, tick: (ms: number) => { t += ms }, shots: () => shots, shot }
    }

    test('a toggle animates from the height on screen to the final one, then retires', () =>
    {
        const { tx, tick, shots, shot } = clocked()
        tx.frame([box(5, 100, 300, false)], () => 200, shot)
        expect(tx.presentation.active).toBe(false)

        // Collapsed: the layout says 30, the picture starts at 300.
        let p = tx.frame([box(5, 100, 30, true)], () => 200, shot)
        expect(shots()).toBe(1)
        expect(p.bands[0]).toMatchObject({ top: 100, final: 30, shown: 300, source: 'before' })

        tick(100)
        p = tx.frame([box(5, 100, 30, true)], () => 200, shot)
        expect(p.bands[0].shown).toBeLessThan(300)
        expect(p.bands[0].shown).toBeGreaterThan(30)
        expect(shots()).toBe(1)

        tick(100)
        expect(tx.frame([box(5, 100, 30, true)], () => 200, shot).active).toBe(false)
    })

    test('reversing mid-flight starts from where the picture is, not from the end', () =>
    {
        const { tx, tick, shot } = clocked()
        tx.frame([box(5, 100, 300, false)], () => 200, shot)
        tx.frame([box(5, 100, 30, true)], () => 200, shot)
        tick(50)
        const mid = tx.frame([box(5, 100, 30, true)], () => 200, shot).bands[0].shown
        const p = tx.frame([box(5, 100, 300, false)], () => 200, shot)
        expect(p.bands[0]).toMatchObject({ final: 300, source: 'live' })
        expect(p.bands[0].shown).toBeCloseTo(mid, 6)
    })

    test('a zero duration, or a box that went away, never animates', () =>
    {
        const { tx, shot, shots } = clocked()
        tx.frame([box(5, 100, 300, false)], () => 0, shot)
        expect(tx.frame([box(5, 100, 30, true)], () => 0, shot).active).toBe(false)
        expect(shots()).toBe(0)
        expect(tx.frame([], () => 200, shot).active).toBe(false)
    })

    test('positions follow transactions; a deleted box stops its transition', () =>
    {
        const { tx, shot } = clocked()
        tx.frame([box(5, 100, 300, false)], () => 200, shot)
        // Ten characters typed before the box.
        tx.mapThrough({ map: (p: number) => p + 10, mapResult: (p: number) => ({ pos: p + 10, deletedAcross: false }) } as any)
        expect(tx.frame([box(15, 100, 30, true)], () => 200, shot).active).toBe(true)
        tx.mapThrough({ map: (p: number) => p, mapResult: (p: number) => ({ pos: p, deletedAcross: true }) } as any)
        expect(tx.frame([box(15, 100, 30, true)], () => 200, shot).active).toBe(false)
    })

    test('a box toggled inside one that is animating replaces it', () =>
    {
        const { tx, tick, shot } = clocked()
        tx.frame([box(1, 0, 400, false), box(5, 40, 200, false)], () => 200, shot)
        tx.frame([box(1, 0, 30, true), box(5, 40, 200, false)], () => 200, shot)
        tick(10)
        // Can't happen inside a collapsed box in practice, but the overlap rule
        // must hold for any geometry: one displacement per region.
        const p = tx.frame([box(1, 0, 30, true), box(5, 40, 20, true)], () => 200, shot)
        expect(p.bands.length).toBe(1)
        expect(p.bands[0].final).toBe(20)
    })
})
