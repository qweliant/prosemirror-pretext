import { describe, test, expect } from 'bun:test'
import { Schema, type NodeSpec } from 'prosemirror-model'
import { EditorState, TextSelection } from 'prosemirror-state'
import { CanvasEditor, type RenderStats } from '../src/editor'

const nodes: Record<string, NodeSpec> = {
    doc: { content: 'paragraph+' },
    paragraph: {
        content: 'text*',
        toDOM: () => ['p', 0],
        parseDOM: [{ tag: 'p' }],
    },
    text: { inline: true },
}
const schema = new Schema({ nodes })

function makeDoc(...paragraphs: string[])
{
    return schema.node('doc', null, paragraphs.map((p) =>
        schema.node('paragraph', null, p ? [schema.text(p)] : []),
    ))
}

function makeEditor(
    paragraphs: string[] = ['hello'],
    extraOpts: { onRender?: (s: RenderStats) => void, maxHeight?: number } = {},
): { ed: CanvasEditor, container: HTMLElement, stats: RenderStats[] }
{
    const container = document.createElement('div')
    document.body.appendChild(container)
    const stats: RenderStats[] = []
    const state = EditorState.create({ doc: makeDoc(...paragraphs), schema })
    const ed = new CanvasEditor({
        state,
        container,
        ...extraOpts,
        onRender(s)
        {
            stats.push(s)
            extraOpts.onRender?.(s)
        },
    })
    return { ed, container, stats }
}

function nextFrame(): Promise<void>
{
    return new Promise((r) => requestAnimationFrame(() => r()))
}


describe('mount', () =>
{
    test('creates canvas and textarea inside the container', () =>
    {
        const { container, ed } = makeEditor()
        expect(container.querySelector('canvas')).not.toBeNull()
        expect(container.querySelector('textarea')).not.toBeNull()
        ed.destroy()
    })

    test('destroy() empties the container and clears the blink interval', () =>
    {
        const { container, ed } = makeEditor()
        ed.destroy()
        expect(container.children.length).toBe(0)
    })

    test('maxHeight wraps the canvas in a scroller', () =>
    {
        const { container, ed } = makeEditor(['hi'], { maxHeight: 200 })
        const scroller = container.firstElementChild as HTMLElement
        expect(scroller.style.overflowY).toBe('auto')
        expect(scroller.style.maxHeight).toBe('200px')
        ed.destroy()
    })

    test('no maxHeight: container holds the stack directly (no scroller)', () =>
    {
        const { container, ed } = makeEditor()
        const stack = container.firstElementChild as HTMLElement
        expect(stack.style.overflowY).not.toBe('auto')
        ed.destroy()
    })
})


describe('render stats', () =>
{
    test('reports correct block and line counts after first render', () =>
    {
        const { stats, ed } = makeEditor(['a', 'b', 'c'])
        expect(stats.length).toBe(1)
        expect(stats[0].blockCount).toBe(3)
        expect(stats[0].lineCount).toBe(3)
        expect(stats[0].cacheMisses).toBe(3)
        expect(stats[0].cacheHits).toBe(0)
        ed.destroy()
    })

    test('selection-only dispatch is all cache hits', async () =>
    {
        const { ed, stats } = makeEditor(['a', 'b'])
        ed.dispatch(ed.state.tr.setSelection(TextSelection.atStart(ed.state.doc)))
        await nextFrame()
        const last = stats[stats.length - 1]
        expect(last.cacheHits).toBe(2)
        expect(last.cacheMisses).toBe(0)
        ed.destroy()
    })

    test('editing one block invalidates only that block', async () =>
    {
        const { ed, stats } = makeEditor(['hello', 'world'])
        ed.dispatch(ed.state.tr.insertText('x', 1))
        await nextFrame()
        const last = stats[stats.length - 1]
        expect(last.cacheHits).toBe(1)
        expect(last.cacheMisses).toBe(1)
        expect(ed.state.doc.firstChild!.textContent).toBe('xhello')
        expect(ed.state.doc.lastChild!.textContent).toBe('world')
        ed.destroy()
    })

    test('empty paragraph still produces a placeholder line', () =>
    {
        const { stats, ed } = makeEditor([''])
        expect(stats[0].blockCount).toBe(1)
        expect(stats[0].lineCount).toBe(1)
        ed.destroy()
    })
})


