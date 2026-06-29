import { describe, test, expect } from 'bun:test'
import { Schema, type NodeSpec, type MarkSpec } from 'prosemirror-model'
import { EditorState, TextSelection, NodeSelection } from 'prosemirror-state'
import { toggleMark } from 'prosemirror-commands'
import { history, undo, redo } from 'prosemirror-history'
import { CanvasEditor, type RenderStats } from '../src/editor'
import { GapCursor } from 'prosemirror-gapcursor'
import { markSpecs, buildMarkKeymap } from '../src/marks'
import { expandCollapsedWhitespace } from '../src/text'
import { Decoration } from '../src/decoration'

const nodes: Record<string, NodeSpec> = {
    doc: { content: '(paragraph | widget | heading | blockquote | code_block | horizontal_rule | bullet_list | ordered_list)+' },
    paragraph: {
        content: 'text*',
        attrs: { align: { default: null } },
        toDOM: () => ['p', 0],
        parseDOM: [{ tag: 'p' }],
    },
    heading: {
        content: 'text*',
        group: 'block',
        attrs: { level: { default: 1 } },
        toDOM: (n) => [`h${n.attrs['level']}`, 0],
        parseDOM: [1, 2, 3].map((l) => ({ tag: `h${l}`, attrs: { level: l } })),
    },
    blockquote: {
        content: 'text*',
        group: 'block',
        toDOM: () => ['blockquote', 0],
        parseDOM: [{ tag: 'blockquote' }],
    },
    code_block: {
        content: 'text*',
        group: 'block',
        marks: '',
        code: true,
        toDOM: () => ['pre', ['code', 0]],
        parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' }],
    },
    horizontal_rule: {
        group: 'block',
        toDOM: () => ['hr'],
        parseDOM: [{ tag: 'hr' }],
    },
    ordered_list: {
        content: 'list_item+',
        group: 'block',
        attrs: { order: { default: 1 } },
        toDOM: () => ['ol', 0],
        parseDOM: [{ tag: 'ol' }],
    },
    bullet_list: {
        content: 'list_item+',
        group: 'block',
        toDOM: () => ['ul', 0],
        parseDOM: [{ tag: 'ul' }],
    },
    list_item: {
        content: 'paragraph block*',
        defining: true,
        toDOM: () => ['li', 0],
        parseDOM: [{ tag: 'li' }],
    },
    // A leaf/atom block for node-view tests.
    widget: {
        atom: true,
        group: 'block',
        toDOM: () => ['div', { class: 'w' }],
        parseDOM: [{ tag: 'div.w' }],
    },
    text: { inline: true },
}
const marks: Record<string, MarkSpec> = { ...markSpecs }
const schema = new Schema({ nodes, marks })

/** Build a text node carrying the named marks. */
function mtext(s: string, ...markNames: string[])
{
    return schema.text(s, markNames.map((n) => schema.marks[n].create()))
}

/** Build a text node carrying a link mark with the given href. */
function ltext(s: string, href: string)
{
    return schema.text(s, [schema.marks['link'].create({ href })])
}

function makeDoc(...paragraphs: string[])
{
    return schema.node('doc', null, paragraphs.map((p) =>
        schema.node('paragraph', null, p ? [schema.text(p)] : []),
    ))
}

function makeEditor(
    paragraphs: string[] = ['hello'],
    extraOpts: { onRender?: (s: RenderStats) => void, maxHeight?: number, floats?: any[], floatGutter?: number, placeholder?: string } = {},
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
                { text: 'hello', width: 40, x: 0, y: 0, pmStart: 0 },
                { text: 'world', width: 40, x: 0, y: 26, pmStart: 5 },
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


describe('marked text coordinates', () =>
{
    // "ab CD ef" with CD bold. textContent: a0 b1 ' '2 C3 D4 ' '5 e6 f7.
    // Mock geometry (len*8, 8px collapsed-space gaps):
    //   frag 'ab' pm0 x0 w16 | 'CD' pm3 x24 w16 | 'ef' pm6 x48 w16
    function markedEditor()
    {
        const doc = schema.node('doc', null, [
            schema.node('paragraph', null, [
                mtext('ab '), mtext('CD', 'strong'), mtext(' ef'),
            ]),
        ])
        const container = document.createElement('div')
        document.body.appendChild(container)
        const ed = new CanvasEditor({ state: EditorState.create({ doc, schema }), container })
        return ed
    }

    test('lays out fragments with per-run fonts, x positions, and PM offsets', () =>
    {
        const ed = markedEditor()
        const frags = (ed as any).lastLayouts[0].lines[0].fragments
        // Boundary spaces are appended to the preceding run, not dropped.
        expect(frags.map((f: any) => f.text)).toEqual(['ab ', 'CD ', 'ef'])
        expect(frags.map((f: any) => f.pmStart)).toEqual([0, 3, 6])
        expect(frags.map((f: any) => Math.round(f.x))).toEqual([0, 24, 48])
        expect(frags[0].font).toBe('16px Inter')
        expect(frags[1].font).toBe('700 16px Inter')
        expect(frags[1].color).toBeNull()
        ed.destroy()
    })

    test('caret x is measured in each run\'s own font', () =>
    {
        const ed = markedEditor()
        const block = (ed as any).lastLayouts[0]
        const x = (o: number) => (ed as any).offsetToCoordsInBlock(block, o).x
        expect(x(0)).toBe(0)   // start
        expect(x(2)).toBe(16)  // end of 'ab'
        expect(x(3)).toBe(24)  // start of bold 'CD' (past the collapsed space)
        expect(x(5)).toBe(40)  // end of 'CD'
        expect(x(6)).toBe(48)  // start of 'ef'
        expect(x(8)).toBe(64)  // end of line
        ed.destroy()
    })

    test('clicking inside a marked run hits the right PM position', () =>
    {
        const ed = markedEditor()
        const layouts = (ed as any).lastLayouts
        // x=34 → 10px into the 'CD' run (x 24..40) → past 'C' (8) → offset 1 → pm 4 → pos 5.
        expect((ed as any).clickToPos(layouts, 34, 13).pos).toBe(5)
        // x=4 → start of 'ab' → pos 1.
        expect((ed as any).clickToPos(layouts, 4, 13).pos).toBe(1)
        // x=50 → 2px into 'ef' (x 48..64) → offset 0 → pm 6 → pos 7.
        expect((ed as any).clickToPos(layouts, 50, 13).pos).toBe(7)
        ed.destroy()
    })

    test('expandCollapsedWhitespace re-expands runs of spaces from the source', () =>
    {
        const ex = (s: string, start: number, c: string) =>
            expandCollapsedWhitespace(s, start, c)
        // Pretext collapsed "hello   world" → "hello world"; restore all spaces.
        expect(ex('hello   world', 0, 'hello world')).toEqual(['hello   world', 13])
        // Already single-spaced: unchanged.
        expect(ex('a b c', 0, 'a b c')).toEqual(['a b c', 5])
        // Continuing a run across a wrap (start offset into source).
        expect(ex('foo   bar baz', 0, 'foo bar')).toEqual(['foo   bar', 9])
    })

    test('caret advances through a trailing space collapsed out of a marked run', () =>
    {
        // One bold run "bold " — Pretext trims the trailing space into a gap,
        // so the fragment is just "bold" (width 32). The caret after the space
        // must still advance, not sit stuck at the end of "bold".
        const doc = schema.node('doc', null, [
            schema.node('paragraph', null, [mtext('bold ', 'strong')]),
        ])
        const container = document.createElement('div')
        document.body.appendChild(container)
        const ed = new CanvasEditor({ state: EditorState.create({ doc, schema }), container })
        const block = (ed as any).lastLayouts[0]
        expect((ed as any).offsetToCoordsInBlock(block, 4).x).toBe(32) // after "bold"
        expect((ed as any).offsetToCoordsInBlock(block, 5).x).toBe(40) // after the space (+8)
        ed.destroy()
    })

    test('clicking the collapsed-space gap snaps to the nearer run boundary', () =>
    {
        const ed = markedEditor()
        const layouts = (ed as any).lastLayouts
        // Gap between 'ab' (ends x16) and 'CD' (starts x24), midpoint 20.
        expect((ed as any).clickToPos(layouts, 17, 13).pos).toBe(3) // nearer 'ab' end → pm2 → pos3
        expect((ed as any).clickToPos(layouts, 23, 13).pos).toBe(4) // nearer 'CD' start → pm3 → pos4
        ed.destroy()
    })

    test('selection rect spans a marked run using its run font widths', () =>
    {
        const ed = markedEditor()
        // Select the bold 'CD' run: PM positions 4..6 (block pmStart 1 + offsets 3..5).
        ed.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, 4, 6)))
        const rects: { x: number, w: number }[] = []
        const recCtx = {
            setTransform() {}, clearRect() {}, fillText() {},
            fillRect(x: number, _y: number, w: number) { rects.push({ x: Math.round(x), w: Math.round(w) }) },
            measureText(s: string) { return { width: s.length * 8 } },
            set fillStyle(_v: unknown) {}, set font(_v: unknown) {}, set textBaseline(_v: unknown) {},
        }
        ;(ed as any).canvas.getContext = () => recCtx
        ;(ed as any).render()
        // 'CD' occupies x 24..40 → one selection rect there.
        expect(rects).toContainEqual({ x: 24, w: 16 })
        ed.destroy()
    })
})


