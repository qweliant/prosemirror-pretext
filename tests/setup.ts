/**
 * Test setup — runs once via bunfig.toml `[test].preload`.
 *
 * Registers happy-dom globals, stubs canvas (happy-dom's getContext returns
 * null), and replaces @chenglou/pretext with a deterministic single-line
 * mock so layout math is predictable from a test's perspective.
 *
 * Mock measureText: width = text.length * 8 px. So column N = x of 8N.
 */

import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { mock } from 'bun:test'

GlobalRegistrator.register()

;(HTMLCanvasElement.prototype as any).getContext = function ()
{
    return {
        setTransform() {},
        clearRect() {},
        fillRect() {},
        fillText() {},
        measureText(s: string)
        {
            return { width: s.length * 8 }
        },
        set fillStyle(_v: unknown) {},
        set font(_v: unknown) {},
        set textBaseline(_v: unknown) {},
    }
}

Object.defineProperty(window, 'devicePixelRatio', {
    value: 1,
    configurable: true,
})

mock.module('@chenglou/pretext', () =>
{
    function prepareWithSegments(text: string, font: string)
    {
        return { text, font }
    }
    function layoutWithLines(
        prepared: { text: string },
        _width: number,
        lineHeight: number,
    )
    {
        if (prepared.text.length === 0) return { lines: [], height: 0 }
        return {
            lines: [{
                text: prepared.text,
                width: prepared.text.length * 8,
                start: { segmentIndex: 0, graphemeIndex: 0 },
                end: { segmentIndex: 0, graphemeIndex: prepared.text.length },
            }],
            height: lineHeight,
        }
    }
    return { prepareWithSegments, layoutWithLines }
})

// Deterministic stub for the rich-inline (marked text) path. Mirrors Pretext's
// behaviour closely enough for coordinate tests: every block lays out on one
// line, boundary whitespace is trimmed into gaps, and widths follow the same
// len*8 rule as measureText above.
mock.module('@chenglou/pretext/rich-inline', () =>
{
    function prepareRichInline(items: { text: string, font: string }[])
    {
        return { items }
    }
    function walkRichInlineLineRanges(
        prepared: { items: { text: string }[] },
        _maxWidth: number,
        onLine: (range: { items: { text: string }[] }) => void,
    )
    {
        onLine({ items: prepared.items })
        return 1
    }
    function materializeRichInlineLineRange(
        _prepared: unknown,
        range: { items: { text: string }[] },
    )
    {
        const fragments: {
            itemIndex: number, text: string, gapBefore: number,
            occupiedWidth: number, start: unknown, end: unknown,
        }[] = []
        let pendingGap = 0
        for (let i = 0; i < range.items.length; i++)
        {
            const raw = range.items[i].text
            const trimmed = raw.replace(/^\s+/, '').replace(/\s+$/, '')
            const hadLead = /^\s/.test(raw)
            const hadTrail = /\s$/.test(raw)
            if (trimmed.length === 0)
            {
                if (/\s/.test(raw)) pendingGap = 8
                continue
            }
            const gapBefore = fragments.length === 0
                ? 0
                : (pendingGap > 0 ? pendingGap : (hadLead ? 8 : 0))
            fragments.push({
                itemIndex: i, text: trimmed, gapBefore,
                occupiedWidth: trimmed.length * 8, start: {}, end: {},
            })
            pendingGap = hadTrail ? 8 : 0
        }
        const width = fragments.reduce((w, f) => w + f.gapBefore + f.occupiedWidth, 0)
        return { fragments, width, end: {} }
    }
    return { prepareRichInline, walkRichInlineLineRanges, materializeRichInlineLineRange }
})