describe('horizontal selection movement', () =>
{
    test('moveSelection right increments head', () =>
    {
        const { ed } = makeEditor(['hello'])
        ed.dispatch(ed.state.tr.setSelection(
            TextSelection.near(ed.state.doc.resolve(1)),
        ))
        const before = ed.state.selection.head
        ;(ed as any).moveSelection(1, false)
        expect(ed.state.selection.head).toBe(before + 1)
        ed.destroy()
    })

    test('moveSelection left decrements head', () =>
    {
        const { ed } = makeEditor(['hello'])
        ed.dispatch(ed.state.tr.setSelection(
            TextSelection.near(ed.state.doc.resolve(4)),
        ))
        ;(ed as any).moveSelection(-1, false)
        expect(ed.state.selection.head).toBe(3)
        ed.destroy()
    })

    test('setHead clamps to doc bounds', () =>
    {
        const { ed } = makeEditor(['hi'])
        ;(ed as any).setHead(9999, false)
        expect(ed.state.selection.head)
            .toBeLessThanOrEqual(ed.state.doc.content.size)
        ;(ed as any).setHead(-100, false)
        expect(ed.state.selection.head).toBeGreaterThanOrEqual(0)
        ed.destroy()
    })

    test('shift+move extends the selection from the original anchor', () =>
    {
        const { ed } = makeEditor(['hello'])
        ed.dispatch(ed.state.tr.setSelection(
            TextSelection.near(ed.state.doc.resolve(1)),
        ))
        ;(ed as any).moveSelection(3, true)
        expect(ed.state.selection.empty).toBe(false)
        expect(ed.state.selection.from).toBe(1)
        expect(ed.state.selection.to).toBe(4)
        ed.destroy()
    })

    test('moveToBlockBoundary jumps to start/end of current block', () =>
    {
        const { ed } = makeEditor(['hello world'])
        ed.dispatch(ed.state.tr.setSelection(
            TextSelection.near(ed.state.doc.resolve(5)),
        ))
        ;(ed as any).moveToBlockBoundary('end', false)
        expect(ed.state.selection.head).toBe(12)
        ;(ed as any).moveToBlockBoundary('start', false)
        expect(ed.state.selection.head).toBe(1)
        ed.destroy()
    })
})


describe('vertical movement and phantom X', () =>
{
    test('ArrowDown lands at the same column in the next block', () =>
    {
        // p1 length 5, p2 length 31. Caret at end of p1 → column 5.
        const { ed } = makeEditor(['short', 'this is a much longer paragraph'])
        ed.dispatch(ed.state.tr.setSelection(
            TextSelection.near(ed.state.doc.resolve(6)),
        ))
        expect(ed.state.selection.head).toBe(6)
        ;(ed as any).moveVertical(1, false)
        // p2.pmStartPos = 8, target column = 5 → head = 13
        expect(ed.state.selection.head).toBe(13)
        ed.destroy()
    })

    test('phantom X persists through a short line', () =>
    {
        const long = 'this is a long paragraph here' // 29 chars
        const { ed } = makeEditor([long, 'short', long])
        // Place caret at column 10 of p1: pos 1 + 10 = 11
        ed.dispatch(ed.state.tr.setSelection(
            TextSelection.near(ed.state.doc.resolve(11)),
        ))
        ;(ed as any).moveVertical(1, false)
        // p2 'short' starts at pmStartPos = 32 (offset 31 + 1).
        // Target column 10 clamps to end of 'short' (col 5) → 32 + 5 = 37
        expect(ed.state.selection.head).toBe(37)
        // Phantom X should still be the original (10 cols * 8 px = 80)
        expect((ed as any).phantomX).toBe(80)
        ;(ed as any).moveVertical(1, false)
        // p3 starts at offset 38 + 1 = 39. Phantom X 80 = col 10 → head = 49
        expect(ed.state.selection.head).toBe(49)
        ed.destroy()
    })

    test('ArrowUp at top snaps to the first text cursor in the doc', () =>
    {
        // For doc(p('hello')): the first valid text cursor is at pos 1
        // (TextSelection.near resolves pos 0 → 1).
        const { ed } = makeEditor(['hello'])
        ed.dispatch(ed.state.tr.setSelection(
            TextSelection.near(ed.state.doc.resolve(3)),
        ))
        ;(ed as any).moveVertical(-1, false)
        expect(ed.state.selection.head).toBe(1)
        ed.destroy()
    })

    test('ArrowDown at bottom snaps to the last text cursor in the doc', () =>
    {
        // For doc(p('hello')): the last valid text cursor is at pos 6
        // (after 'o', before the closing token).
        const { ed } = makeEditor(['hello'])
        ed.dispatch(ed.state.tr.setSelection(
            TextSelection.near(ed.state.doc.resolve(2)),
        ))
        ;(ed as any).moveVertical(1, false)
        expect(ed.state.selection.head).toBe(6)
        ed.destroy()
    })

    test('horizontal motion clears phantom X', () =>
    {
        const { ed } = makeEditor(['hello', 'world'])
        ;(ed as any).phantomX = 50
        ed.dispatch(ed.state.tr.insertText('x', 1))
        expect((ed as any).phantomX).toBeNull()
        ed.destroy()
    })
})