describe('coordsAtPos / selectionRect (toolbar anchoring)', () =>
{
    // happy-dom getBoundingClientRect is all zeros, so viewport coords equal
    // document coords here. Mock: 8px/char, lineHeight 26.
    test('coordsAtPos maps a doc position to viewport coords', () =>
    {
        const { ed } = makeEditor(['hello'])
        const c = (ed as any).coordsAtPos(4) // after "hel"
        expect(c).toEqual({ x: 24, y: 0, height: 26 })
        ed.destroy()
    })

    test('selectionRect spans the selection, null when empty', () =>
    {
        const { ed } = makeEditor(['hello'])
        expect(ed.selectionRect()).toBeNull()
        ed.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, 1, 4)))
        expect(ed.selectionRect()).toEqual({ left: 0, right: 24, top: 0, bottom: 26 })
        ed.destroy()
    })
})


describe('links & decorations', () =>
{
    // "see here now" with "here" linked. Block offsets: "see " 0-3, "here" 4-7,
    // " now" 8-11. (Mock: 8px/char.)
    function linkEditor(opts: { onFollowLink?: (href: string, e: MouseEvent) => void } = {})
    {
        const doc = schema.node('doc', null, [
            schema.node('paragraph', null, [
                mtext('see '), ltext('here', 'https://x.com'), mtext(' now'),
            ]),
        ])
        const container = document.createElement('div')
        document.body.appendChild(container)
        return new CanvasEditor({ state: EditorState.create({ doc, schema }), container, ...opts })
    }

    test('a link renders as an underlined, colored run', () =>
    {
        const ed = linkEditor()
        const frags = (ed as any).lastLayouts[0].lines[0].fragments
        const linkFrag = frags.find((f: any) => f.underline)
        expect(linkFrag).toBeTruthy()
        expect(linkFrag.text.startsWith('here')).toBe(true)
        expect(linkFrag.color).toBe('#7aa2f7') // default link color
        // A run differing only in decoration is its own fragment.
        expect(frags.length).toBe(3)
        ed.destroy()
    })

    test('underline and strikethrough marks set fragment flags', () =>
    {
        const doc = schema.node('doc', null, [
            schema.node('paragraph', null, [
                mtext('a', 'underline'), mtext('b', 'strikethrough'), mtext('c'),
            ]),
        ])
        const container = document.createElement('div')
        document.body.appendChild(container)
        const ed = new CanvasEditor({ state: EditorState.create({ doc, schema }), container })
        const frags = (ed as any).lastLayouts[0].lines[0].fragments
        expect(frags[0].underline).toBe(true)
        expect(frags[1].strikethrough).toBe(true)
        expect(!!frags[2].underline).toBe(false)
        ed.destroy()
    })

    test('linkHrefAt resolves inside the link, null elsewhere', () =>
    {
        const ed = linkEditor()
        expect((ed as any).linkHrefAt(6)).toBe('https://x.com') // inside "here"
        expect((ed as any).linkHrefAt(2)).toBeNull() // inside "see"
        ed.destroy()
    })

    test('Cmd/Ctrl-click on a link follows it instead of moving the caret', () =>
    {
        const box: { v: string | null } = { v: null }
        const ed = linkEditor({ onFollowLink: (href) => { box.v = href } })
        const canvas = (ed as any).canvas as HTMLCanvasElement
        // x=40 lands in the "here" run (mock geometry); metaKey → follow.
        canvas.dispatchEvent(new MouseEvent('mousedown', {
            button: 0, clientX: 40, clientY: 13, metaKey: true, bubbles: true, cancelable: true,
        }))
        expect(box.v).toBe('https://x.com')
        // Selection stayed put (caret not moved into the link).
        expect(ed.state.selection.empty).toBe(true)
        ed.destroy()
    })

    test('plain click on a link moves the caret (does not follow)', () =>
    {
        const box: { v: string | null } = { v: null }
        const ed = linkEditor({ onFollowLink: (href) => { box.v = href } })
        const canvas = (ed as any).canvas as HTMLCanvasElement
        canvas.dispatchEvent(new MouseEvent('mousedown', {
            button: 0, clientX: 40, clientY: 13, bubbles: true, cancelable: true,
        }))
        expect(box.v).toBeNull()
        expect(ed.state.selection.head).toBeGreaterThan(1) // caret landed in the link
        ed.destroy()
    })
})


describe('placeholder & hard breaks', () =>
{
    function recordFillText(ed: CanvasEditor): string[]
    {
        const drawn: string[] = []
        const ctx = {
            setTransform() {}, clearRect() {}, fillRect() {},
            fillText(t: string) { drawn.push(t) },
            measureText(s: string) { return { width: s.length * 8 } },
            set fillStyle(_v: unknown) {}, set font(_v: unknown) {}, set textBaseline(_v: unknown) {},
        }
        ;(ed as any).canvas.getContext = () => ctx
        ;(ed as any).render()
        return drawn
    }

    test('placeholder paints when the document is empty', () =>
    {
        const { ed } = makeEditor([''], { placeholder: 'Type here…' })
        expect(recordFillText(ed)).toContain('Type here…')
        ed.destroy()
    })

    test('placeholder is hidden once the document has content', () =>
    {
        const { ed } = makeEditor(['hi'], { placeholder: 'Type here…' })
        expect(recordFillText(ed)).not.toContain('Type here…')
        ed.destroy()
    })

    test('Shift+Enter inserts a newline (hard break) instead of splitting', () =>
    {
        const { ed } = makeEditor(['helloworld'])
        ed.dispatch(ed.state.tr.setSelection(TextSelection.near(ed.state.doc.resolve(6))))
        const ta = (ed as any).textarea as HTMLTextAreaElement
        ta.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', shiftKey: true, bubbles: true, cancelable: true,
        }))
        expect(ed.state.doc.childCount).toBe(1) // not split
        expect(ed.state.doc.firstChild!.textContent).toBe('hello\nworld')
        ed.destroy()
    })
})


