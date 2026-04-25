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