describe('split and join', () =>
{
    test('split at middle creates two paragraphs', () =>
    {
        const { ed } = makeEditor(['helloworld'])
        ed.dispatch(ed.state.tr.setSelection(
            TextSelection.near(ed.state.doc.resolve(6)),
        ))
        ;(ed as any).splitBlock()
        expect(ed.state.doc.childCount).toBe(2)
        expect(ed.state.doc.child(0).textContent).toBe('hello')
        expect(ed.state.doc.child(1).textContent).toBe('world')
        ed.destroy()
    })

    test('split deletes the active selection first', () =>
    {
        const { ed } = makeEditor(['helloworld'])
        const $from = ed.state.doc.resolve(6)
        const $to = ed.state.doc.resolve(11)
        ed.dispatch(ed.state.tr.setSelection(
            TextSelection.between($from, $to),
        ))
        ;(ed as any).splitBlock()
        expect(ed.state.doc.childCount).toBe(2)
        expect(ed.state.doc.child(0).textContent).toBe('hello')
        expect(ed.state.doc.child(1).textContent).toBe('')
        ed.destroy()
    })

    test('Backspace via keydown deletes the previous character', () =>
    {
        // The textarea is empty between inputs, so Backspace must be
        // handled in the keydown path — the browser won't fire an
        // input event for it.
        const { ed } = makeEditor(['hello'])
        ed.dispatch(ed.state.tr.setSelection(
            TextSelection.near(ed.state.doc.resolve(4)),
        ))
        const ta = (ed as any).textarea as HTMLTextAreaElement
        ta.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Backspace',
            bubbles: true,
            cancelable: true,
        }))
        expect(ed.state.doc.firstChild!.textContent).toBe('helo')
        ed.destroy()
    })

    test('Delete via keydown removes the next character', () =>
    {
        const { ed } = makeEditor(['hello'])
        ed.dispatch(ed.state.tr.setSelection(
            TextSelection.near(ed.state.doc.resolve(3)),
        ))
        const ta = (ed as any).textarea as HTMLTextAreaElement
        ta.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Delete',
            bubbles: true,
            cancelable: true,
        }))
        expect(ed.state.doc.firstChild!.textContent).toBe('helo')
        ed.destroy()
    })

    test('Backspace at the start of a non-first paragraph joins it backward', () =>
    {
        const { ed } = makeEditor(['hello', 'world'])
        // pmStartPos for second paragraph = 8
        ed.dispatch(ed.state.tr.setSelection(
            TextSelection.near(ed.state.doc.resolve(8)),
        ))
        const ta = (ed as any).textarea as HTMLTextAreaElement
        const ev = new InputEvent('input', {
            inputType: 'deleteContentBackward',
        } as InputEventInit)
        ta.dispatchEvent(ev)
        expect(ed.state.doc.childCount).toBe(1)
        expect(ed.state.doc.firstChild!.textContent).toBe('helloworld')
        ed.destroy()
    })

    test('Backspace at the start of the first paragraph is a no-op', () =>
    {
        const { ed } = makeEditor(['hello'])
        ed.dispatch(ed.state.tr.setSelection(
            TextSelection.near(ed.state.doc.resolve(1)),
        ))
        const before = ed.state.doc.toString()
        const ta = (ed as any).textarea as HTMLTextAreaElement
        ta.dispatchEvent(new InputEvent('input', {
            inputType: 'deleteContentBackward',
        } as InputEventInit))
        expect(ed.state.doc.toString()).toBe(before)
        ed.destroy()
    })
})