describe('block box decorations (blockquote / code-block / hr)', () =>
{
    function blockEditor(node: any)
    {
        const doc = schema.node('doc', null, [
            node,
            schema.node('paragraph', null, [schema.text('after')]),
        ])
        const container = document.createElement('div')
        document.body.appendChild(container)
        const ed = new CanvasEditor({ state: EditorState.create({ doc, schema }), container })
        return ed
    }

    test('blockquote: indented lines + left border + italic, paragraph unaffected', () =>
    {
        const ed = blockEditor(schema.node('blockquote', null, [schema.text('quoted')]))
        const [bq, p] = (ed as any).lastLayouts
        expect(bq.lines[0].x).toBe(18) // paddingLeft
        expect(bq.borderLeft).toEqual({ width: 3, color: '#3a3a42' })
        expect(bq.font).toContain('italic')
        // The plain paragraph after it keeps the editor defaults.
        expect(p.lines[0].x).toBe(0)
        expect(p.borderLeft).toBeNull()
        ed.destroy()
    })

    test('code-block: background panel, monospace, vertical padding adds height', () =>
    {
        const ed = blockEditor(schema.node('code_block', null, [schema.text('x = 1')]))
        const cb = (ed as any).lastLayouts[0]
        expect(cb.background).toBe('#1c1c20')
        expect(cb.font).toContain('monospace')
        expect(cb.lines[0].x).toBe(14) // paddingLeft
        // one content line (26) + paddingTop 10 + paddingBottom 10
        expect(cb.height).toBe(46)
        ed.destroy()
    })

    test('horizontal rule: a selectable atom block with reserved height', () =>
    {
        const ed = blockEditor(schema.node('horizontal_rule'))
        const hr = (ed as any).lastLayouts[0]
        expect(hr.isAtom).toBe(true)
        expect(hr.height).toBe(26)
        expect(hr.lines.length).toBe(0)
        // Selecting it is a NodeSelection (handled by the atom machinery).
        ed.dispatch(ed.state.tr.setSelection(NodeSelection.create(ed.state.doc, hr.pmStartPos)))
        expect((ed.state.selection as any).node?.type.name).toBe('horizontal_rule')
        ed.destroy()
    })
})


describe('accessibility', () =>
{
    function mk(doc: any, opts: any = {})
    {
        const container = document.createElement('div')
        document.body.appendChild(container)
        return new CanvasEditor({
            state: EditorState.create({ doc, schema }),
            container,
            nodeViews: { widget: () => document.createElement('div') },
            ...opts,
        })
    }
    const simple = () => schema.node('doc', null, [schema.node('paragraph', null, [schema.text('hi')])])

    test('canvas is hidden from AT; textarea is a labelled multiline textbox', () =>
    {
        const e = mk(simple())
        expect((e as any).canvas.getAttribute('aria-hidden')).toBe('true')
        const ta = (e as any).textarea as HTMLTextAreaElement
        expect(ta.getAttribute('aria-multiline')).toBe('true')
        expect(ta.getAttribute('role')).toBe('textbox')
        expect(ta.getAttribute('aria-label')).toBe('Rich text editor')
        e.destroy()
    })

    test('ariaLabel option overrides the accessible name', () =>
    {
        const e = mk(simple(), { ariaLabel: 'My notes' })
        expect((e as any).textarea.getAttribute('aria-label')).toBe('My notes')
        e.destroy()
    })

    test('the DOM mirror serializes document structure for screen readers', () =>
    {
        const doc = schema.node('doc', null, [
            schema.node('heading', { level: 1 }, [schema.text('Title')]),
            schema.node('paragraph', null, [schema.text('body')]),
            schema.node('bullet_list', null, [
                schema.node('list_item', null, [schema.node('paragraph', null, [schema.text('item')])]),
            ]),
        ])
        const e = mk(doc)
        const mirror = (e as any).a11yMirror as HTMLElement
        expect(mirror).not.toBeNull()
        expect(mirror.querySelector('h1')?.textContent).toBe('Title')
        expect(mirror.querySelector('p')?.textContent).toBe('body')
        expect(mirror.querySelector('ul li')?.textContent).toBe('item')
        e.destroy()
    })

    test('the mirror updates when the document changes', () =>
    {
        const e = mk(simple())
        ;(e as any).a11yMirror // ensure present
        e.dispatch(e.state.tr.insertText('!', 1))
        expect(((e as any).a11yMirror as HTMLElement).textContent).toContain('!hi')
        e.destroy()
    })

    test('the mirror can be disabled', () =>
    {
        const e = mk(simple(), { a11yMirror: false })
        expect((e as any).a11yMirror).toBeNull()
        e.destroy()
    })

    test('navigating into a structural block announces its role (live region)', () =>
    {
        const doc = schema.node('doc', null, [
            schema.node('paragraph', null, [schema.text('x')]),
            schema.node('heading', { level: 2 }, [schema.text('Section')]),
        ])
        const e = mk(doc)
        const heading = (e as any).lastLayouts[1]
        e.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, heading.pmStartPos)))
        expect((e as any).liveRegion.textContent).toBe('Heading 2')
        e.destroy()
    })

    test('announce() voices a custom message via the live region', () =>
    {
        const e = mk(simple())
        e.announce('Ran: 42')
        expect((e as any).liveRegion.textContent).toBe('Ran: 42')
        e.destroy()
    })

    test('a non-interactive node view is hidden from AT (mirror represents it)', () =>
    {
        const doc = schema.node('doc', null, [
            schema.node('paragraph', null, [schema.text('x')]),
            schema.node('widget'),
        ])
        const e = mk(doc) // widget node view is a plain <div>
        const views = [...(e as any).mountedViews.values()] as any[]
        expect(views.length).toBe(1)
        expect(views[0].container.getAttribute('aria-hidden')).toBe('true')
        e.destroy()
    })

    test('an interactive node view stays exposed to AT', () =>
    {
        const doc = schema.node('doc', null, [schema.node('widget')])
        const container = document.createElement('div')
        document.body.appendChild(container)
        const e = new CanvasEditor({
            state: EditorState.create({ doc, schema }),
            container,
            nodeViews: { widget: () => { const d = document.createElement('div'); d.appendChild(document.createElement('button')); return d } },
        })
        const views = [...(e as any).mountedViews.values()] as any[]
        expect(views[0].container.getAttribute('aria-hidden')).toBeNull()
        e.destroy()
    })
})


describe('gap cursor (seams between atom blocks)', () =>
{
    function ed(doc: any)
    {
        const container = document.createElement('div')
        document.body.appendChild(container)
        return new CanvasEditor({
            state: EditorState.create({ doc, schema }),
            container,
            nodeViews: { widget: () => document.createElement('div') },
        })
    }
    const keydown = (e: CanvasEditor, init: KeyboardEventInit) =>
        (e as any).textarea.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
    // doc: paragraph + two stacked atoms (a gap is valid in the seam between them)
    const stacked = () => schema.node('doc', null, [
        schema.node('paragraph', null, [schema.text('x')]),
        schema.node('widget'), schema.node('widget'),
    ])

    test('arrowing down through stacked atoms lands a gap cursor in the seam', () =>
    {
        const e = ed(stacked())
        e.dispatch(e.state.tr.setSelection(TextSelection.atStart(e.state.doc)))
        keydown(e, { key: 'ArrowDown' }) // → selects first widget
        keydown(e, { key: 'ArrowDown' }) // → gap between the widgets
        expect(e.state.selection instanceof GapCursor).toBe(true)
        e.destroy()
    })

    test('Enter at a gap cursor inserts a paragraph into the seam', () =>
    {
        const e = ed(stacked())
        const gapPos = 4 // paragraph(0..3) + leaf widget(3..4) → seam at 4
        e.dispatch(e.state.tr.setSelection(new GapCursor(e.state.doc.resolve(gapPos))))
        keydown(e, { key: 'Enter' })
        // doc is now paragraph, widget, paragraph, widget
        expect(e.state.doc.childCount).toBe(4)
        expect(e.state.doc.child(2).type.name).toBe('paragraph')
        expect(e.state.selection instanceof TextSelection).toBe(true)
        e.destroy()
    })

    test('clicking in the seam between two atoms sets a gap cursor', () =>
    {
        const e = ed(stacked())
        const layouts = (e as any).lastLayouts as any[]
        const w0 = layouts.find((b) => b.type === 'widget')
        const seamY = w0.yOffset + w0.height + 1 // just inside the gap band
        ;(e as any).canvas.getBoundingClientRect = () => ({ left: 0, top: 0 })
        ;(e as any).canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 5, clientY: seamY }))
        expect(e.state.selection instanceof GapCursor).toBe(true)
        e.destroy()
    })

    test('Backspace at a gap cursor deletes the atom before it', () =>
    {
        const e = ed(stacked())
        e.dispatch(e.state.tr.setSelection(new GapCursor(e.state.doc.resolve(4))))
        keydown(e, { key: 'Backspace' })
        expect(e.state.doc.childCount).toBe(2) // first widget removed
        e.destroy()
    })

    test('a node view is shipped for the atom (image) example', () =>
    {
        // Stacked atoms with a node view are laid out as zero-line blocks.
        const e = ed(stacked())
        const atomBlocks = (e as any).lastLayouts.filter((b: any) => b.isAtom)
        expect(atomBlocks.length).toBe(2)
        expect(atomBlocks.every((b: any) => b.lines.length === 0)).toBe(true)
        e.destroy()
    })
})


describe('lists (nested structure + markers + indent)', () =>
{
    function ed(doc: any)
    {
        const container = document.createElement('div')
        document.body.appendChild(container)
        return new CanvasEditor({ state: EditorState.create({ doc, schema }), container })
    }
    const li = (text?: string) =>
        schema.node('list_item', null, [schema.node('paragraph', null, text ? [schema.text(text)] : [])])
    const keydown = (e: CanvasEditor, init: KeyboardEventInit) =>
        (e as any).textarea.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))

    test('bullet list: each item is an indented block with a bullet marker', () =>
    {
        const e = ed(schema.node('doc', null, [schema.node('bullet_list', null, [li('one'), li('two')])]))
        const ls = (e as any).lastLayouts as any[]
        expect(ls.length).toBe(2)
        expect(ls[0].marker).toEqual({ text: '•', x: 4 })
        expect(ls[0].lines[0].x).toBe(26) // one indent level
        expect(ls[0].pmStartPos).toBe(3)
        expect(ls[1].pmStartPos).toBe(10)
        e.destroy()
    })

    test('ordered list: markers are sequential numbers', () =>
    {
        const e = ed(schema.node('doc', null, [schema.node('ordered_list', null, [li('a'), li('b'), li('c')])]))
        const ls = (e as any).lastLayouts as any[]
        expect(ls.map((b) => b.marker.text)).toEqual(['1.', '2.', '3.'])
        e.destroy()
    })

    test('nested list: deeper level indents further with its own gutter', () =>
    {
        const inner = schema.node('bullet_list', null, [li('b')])
        const outer = schema.node('bullet_list', null, [
            schema.node('list_item', null, [schema.node('paragraph', null, [schema.text('a')]), inner]),
        ])
        const e = ed(schema.node('doc', null, [outer]))
        const ls = (e as any).lastLayouts as any[]
        expect(ls[0].lines[0].x).toBe(26)
        expect(ls[1].lines[0].x).toBe(52)
        expect(ls[1].marker.x).toBe(30) // gutter of level 2
        e.destroy()
    })

    test('Enter in a list item creates a new sibling item', () =>
    {
        const e = ed(schema.node('doc', null, [schema.node('bullet_list', null, [li('one')])]))
        e.dispatch(e.state.tr.setSelection(TextSelection.atEnd(e.state.doc)))
        keydown(e, { key: 'Enter' })
        ;(e as any).render()
        expect(e.state.doc.firstChild!.childCount).toBe(2) // two list items
        expect((e as any).lastLayouts.length).toBe(2)
        e.destroy()
    })

    test('Tab sinks an item one level deeper (more indent)', () =>
    {
        const e = ed(schema.node('doc', null, [schema.node('bullet_list', null, [li('one'), li('two')])]))
        // cursor into the second item
        e.dispatch(e.state.tr.setSelection(TextSelection.atEnd(e.state.doc)))
        keydown(e, { key: 'Tab' })
        ;(e as any).render()
        const ls = (e as any).lastLayouts as any[]
        expect(ls[1].lines[0].x).toBe(52) // 'two' now nested under 'one'
        e.destroy()
    })

    test('Shift-Tab lifts an item back out', () =>
    {
        const inner = schema.node('bullet_list', null, [li('b')])
        const outer = schema.node('bullet_list', null, [
            schema.node('list_item', null, [schema.node('paragraph', null, [schema.text('a')]), inner]),
        ])
        const e = ed(schema.node('doc', null, [outer]))
        e.dispatch(e.state.tr.setSelection(TextSelection.atEnd(e.state.doc))) // in 'b'
        keydown(e, { key: 'Tab', shiftKey: true })
        ;(e as any).render()
        const ls = (e as any).lastLayouts as any[]
        expect(ls[1].lines[0].x).toBe(26) // 'b' lifted to level 1
        e.destroy()
    })
})


describe('hard breaks in marked text + code-block exit', () =>
{
    function editorFromDoc(doc: any)
    {
        const container = document.createElement('div')
        document.body.appendChild(container)
        return new CanvasEditor({ state: EditorState.create({ doc, schema }), container })
    }
    function keydown(ed: CanvasEditor, init: KeyboardEventInit)
    {
        const ta = (ed as any).textarea as HTMLTextAreaElement
        ta.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
    }

    test('a marked paragraph honors \\n (splits into hard lines)', () =>
    {
        const ed = editorFromDoc(schema.node('doc', null, [
            schema.node('paragraph', null, [mtext('ab', 'strong'), schema.text('\ncd')]),
        ]))
        const p = (ed as any).lastLayouts[0]
        expect(p.lines.length).toBe(2)
        expect(p.lines[0].fragments.map((f: any) => f.text).join('')).toBe('ab')
        expect(p.lines[1].fragments.map((f: any) => f.text).join('')).toBe('cd')
        // The new line owns the '\n' offset (2), matching the single-font path,
        // so an offset just after the break lands on this line.
        expect(p.lines[1].pmStart).toBe(2)
        ed.destroy()
    })

    test('a blank line between two \\n renders as an empty marked line', () =>
    {
        const ed = editorFromDoc(schema.node('doc', null, [
            schema.node('paragraph', null, [mtext('a', 'strong'), schema.text('\n\nb')]),
        ]))
        const p = (ed as any).lastLayouts[0]
        expect(p.lines.length).toBe(3)
        expect(p.lines[1].text).toBe('')
        ed.destroy()
    })

    test('Enter in a code block inserts a newline (no split)', () =>
    {
        const ed = editorFromDoc(schema.node('doc', null, [
            schema.node('code_block', null, [schema.text('x')]),
        ]))
        ed.dispatch(ed.state.tr.setSelection(TextSelection.atEnd(ed.state.doc)))
        keydown(ed, { key: 'Enter' })
        expect(ed.state.doc.childCount).toBe(1)
        expect(ed.state.doc.firstChild!.textContent).toBe('x\n')
        ed.destroy()
    })

    test('Mod-Enter exits a code block to a paragraph below', () =>
    {
        const ed = editorFromDoc(schema.node('doc', null, [
            schema.node('code_block', null, [schema.text('x')]),
        ]))
        ed.dispatch(ed.state.tr.setSelection(TextSelection.atEnd(ed.state.doc)))
        keydown(ed, { key: 'Enter', metaKey: true })
        expect(ed.state.doc.childCount).toBe(2)
        expect(ed.state.doc.child(1).type.name).toBe('paragraph')
        expect(ed.state.selection.$from.parent.type.name).toBe('paragraph')
        ed.destroy()
    })

    test('a second Enter on a code block\'s blank last line exits to a paragraph', () =>
    {
        const ed = editorFromDoc(schema.node('doc', null, [
            schema.node('code_block', null, [schema.text('x\n')]),
        ]))
        ed.dispatch(ed.state.tr.setSelection(TextSelection.atEnd(ed.state.doc)))
        keydown(ed, { key: 'Enter' })
        expect(ed.state.doc.childCount).toBe(2)
        expect(ed.state.doc.child(0).textContent).toBe('x') // trailing \n dropped
        expect(ed.state.doc.child(1).type.name).toBe('paragraph')
        ed.destroy()
    })

    test('a multi-line code block maps offsets across newlines (no drift)', () =>
    {
        const e = editorFromDoc(schema.node('doc', null, [
            schema.node('code_block', null, [schema.text('a\nbb\nccc')]),
        ]))
        const lines = (e as any).lastLayouts[0].lines as any[]
        expect(lines.map((l) => l.text)).toEqual(['a', 'bb', 'ccc'])
        // 'a'(0) \n(1) 'bb'(2,3) \n(4) 'ccc'(5,6,7) — each line starts past its \n.
        expect(lines.map((l) => l.pmStart)).toEqual([0, 2, 5])
        e.destroy()
    })

    test('Enter at the end of a heading continues as a paragraph', () =>
    {
        const ed = editorFromDoc(schema.node('doc', null, [
            schema.node('heading', { level: 1 }, [schema.text('Title')]),
        ]))
        ed.dispatch(ed.state.tr.setSelection(TextSelection.atEnd(ed.state.doc)))
        keydown(ed, { key: 'Enter' })
        expect(ed.state.doc.childCount).toBe(2)
        expect(ed.state.doc.child(1).type.name).toBe('paragraph')
        ed.destroy()
    })
})