describe('graphemes', () =>
{
    // 🇺🇸 = two regional indicator code points (U+1F1FA U+1F1F8).
    // Each lives in the supplementary plane so each takes 2 UTF-16 code
    // units → 4 total. The pair renders as a single perceived character.
    const flag = '\u{1F1FA}\u{1F1F8}'

    test('flag emoji length sanity check', () =>
    {
        expect(flag.length).toBe(4)
    })

    test('ArrowRight steps over a multi-code-unit grapheme', () =>
    {
        const { ed } = makeEditor([flag + 'abc'])
        ed.dispatch(ed.state.tr.setSelection(
            TextSelection.near(ed.state.doc.resolve(1)),
        ))
        ;(ed as any).moveSelection(1, false)
        // Past the flag (4 code units) → pos 5
        expect(ed.state.selection.head).toBe(5)
        ed.destroy()
    })

    test('ArrowLeft steps back over a multi-code-unit grapheme', () =>
    {
        const { ed } = makeEditor(['a' + flag])
        // Caret right after the flag: 'a' (1) + flag (4) = offset 5,
        // pmStartPos 1 → pos 6.
        ed.dispatch(ed.state.tr.setSelection(
            TextSelection.near(ed.state.doc.resolve(6)),
        ))
        ;(ed as any).moveSelection(-1, false)
        // Should land before the flag, after 'a' → pos 2
        expect(ed.state.selection.head).toBe(2)
        ed.destroy()
    })

    test('Backspace removes a whole multi-code-unit grapheme', () =>
    {
        const { ed } = makeEditor(['a' + flag])
        ed.dispatch(ed.state.tr.setSelection(
            TextSelection.near(ed.state.doc.resolve(6)),
        ))
        const ta = (ed as any).textarea as HTMLTextAreaElement
        ta.dispatchEvent(new InputEvent('input', {
            inputType: 'deleteContentBackward',
        } as InputEventInit))
        expect(ed.state.doc.firstChild!.textContent).toBe('a')
        ed.destroy()
    })

    test('Delete (forward) removes a whole multi-code-unit grapheme', () =>
    {
        const { ed } = makeEditor([flag + 'a'])
        // Caret at start of paragraph content → pos 1
        ed.dispatch(ed.state.tr.setSelection(
            TextSelection.near(ed.state.doc.resolve(1)),
        ))
        const ta = (ed as any).textarea as HTMLTextAreaElement
        ta.dispatchEvent(new InputEvent('input', {
            inputType: 'deleteContentForward',
        } as InputEventInit))
        expect(ed.state.doc.firstChild!.textContent).toBe('a')
        ed.destroy()
    })
})