describe('floating nodes (text wrap)', () =>
{
    function mk(doc: any, floatRect: any)
    {
        const container = document.createElement('div')
        document.body.appendChild(container)
        return new CanvasEditor({
            state: EditorState.create({ doc, schema }),
            container,
            nodeViews: { widget: () => document.createElement('div') },
            floatRect,
        })
    }

    test('a floatRect node leaves the flow; following blocks do not shift down', () =>
    {
        const doc = schema.node('doc', null, [
            schema.node('widget'),
            schema.node('paragraph', null, [schema.text('hello world')]),
        ])
        const e = mk(doc, (n: any) => n.type.name === 'widget' ? { x: 0, y: 0, width: 100 } : null)
        const ls = (e as any).lastLayouts as any[]
        const w = ls.find((b) => b.type === 'widget')
        const para = ls.find((b) => b.type === 'paragraph')
        expect(w.floatRect).toMatchObject({ x: 0, y: 0, width: 100 })
        expect(para.yOffset).toBe(0) // the float is out of flow, so text starts at top
        expect((e as any).activeFloats.length).toBe(1)
        e.destroy()
    })

    test('without a floatRect the same node stays in flow (pushes text down)', () =>
    {
        const doc = schema.node('doc', null, [
            schema.node('widget'),
            schema.node('paragraph', null, [schema.text('hello')]),
        ])
        const e = mk(doc, () => null)
        const ls = (e as any).lastLayouts as any[]
        expect(ls.find((b) => b.type === 'paragraph').yOffset).toBeGreaterThan(0)
        expect((e as any).activeFloats.length).toBe(0)
        e.destroy()
    })
})


describe('overridable handlers', () =>
{
    function ed(handlers: any)
    {
        const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text('hello world')])])
        const container = document.createElement('div')
        document.body.appendChild(container)
        return new CanvasEditor({ state: EditorState.create({ doc, schema }), container, handlers })
    }
    const keydown = (e: CanvasEditor, init: KeyboardEventInit) =>
        (e as any).textarea.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))

    test('handlers.keyDown can suppress a built-in key', () =>
    {
        let seen = 0
        const e = ed({ keyDown: (_ed: any, ev: KeyboardEvent) => { if (ev.key === 'ArrowRight') { seen++; return true } return false } })
        e.dispatch(e.state.tr.setSelection(TextSelection.atStart(e.state.doc)))
        const before = e.state.selection.head
        keydown(e, { key: 'ArrowRight' })
        expect(seen).toBe(1)
        expect(e.state.selection.head).toBe(before) // caret didn't move
        e.destroy()
    })

    test('handlers.click receives the pos and can suppress caret placement', () =>
    {
        let gotPos = -1
        const e = ed({ click: (_ed: any, pos: number) => { gotPos = pos; return true } })
        e.dispatch(e.state.tr.setSelection(TextSelection.atEnd(e.state.doc)))
        const before = e.state.selection.head
        ;(e as any).canvas.getBoundingClientRect = () => ({ left: 0, top: 0 })
        ;(e as any).canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 8, clientY: 5 }))
        expect(gotPos).toBeGreaterThanOrEqual(1)
        expect(e.state.selection.head).toBe(before) // suppressed → caret unchanged
        e.destroy()
    })

    test('handlers.paste can override the built-in paste', () =>
    {
        let called = false
        const e = ed({ paste: () => { called = true; return true } })
        const ev = new Event('paste', { bubbles: true, cancelable: true })
        ;(ev as any).clipboardData = { getData: () => 'nope' }
        ;(e as any).textarea.dispatchEvent(ev)
        expect(called).toBe(true)
        expect(e.state.doc.textContent).toBe('hello world') // default paste skipped
        e.destroy()
    })

    test('autofocus:false does not grab focus on construction', () =>
    {
        const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text('hi')])])
        const container = document.createElement('div')
        document.body.appendChild(container)
        const e = new CanvasEditor({ state: EditorState.create({ doc, schema }), container, autofocus: false })
        expect(e.hasFocus()).toBe(false)
        e.focus()
        expect(e.hasFocus()).toBe(true)
        e.destroy()
    })

    test('handlers.domEvents binds arbitrary events on the container', () =>
    {
        let hits = 0
        const e = ed({ domEvents: { mouseover: () => { hits++; return true } } })
        ;(e as any).stack.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
        expect(hits).toBe(1)
        e.destroy()
    })
})


describe('decorations (inline / node / widget)', () =>
{
    function ed(opts: any)
    {
        const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text('hello')])])
        const container = document.createElement('div')
        document.body.appendChild(container)
        return new CanvasEditor({ state: EditorState.create({ doc, schema }), container, ...opts })
    }
    // A recording 2D context that captures fillRect calls + their fillStyle.
    function record(e: CanvasEditor): { fill: string, x: number, y: number, w: number, h: number }[]
    {
        const rects: any[] = []
        let cur = ''
        const ctx: any = {
            setTransform() {}, clearRect() {}, fillText() {}, save() {}, restore() {},
            beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
            measureText: (s: string) => ({ width: s.length * 8 }),
            fillRect: (x: number, y: number, w: number, h: number) => rects.push({ fill: cur, x, y, w, h }),
            set fillStyle(v: string) { cur = v }, get fillStyle() { return cur },
            set font(_v: string) {}, set textBaseline(_v: string) {},
            set strokeStyle(_v: string) {}, set lineWidth(_v: number) {},
        }
        ;(e as any).canvas.getContext = () => ctx
        ;(e as any).render()
        return rects
    }

    test('inline decoration paints a background over its range', () =>
    {
        const e = ed({ decorations: () => [Decoration.inline(1, 4, { background: '#ffee00' })] })
        const rects = record(e)
        // "hel" = offsets 0..3 → width 24 in the mock
        expect(rects.some((r) => r.fill === '#ffee00' && r.w === 24 && r.x === 0)).toBe(true)
        e.destroy()
    })

    test('node decoration paints a full-width background on its block', () =>
    {
        const e = ed({ decorations: () => [Decoration.node(0, { background: '#0000ff' })] })
        const rects = record(e)
        expect(rects.some((r) => r.fill === '#0000ff' && r.w === 460)).toBe(true)
        e.destroy()
    })

    test('widget decoration mounts a DOM element at its position', () =>
    {
        const el = document.createElement('span')
        el.textContent = '▍'
        const e = ed({ decorations: () => [Decoration.widget(3, el, { key: 'cursor' })] })
        expect((e as any).mountedWidgets.get('cursor')).toBe(el)
        expect(el.isConnected).toBe(true)
        expect(el.style.position).toBe('absolute')
        e.destroy()
    })

    test('widgets are removed when no longer present', () =>
    {
        let show = true
        const el = document.createElement('span')
        const e = ed({ decorations: () => show ? [Decoration.widget(3, el, { key: 'k' })] : [] })
        expect((e as any).mountedWidgets.has('k')).toBe(true)
        show = false
        ;(e as any).render()
        expect((e as any).mountedWidgets.has('k')).toBe(false)
        expect(el.isConnected).toBe(false)
        e.destroy()
    })
})


describe('view API parity (posAtCoords / endOfTextblock / editable / paste)', () =>
{
    function ed(texts: string[], opts: any = {})
    {
        const doc = schema.node('doc', null, texts.map((t) =>
            schema.node('paragraph', null, t ? [schema.text(t)] : [])))
        const container = document.createElement('div')
        document.body.appendChild(container)
        return new CanvasEditor({ state: EditorState.create({ doc, schema }), container, ...opts })
    }

    test('posAtCoords maps viewport coords to a document position', () =>
    {
        const e = ed(['hello'])
        // mock canvas rect is all zeros, so left/top are content coords directly
        const hit = e.posAtCoords({ left: 0, top: 5 })
        expect(hit).not.toBeNull()
        expect(hit!.pos).toBe(1) // start of the paragraph's text
        expect(hit!.inside).toBe(-1) // not inside an atom
        e.destroy()
    })

    test('endOfTextblock reflects the caret position within its block', () =>
    {
        const e = ed(['abc'])
        e.dispatch(e.state.tr.setSelection(TextSelection.atStart(e.state.doc)))
        expect(e.endOfTextblock('left')).toBe(true)
        expect(e.endOfTextblock('right')).toBe(false)
        e.dispatch(e.state.tr.setSelection(TextSelection.atEnd(e.state.doc)))
        expect(e.endOfTextblock('right')).toBe(true)
        expect(e.endOfTextblock('left')).toBe(false)
        e.destroy()
    })

    test('read-only drops document edits but keeps selection', () =>
    {
        const e = ed(['hi'], { editable: false })
        expect(e.editable).toBe(false)
        e.dispatch(e.state.tr.insertText('X', 1)) // a doc change → dropped
        expect(e.state.doc.textContent).toBe('hi')
        // selection-only transactions still apply
        e.dispatch(e.state.tr.setSelection(TextSelection.atEnd(e.state.doc)))
        expect(e.state.selection.head).toBe(3)
        // re-enabling restores editing
        e.setEditable(true)
        e.dispatch(e.state.tr.insertText('X', 1))
        expect(e.state.doc.textContent).toBe('Xhi')
        e.destroy()
    })

    test('pasteHTML / pasteText insert programmatically', () =>
    {
        const e = ed([''])
        e.pasteHTML('<p>bold <strong>bit</strong></p>')
        expect(e.state.doc.textContent).toContain('bold bit')
        let hasStrong = false
        e.state.doc.descendants((n) => { if (n.isText && n.marks.some((m) => m.type.name === 'strong')) hasStrong = true })
        expect(hasStrong).toBe(true)
        const e2 = ed([''])
        e2.pasteText('one\n\ntwo')
        expect(e2.state.doc.childCount).toBe(2)
        e.destroy(); e2.destroy()
    })
})


describe('text alignment', () =>
{
    function ed(align: string | null, text = 'hello')
    {
        const doc = schema.node('doc', null, [
            schema.node('paragraph', { align }, [schema.text(text)]),
        ])
        const container = document.createElement('div')
        document.body.appendChild(container)
        return new CanvasEditor({ state: EditorState.create({ doc, schema }), container })
    }

    test('left (default) keeps lines at the left edge', () =>
    {
        const e = ed(null)
        expect((e as any).lastLayouts[0].lines[0].x).toBe(0)
        e.destroy()
    })

    test('center offsets the line by half the slack', () =>
    {
        // mock: width 460, "hello" = 5*8 = 40 → (460-40)/2 = 210
        const e = ed('center')
        expect((e as any).lastLayouts[0].lines[0].x).toBe(210)
        e.destroy()
    })

    test('right pushes the line to the right edge', () =>
    {
        const e = ed('right') // 460 - 40 = 420
        expect((e as any).lastLayouts[0].lines[0].x).toBe(420)
        e.destroy()
    })

    test('clicking aligned text maps to the right offset (caret follows the shift)', () =>
    {
        const e = ed('right')
        const line = (e as any).lastLayouts[0].lines[0]
        // click near the right-shifted line start → lands at block start, not 0
        const hit = (e as any).clickToPos((e as any).lastLayouts, line.x + 1, line.y + 5)
        expect(hit.pos).toBe(1) // start of the paragraph's text
        e.destroy()
    })
})


describe('rich paste', () =>
{
    function paste(ed: CanvasEditor, data: Record<string, string>): void
    {
        const ta = (ed as any).textarea as HTMLTextAreaElement
        const ev = new Event('paste', { bubbles: true, cancelable: true })
        ;(ev as any).clipboardData = { getData: (t: string) => data[t] ?? '' }
        ta.dispatchEvent(ev)
    }

    function hasMark(ed: CanvasEditor, name: string): boolean
    {
        let found = false
        ed.state.doc.descendants((n) =>
        {
            if (n.isText && n.marks.some((m) => m.type.name === name)) found = true
        })
        return found
    }

    test('HTML paste preserves marks (bold survives)', () =>
    {
        const { ed } = makeEditor([''])
        paste(ed, {
            'text/html': '<p>hello <strong>bold</strong> world</p>',
            'text/plain': 'hello bold world',
        })
        expect(ed.state.doc.textContent).toContain('hello bold world')
        expect(hasMark(ed, 'strong')).toBe(true)
        ed.destroy()
    })

    test('HTML paste with multiple paragraphs creates multiple blocks', () =>
    {
        const { ed } = makeEditor([''])
        paste(ed, { 'text/html': '<p>one</p><p>two</p>', 'text/plain': 'one\n\ntwo' })
        expect(ed.state.doc.childCount).toBeGreaterThanOrEqual(2)
        ed.destroy()
    })

    test('plain-text paste splits blank lines into paragraphs', () =>
    {
        const { ed } = makeEditor([''])
        paste(ed, { 'text/plain': 'first para\n\nsecond para' })
        expect(ed.state.doc.childCount).toBe(2)
        expect(ed.state.doc.child(0).textContent).toBe('first para')
        expect(ed.state.doc.child(1).textContent).toBe('second para')
        ed.destroy()
    })

    test('plain-text paste of one block stays inline', () =>
    {
        const { ed } = makeEditor(['start '])
        ed.dispatch(ed.state.tr.setSelection(TextSelection.atEnd(ed.state.doc)))
        paste(ed, { 'text/plain': 'tail' })
        expect(ed.state.doc.childCount).toBe(1)
        expect(ed.state.doc.firstChild!.textContent).toBe('start tail')
        ed.destroy()
    })
})


describe('headings (per-block style)', () =>
{
    function headingEditor()
    {
        const doc = schema.node('doc', null, [
            schema.node('heading', { level: 1 }, [schema.text('Title')]),
            schema.node('paragraph', null, [schema.text('body')]),
        ])
        const container = document.createElement('div')
        document.body.appendChild(container)
        const ed = new CanvasEditor({ state: EditorState.create({ doc, schema }), container })
        return { ed }
    }

    test('a heading block gets a bigger font + line height; paragraphs unchanged', () =>
    {
        const { ed } = headingEditor()
        const [h, p] = (ed as any).lastLayouts
        // base 16 * 2 (h1) = 32; lineHeight round(32*1.3) = 42.
        expect(h.fontSize).toBe(32)
        expect(h.lineHeight).toBe(42)
        expect(h.font).toContain('32px')
        expect(h.font).toContain('700')
        // Paragraph keeps the editor defaults.
        expect(p.fontSize).toBe(16)
        expect(p.lineHeight).toBe(26)
        ed.destroy()
    })

    test('the next block sits below the taller heading; caret height matches', () =>
    {
        const { ed } = headingEditor()
        const [h, p] = (ed as any).lastLayouts
        expect(h.height).toBe(42) // one line at the heading line-height
        expect(p.yOffset).toBe(42 + 20) // heading height + blockGap
        // Caret in the heading is heading-tall.
        expect((ed as any).posToCoords((ed as any).lastLayouts, 1).height).toBe(42)
        // Caret in the paragraph is normal.
        expect((ed as any).posToCoords((ed as any).lastLayouts, p.pmStartPos).height).toBe(26)
        ed.destroy()
    })

    test('arrow-down from a heading lands in the paragraph below', () =>
    {
        const { ed } = headingEditor()
        ed.dispatch(ed.state.tr.setSelection(TextSelection.near(ed.state.doc.resolve(1))))
        ;(ed as any).moveVertical(1, false)
        const p = (ed as any).lastLayouts[1]
        expect(ed.state.selection.head).toBeGreaterThanOrEqual(p.pmStartPos)
        ed.destroy()
    })
})