describe('scroll virtualization', () =>
{
    // Give a scroller a real viewport so the editor switches into its
    // virtualized paint path (happy-dom reports clientHeight 0 by default).
    function giveViewport(ed: CanvasEditor, height: number, scrollTop = 0): HTMLElement
    {
        const scroller = (ed as any).scroller as HTMLElement
        Object.defineProperty(scroller, 'clientHeight', {
            value: height, configurable: true,
        })
        Object.defineProperty(scroller, 'scrollTop', {
            value: scrollTop, writable: true, configurable: true,
        })
        return scroller
    }

    test('viewport present: canvas is pinned and the stack spans the doc', () =>
    {
        const { ed } = makeEditor(['a', 'b', 'c', 'd', 'e'], { maxHeight: 100 })
        giveViewport(ed, 100)
        ;(ed as any).render()
        expect((ed as any).canvas.style.position).toBe('sticky')
        // Spacer height = full document height (single-line mock: 26px lines).
        expect((ed as any).stack.style.height).not.toBe('')
        ed.destroy()
    })

    test('no measurable viewport: canvas stays in normal flow', () =>
    {
        // happy-dom leaves clientHeight at 0, so virtualization stays off.
        const { ed } = makeEditor(['a', 'b'], { maxHeight: 100 })
        ;(ed as any).render()
        expect((ed as any).canvas.style.position).not.toBe('sticky')
        ed.destroy()
    })

    test('click coords are offset by scrollTop when virtualized', () =>
    {
        const { ed } = makeEditor(['a', 'b', 'c'], { maxHeight: 100 })
        giveViewport(ed, 100, 40)
        // happy-dom getBoundingClientRect is all zeros, so the only Y shift
        // is the scrollTop the editor adds back to reach document space.
        const coords = (ed as any).eventToDocCoords({ clientX: 10, clientY: 5 })
        expect(coords.x).toBe(10)
        expect(coords.y).toBe(45)
        ed.destroy()
    })

    test('scrolling the scroller schedules a repaint', async () =>
    {
        const { ed, stats } = makeEditor(['a', 'b', 'c'], { maxHeight: 100 })
        const scroller = giveViewport(ed, 100)
        const before = stats.length
        scroller.dispatchEvent(new Event('scroll'))
        await nextFrame()
        expect(stats.length).toBeGreaterThan(before)
        ed.destroy()
    })

    test('clicking in the gap between blocks snaps to the nearest block, not the last', () =>
    {
        // Single-line mock: each block is 26px tall, blockGap 20px.
        // block a: y[0,26], gap [26,46], block b: y[46,72], block c: y[92,118].
        const { ed } = makeEditor(['aaaa', 'bbbb', 'cccc'])
        const layouts = (ed as any).lastLayouts
        // Click 4px into the gap after block a (y=30) → nearest is block a.
        const inGapNearA = (ed as any).clickToPos(layouts, 0, 30)
        expect(inGapNearA.pos).toBeGreaterThanOrEqual(layouts[0].pmStartPos)
        expect(inGapNearA.pos).toBeLessThanOrEqual(layouts[0].pmEndPos)
        // Click 4px above block b (y=42) → nearest is block b, NOT last block c.
        const inGapNearB = (ed as any).clickToPos(layouts, 0, 42)
        expect(inGapNearB.pos).toBeLessThanOrEqual(layouts[1].pmEndPos)
        ed.destroy()
    })

    test('blocks outside the viewport are culled from painting', () =>
    {
        // 5 single-line paragraphs. lineHeight 26, blockGap 20 →
        // yOffsets: a=0, b=46, c=92, d=138, e=184.
        const { ed } = makeEditor(['a', 'b', 'c', 'd', 'e'], { maxHeight: 50 })
        // Park the caret inside 'c' (pos 7) so ensureCaretVisible doesn't pull
        // the scroll back to the top before we paint.
        ed.dispatch(ed.state.tr.setSelection(
            TextSelection.near(ed.state.doc.resolve(7)),
        ))
        giveViewport(ed, 50, 92) // viewport [92, 142) → only c and d intersect

        const drawn: string[] = []
        const recCtx = {
            setTransform() {}, clearRect() {}, fillRect() {},
            fillText(text: string) { drawn.push(text) },
            measureText(s: string) { return { width: s.length * 8 } },
            set fillStyle(_v: unknown) {}, set font(_v: unknown) {},
            set textBaseline(_v: unknown) {},
        }
        ;(ed as any).canvas.getContext = () => recCtx
        ;(ed as any).render()

        expect(drawn).toEqual(['c', 'd'])
        ed.destroy()
    })
})