describe('node views (atom blocks)', () =>
{
    function widgetEditor()
    {
        const doc = schema.node('doc', null, [
            schema.node('paragraph', null, [schema.text('above')]),
            schema.node('widget'),
            schema.node('paragraph', null, [schema.text('below')]),
        ])
        const container = document.createElement('div')
        document.body.appendChild(container)
        const ed = new CanvasEditor({
            state: EditorState.create({ doc, schema }),
            container,
            nodeViews: {
                widget: () =>
                {
                    const el = document.createElement('div')
                    el.className = 'nv'
                    return el
                },
            },
        })
        return { ed, container }
    }

    test('an atom block reserves space and mounts a node view', () =>
    {
        const { ed, container } = widgetEditor()
        const atom = (ed as any).lastLayouts.find((b: any) => b.isAtom)
        expect(atom).toBeTruthy()
        expect(atom.height).toBe(40) // default (offsetHeight is 0 in happy-dom)
        expect(container.querySelector('.nv')).not.toBeNull()
        ed.destroy()
    })

    test('arrow-down into an atom selects the node; Backspace deletes it', async () =>
    {
        const { ed, container } = widgetEditor()
        ed.dispatch(ed.state.tr.setSelection(TextSelection.near(ed.state.doc.resolve(1))))
        ;(ed as any).moveVertical(1, false)
        expect((ed.state.selection as any).node?.type.name).toBe('widget')

        const before = ed.state.doc.childCount
        ;(ed as any).deleteBackward()
        expect(ed.state.doc.childCount).toBe(before - 1)
        await nextFrame()
        expect(container.querySelector('.nv')).toBeNull() // view destroyed
        ed.destroy()
    })

    test('clicking an atom region returns a position without crashing', () =>
    {
        const { ed } = widgetEditor()
        const atom = (ed as any).lastLayouts.find((b: any) => b.isAtom)
        const hit = (ed as any).clickToPos((ed as any).lastLayouts, 0, atom.yOffset + 5)
        expect(hit).not.toBeNull()
        expect(typeof hit.pos).toBe('number')
        ed.destroy()
    })
})


describe('super / subscript', () =>
{
    test('super/subscript runs shrink and shift off the baseline', () =>
    {
        const doc = schema.node('doc', null, [
            schema.node('paragraph', null, [
                mtext('E=mc'), mtext('2', 'superscript'),
                mtext(' H'), mtext('2', 'subscript'), mtext('O'),
            ]),
        ])
        const container = document.createElement('div')
        document.body.appendChild(container)
        const ed = new CanvasEditor({ state: EditorState.create({ doc, schema }), container })
        const frags = (ed as any).lastLayouts[0].lines[0].fragments
        const sup = frags.find((f: any) => (f.baselineShift ?? 0) < 0)
        const sub = frags.find((f: any) => (f.baselineShift ?? 0) > 0)
        expect(sup.text.startsWith('2')).toBe(true)
        expect(sub.text.startsWith('2')).toBe(true)
        expect(sup.font).toContain('12px') // round(16 * 0.72)
        ed.destroy()
    })
})


describe('text & highlight color', () =>
{
    function colorEditor()
    {
        const doc = schema.node('doc', null, [
            schema.node('paragraph', null, [
                schema.text('red', [schema.marks['textColor'].create({ color: '#ff0000' })]),
                schema.text(' '),
                schema.text('hi', [schema.marks['highlight'].create({ color: '#ffff00' })]),
                schema.text(' '),
                schema.text('def', [schema.marks['highlight'].create()]),
            ]),
        ])
        const container = document.createElement('div')
        document.body.appendChild(container)
        return new CanvasEditor({ state: EditorState.create({ doc, schema }), container })
    }

    test('textColor mark colors the run from its attribute (function resolver)', () =>
    {
        const ed = colorEditor()
        const frags = (ed as any).lastLayouts[0].lines[0].fragments
        const red = frags.find((f: any) => f.color === '#ff0000')
        expect(red).toBeTruthy()
        expect(red.text.startsWith('red')).toBe(true)
        ed.destroy()
    })

    test('highlight mark sets a background (attribute, or default)', () =>
    {
        const ed = colorEditor()
        const frags = (ed as any).lastLayouts[0].lines[0].fragments
        expect(frags.find((f: any) => f.background === '#ffff00')?.text.startsWith('hi')).toBe(true)
        expect(frags.find((f: any) => f.background === '#fde047')?.text.startsWith('def')).toBe(true)
        ed.destroy()
    })

    test('highlight paints a rect behind the run', () =>
    {
        const ed = colorEditor()
        let fill = ''
        const rects: { fill: string }[] = []
        const recCtx = {
            setTransform() {}, clearRect() {}, fillText() {},
            fillRect() { rects.push({ fill }) },
            measureText(s: string) { return { width: s.length * 8 } },
            set fillStyle(v: string) { fill = v },
            set font(_v: unknown) {}, set textBaseline(_v: unknown) {},
        }
        ;(ed as any).canvas.getContext = () => recCtx
        ;(ed as any).render()
        expect(rects.some((r) => r.fill === '#ffff00')).toBe(true)
        ed.destroy()
    })
})


describe('marks: input & extensions', () =>
{
    function editorWith(text: string, opts: { keymap?: any } = {})
    {
        const doc = schema.node('doc', null, [
            schema.node('paragraph', null, text ? [schema.text(text)] : []),
        ])
        const container = document.createElement('div')
        document.body.appendChild(container)
        return new CanvasEditor({ state: EditorState.create({ doc, schema }), container, ...opts })
    }

    test('command(toggleMark) applies a mark to the selection', () =>
    {
        const ed = editorWith('hello')
        ed.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, 1, 4)))
        const applied = ed.command(toggleMark(schema.marks.strong))
        expect(applied).toBe(true)
        // "hel" should now carry strong.
        expect(ed.state.doc.firstChild!.firstChild!.marks.some((m) => m.type.name === 'strong')).toBe(true)
        ed.destroy()
    })

    test('toggleMark on an empty selection sets storedMarks, and typing inherits them', () =>
    {
        const ed = editorWith('hello')
        ed.dispatch(ed.state.tr.setSelection(TextSelection.near(ed.state.doc.resolve(1))))
        ed.command(toggleMark(schema.marks.strong))
        expect(ed.state.storedMarks?.some((m) => m.type.name === 'strong')).toBe(true)

        const ta = (ed as any).textarea as HTMLTextAreaElement
        ta.dispatchEvent(new InputEvent('input', {
            inputType: 'insertText', data: 'X',
        } as InputEventInit))

        // The inserted "X" carries the stored strong mark; "hello" does not.
        const para = ed.state.doc.firstChild!
        expect(para.firstChild!.text).toBe('X')
        expect(para.firstChild!.marks.some((m) => m.type.name === 'strong')).toBe(true)
        ed.destroy()
    })

    test('a keydown binding toggles a mark and is preventDefaulted', () =>
    {
        // Use Ctrl- (platform-independent) so the test doesn't depend on Mod resolution.
        const ed = editorWith('hello', {
            keymap: { 'Ctrl-b': toggleMark(schema.marks.strong) },
        })
        ed.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, 1, 4)))
        const ta = (ed as any).textarea as HTMLTextAreaElement
        const ev = new KeyboardEvent('keydown', {
            key: 'b', ctrlKey: true, bubbles: true, cancelable: true,
        })
        ta.dispatchEvent(ev)
        expect(ev.defaultPrevented).toBe(true)
        expect(ed.state.doc.firstChild!.firstChild!.marks.some((m) => m.type.name === 'strong')).toBe(true)
        ed.destroy()
    })

    test('buildMarkKeymap binds present marks and skips missing ones', () =>
    {
        const full = buildMarkKeymap(schema)
        expect(Object.keys(full).sort()).toEqual(['Mod-`', 'Mod-b', 'Mod-i'])

        const partial = new Schema({ nodes, marks: { strong: markSpecs.strong } })
        const keys = buildMarkKeymap(partial)
        expect(Object.keys(keys)).toEqual(['Mod-b'])
        expect(typeof keys['Mod-b']).toBe('function')
    })
})