describe('caret bias (soft-wrap affinity)', () =>
{
    // The pretext mock collapses every block to one line, so build a synthetic
    // two-line block to exercise the soft-wrap boundary directly. Lines
    // "hello" + "world": the PM offset 5 is shared (end of line 0 / start of
    // line 1).
    function twoLineBlock()
    {
        return {
            type: 'paragraph', node: {} as any, text: 'helloworld',
            yOffset: 0, height: 52, pmStartPos: 1, pmEndPos: 11,
            lines: [
                { text: 'hello', width: 40, x: 0, y: 0 },
                { text: 'world', width: 40, x: 0, y: 26 },
            ],
        }
    }

    test('boundary offset renders on the upper line when bias is -1', () =>
    {
        const { ed } = makeEditor(['x'])
        ;(ed as any).caretBias = -1
        const c = (ed as any).offsetToCoordsInBlock(twoLineBlock(), 5)
        expect(c.y).toBe(0) // end of line 0
        ed.destroy()
    })

    test('boundary offset renders on the lower line when bias is +1', () =>
    {
        const { ed } = makeEditor(['x'])
        ;(ed as any).caretBias = 1
        const c = (ed as any).offsetToCoordsInBlock(twoLineBlock(), 5)
        expect(c.y).toBe(26) // start of line 1
        expect(c.x).toBe(0)
        ed.destroy()
    })

    test('clicking the start of a wrapped line returns bias +1', () =>
    {
        const { ed } = makeEditor(['x'])
        const layouts = [twoLineBlock()]
        // Click at the very start of line 1 (x≈0, y in [26,52]).
        const hit = (ed as any).clickToPos(layouts, 0, 31)
        expect(hit.pos).toBe(6) // pmStartPos(1) + offset 5
        expect(hit.bias).toBe(1)
        ed.destroy()
    })

    test('clicking mid-line keeps the default bias -1', () =>
    {
        const { ed } = makeEditor(['x'])
        const layouts = [twoLineBlock()]
        // Mock measureText: width = len*8, so x=16 → 2 graphemes into line 1.
        const hit = (ed as any).clickToPos(layouts, 16, 31)
        expect(hit.pos).toBe(8) // 1 + 5 + 2
        expect(hit.bias).toBe(-1)
        ed.destroy()
    })

    test('dispatch resets bias to -1', () =>
    {
        const { ed } = makeEditor(['hello'])
        ;(ed as any).caretBias = 1
        ed.dispatch(ed.state.tr.insertText('x', 1))
        expect((ed as any).caretBias).toBe(-1)
        ed.destroy()
    })

    test('isAtSoftWrapBoundary detects an internal wrap, not block edges', () =>
    {
        const { ed } = makeEditor(['helloworld'])
        // Inject a two-line layout for the single paragraph: wrap at offset 5.
        ;(ed as any).lastLayouts = [twoLineBlock()]
        expect((ed as any).isAtSoftWrapBoundary(6)).toBe(true)  // boundary (offset 5)
        expect((ed as any).isAtSoftWrapBoundary(1)).toBe(false) // block start
        expect((ed as any).isAtSoftWrapBoundary(11)).toBe(false) // block end
        expect((ed as any).isAtSoftWrapBoundary(8)).toBe(false) // mid line 2
        ed.destroy()
    })

    test('stepping right onto a wrap boundary biases the caret to the next line (+1)', () =>
    {
        const { ed } = makeEditor(['helloworld'])
        // Caret just before the boundary (pos 5), then step right onto it.
        ed.dispatch(ed.state.tr.setSelection(TextSelection.near(ed.state.doc.resolve(5))))
        ;(ed as any).lastLayouts = [twoLineBlock()] // dispatch's render reset it
        ;(ed as any).moveSelection(1, false)
        expect(ed.state.selection.head).toBe(6)
        expect((ed as any).caretBias).toBe(1)
        ed.destroy()
    })

    test('stepping left onto a wrap boundary biases the caret to the previous line (-1)', () =>
    {
        const { ed } = makeEditor(['helloworld'])
        ed.dispatch(ed.state.tr.setSelection(TextSelection.near(ed.state.doc.resolve(7))))
        ;(ed as any).lastLayouts = [twoLineBlock()]
        ;(ed as any).caretBias = 1 // pretend we were leaning to the next line
        ;(ed as any).moveSelection(-1, false) // step left to the boundary (pos 6)
        expect(ed.state.selection.head).toBe(6)
        expect((ed as any).caretBias).toBe(-1)
        ed.destroy()
    })
})


describe('input handler', () =>
{
    test('insertText input event inserts a character', () =>
    {
        const { ed } = makeEditor(['hi'])
        ed.dispatch(ed.state.tr.setSelection(
            TextSelection.near(ed.state.doc.resolve(2)),
        ))
        const ta = (ed as any).textarea as HTMLTextAreaElement
        ta.dispatchEvent(new InputEvent('input', {
            inputType: 'insertText',
            data: 'X',
        } as InputEventInit))
        expect(ed.state.doc.firstChild!.textContent).toBe('hXi')
        ed.destroy()
    })

    test('deleteContentBackward in the middle removes the previous character', () =>
    {
        const { ed } = makeEditor(['hello'])
        ed.dispatch(ed.state.tr.setSelection(
            TextSelection.near(ed.state.doc.resolve(4)),
        ))
        const ta = (ed as any).textarea as HTMLTextAreaElement
        ta.dispatchEvent(new InputEvent('input', {
            inputType: 'deleteContentBackward',
        } as InputEventInit))
        expect(ed.state.doc.firstChild!.textContent).toBe('helo')
        ed.destroy()
    })

    test('non-empty selection plus insertText replaces the range', () =>
    {
        const { ed } = makeEditor(['hello'])
        ed.dispatch(ed.state.tr.setSelection(
            TextSelection.between(
                ed.state.doc.resolve(2),
                ed.state.doc.resolve(5),
            ),
        ))
        const ta = (ed as any).textarea as HTMLTextAreaElement
        ta.dispatchEvent(new InputEvent('input', {
            inputType: 'insertText',
            data: 'EY',
        } as InputEventInit))
        expect(ed.state.doc.firstChild!.textContent).toBe('hEYo')
        ed.destroy()
    })
})