describe('variable-width layout (floats)', () =>
{
    // Mock: 8px/char, containerWidth 460. A float spanning a band narrows the
    // slot; layoutNextLine breaks into floor(width/8)-char chunks.
    test('slotForBand returns the widest free slot beside a float', () =>
    {
        const { ed } = makeEditor(['x'], { floats: [{ x: 0, y: 0, width: 160, height: 40 }], floatGutter: 0 })
        // Band [0,26] intersects the float → slot starts past it.
        expect((ed as any).slotForBand(0)).toEqual({ x: 160, width: 300 })
        // Band [60,86] is below the float → full width.
        expect((ed as any).slotForBand(60)).toEqual({ x: 0, width: 460 })
        ed.destroy()
    })

    test('floatGutter keeps text clear of the float on every side', () =>
    {
        const { ed } = makeEditor(['x'], { floats: [{ x: 0, y: 0, width: 160, height: 40 }], floatGutter: 12 })
        // Slot starts 12px past the float's right edge.
        expect((ed as any).slotForBand(0)).toEqual({ x: 172, width: 288 })
        // The gutter also extends the float's vertical reach: band [44,70]
        // still clears it (44 < 40+12), so the slot is still indented.
        expect((ed as any).slotForBand(44).x).toBe(172)
        // Well below the inflated float → full width.
        expect((ed as any).slotForBand(60)).toEqual({ x: 0, width: 460 })
        ed.destroy()
    })

    test('text flows beside a float, then full width below it', () =>
    {
        const text = 'a'.repeat(200)
        const { ed } = makeEditor([text], { floats: [{ x: 0, y: 0, width: 160, height: 40 }], floatGutter: 0 })
        const lines = (ed as any).lastLayouts[0].lines
        // Lines whose band hits the float (y 0 and 26) are indented + narrow.
        expect(lines[0].x).toBe(160)
        expect(lines[0].text.length).toBe(37) // floor(300/8)
        expect(lines[1].x).toBe(160)
        // First line clear of the float is full width at x 0.
        expect(lines[2].x).toBe(0)
        expect(lines[2].text.length).toBe(57) // floor(460/8)
        ed.destroy()
    })

    test('a full-width float band pushes text below it (gap in yOffsets)', () =>
    {
        const text = 'a'.repeat(120)
        // Float covers the whole width for the first ~2 bands.
        const { ed } = makeEditor([text], { floats: [{ x: 0, y: 0, width: 460, height: 40 }], floatGutter: 0 })
        const block = (ed as any).lastLayouts[0]
        // First text line starts below the float (y offset ≥ 40, not 0).
        expect(block.lines[0].y).toBeGreaterThanOrEqual(40)
        expect(block.lines[0].x).toBe(0)
        ed.destroy()
    })

    test('setFloats re-lays-out; clearing floats restores full width', async () =>
    {
        const text = 'a'.repeat(200)
        const { ed } = makeEditor([text], { floatGutter: 0 })
        // No floats → single-line mock path, full width at x 0.
        expect((ed as any).lastLayouts[0].lines[0].x).toBe(0)

        ed.setFloats([{ x: 0, y: 0, width: 160, height: 40 }])
        await nextFrame()
        expect((ed as any).lastLayouts[0].lines[0].x).toBe(160)

        ed.setFloats([])
        await nextFrame()
        expect((ed as any).lastLayouts[0].lines[0].x).toBe(0)
        ed.destroy()
    })

    test('clicking beside a float maps to the indented line', () =>
    {
        const text = 'a'.repeat(200)
        const { ed } = makeEditor([text], { floats: [{ x: 0, y: 0, width: 160, height: 40 }], floatGutter: 0 })
        // Click on line 0 (y≈13), x just inside the text (170 → 10px into the run).
        const hit = (ed as any).clickToPos((ed as any).lastLayouts, 170, 13)
        // line 0 starts at pmStart 0 (block pmStart 1); 170-160=10 → ~1 char in.
        expect(hit.pos).toBeGreaterThanOrEqual(1)
        expect(hit.pos).toBeLessThan(40)
        ed.destroy()
    })
})


describe('undo / redo (prosemirror-history)', () =>
{
    function historyEditor()
    {
        const doc = makeDoc('hello')
        const container = document.createElement('div')
        document.body.appendChild(container)
        return new CanvasEditor({
            state: EditorState.create({ doc, schema, plugins: [history()] }),
            container,
            keymap: { 'Ctrl-z': undo, 'Ctrl-y': redo },
        })
    }

    test('Ctrl-z undoes a typed change and Ctrl-y redoes it', () =>
    {
        const ed = historyEditor()
        ed.dispatch(ed.state.tr.setSelection(TextSelection.near(ed.state.doc.resolve(1))))
        const ta = (ed as any).textarea as HTMLTextAreaElement
        ta.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: 'X' } as InputEventInit))
        expect(ed.state.doc.firstChild!.textContent).toBe('Xhello')

        const press = (key: string) => ta.dispatchEvent(new KeyboardEvent('keydown', {
            key, ctrlKey: true, bubbles: true, cancelable: true,
        }))
        press('z')
        expect(ed.state.doc.firstChild!.textContent).toBe('hello')
        press('y')
        expect(ed.state.doc.firstChild!.textContent).toBe('Xhello')
        ed.destroy()
    })

    test('command(undo) is a no-op with nothing to undo', () =>
    {
        const ed = historyEditor()
        expect(ed.command(undo)).toBe(false)
        ed.destroy()
    })
})


describe('double-click & clipboard', () =>
{
    test('double-click selects the word under the cursor', () =>
    {
        const { ed } = makeEditor(['hello world'])
        const canvas = (ed as any).canvas as HTMLCanvasElement
        // Mock measureText = len*8; click at x=64 lands inside "world".
        canvas.dispatchEvent(new MouseEvent('dblclick', {
            button: 0, clientX: 64, clientY: 13, bubbles: true, cancelable: true,
        }))
        const { from, to } = ed.state.selection
        expect(ed.state.doc.textBetween(from, to)).toBe('world')
        ed.destroy()
    })

    test('wordRangeAt returns word bounds, null in an empty block', () =>
    {
        const { ed } = makeEditor(['hi there'])
        const r = (ed as any).wordRangeAt(2) // pos 2 → inside "hi"
        expect(ed.state.doc.textBetween(r.from, r.to)).toBe('hi')
        const { ed: ed2 } = makeEditor([''])
        expect((ed2 as any).wordRangeAt(1)).toBeNull()
        ed.destroy(); ed2.destroy()
    })

    test('copy writes the selection text and prevents the default', () =>
    {
        const { ed } = makeEditor(['hello world'])
        ed.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, 7, 12)))
        const ta = (ed as any).textarea as HTMLTextAreaElement
        const box: { v: string | null } = { v: null }
        const ev = new Event('copy', { cancelable: true, bubbles: true })
        ;(ev as any).clipboardData = { setData: (_t: string, d: string) => { box.v = d } }
        ta.dispatchEvent(ev)
        expect(box.v).toBe('world')
        expect(ev.defaultPrevented).toBe(true)
        ed.destroy()
    })

    test('cut copies then deletes the selection', () =>
    {
        const { ed } = makeEditor(['hello world'])
        ed.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, 1, 7)))
        const ta = (ed as any).textarea as HTMLTextAreaElement
        const box: { v: string | null } = { v: null }
        const ev = new Event('cut', { cancelable: true, bubbles: true })
        ;(ev as any).clipboardData = { setData: (_t: string, d: string) => { box.v = d } }
        ta.dispatchEvent(ev)
        expect(box.v).toBe('hello ')
        expect(ed.state.doc.firstChild!.textContent).toBe('world')
        ed.destroy()
    })

    test('copy with an empty selection is a no-op', () =>
    {
        const { ed } = makeEditor(['hello'])
        ed.dispatch(ed.state.tr.setSelection(TextSelection.near(ed.state.doc.resolve(1))))
        const ta = (ed as any).textarea as HTMLTextAreaElement
        const ev = new Event('copy', { cancelable: true, bubbles: true })
        ;(ev as any).clipboardData = { setData: () => { throw new Error('should not copy') } }
        ta.dispatchEvent(ev)
        expect(ev.defaultPrevented).toBe(false)
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
