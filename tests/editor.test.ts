import { describe, test, expect } from 'bun:test'
import { Schema, type NodeSpec, type MarkSpec } from 'prosemirror-model'
import { EditorState, TextSelection, NodeSelection } from 'prosemirror-state'
import { toggleMark } from 'prosemirror-commands'
import { history, undo, redo } from 'prosemirror-history'
import { CanvasEditor, type RenderStats } from '../src/editor'
import { GapCursor } from 'prosemirror-gapcursor'
import { markSpecs, buildMarkKeymap } from '../src/marks'
import { expandCollapsedWhitespace } from '../src/text'
import { Decoration, remoteSelection, withAlpha } from '../src/decoration'
import { visibleRange } from '../src/paint'
import { TEXT_BLEED } from '../src/constants'
import { CellSelection } from '../src/table-selection'
import {
    addRowAfter, deleteRow, addColumnAfter, deleteColumn,
    deleteTable, selectRow, goToNextCell,
} from '../src/table-commands'
import { buildGrid, cellAt, findTable } from '../src/layout/table-map'

const nodes: Record<string, NodeSpec> = {
    doc: { content: '(paragraph | widget | heading | blockquote | code_block | horizontal_rule | bullet_list | ordered_list | table)+' },
    table: {
        content: 'table_row+',
        group: 'block',
        toDOM: () => ['table', ['tbody', 0]],
        parseDOM: [{ tag: 'table' }],
    },
    table_row: {
        content: '(table_cell | table_header)+',
        toDOM: () => ['tr', 0],
        parseDOM: [{ tag: 'tr' }],
    },
    table_cell: {
        content: '(paragraph | bullet_list | ordered_list | table)+',
        attrs: { colspan: { default: 1 }, rowspan: { default: 1 }, colwidth: { default: null } },
        toDOM: () => ['td', 0],
        parseDOM: [{ tag: 'td' }],
    },
    table_header: {
        content: '(paragraph | bullet_list | ordered_list | table)+',
        attrs: { colspan: { default: 1 }, rowspan: { default: 1 }, colwidth: { default: null } },
        toDOM: () => ['th', 0],
        parseDOM: [{ tag: 'th' }],
    },
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

    // A float shares its vertical band with the text flowing beside it, so
    // hit-testing has to narrow by x as well as y — see claimsX.
    describe('hit-testing beside a float', () =>
    {
        // Float parked on the right: x 200..300, y 0..40 (defaultAtomHeight).
        // Text wraps into the slot to its left.
        function floated()
        {
            const doc = schema.node('doc', null, [
                schema.node('widget'),
                schema.node('paragraph', null, [schema.text('hello world beside the float')]),
            ])
            return mk(doc, (n: any) => n.type.name === 'widget'
                ? { x: 200, y: 0, width: 100 }
                : null)
        }

        test('a click left of the float lands in the text, not before the float', () =>
        {
            const e = floated()
            const ls = (e as any).lastLayouts as any[]
            const para = ls.find((b) => b.type === 'paragraph')
            // x=10 is squarely over paragraph text; y=5 is inside the float's band.
            const hit = (e as any).clickToPos(ls, 10, 5)
            expect(hit.pos).toBeGreaterThanOrEqual(para.pmStartPos)
            e.destroy()
        })

        test('a click on the float itself still selects the float', () =>
        {
            const e = floated()
            const ls = (e as any).lastLayouts as any[]
            const w = ls.find((b) => b.type === 'widget')
            const hit = (e as any).clickToPos(ls, 250, 5)
            expect(hit.pos).toBe(w.pmStartPos)
            e.destroy()
        })

        test('posAtCoords reports `inside` only when the point is over the float', () =>
        {
            const e = floated()
            const w = ((e as any).lastLayouts as any[]).find((b) => b.type === 'widget')
            expect(e.posAtCoords({ left: 250, top: 5 })?.inside).toBe(w.pmStartPos)
            expect(e.posAtCoords({ left: 10, top: 5 })?.inside).toBe(-1)
            e.destroy()
        })

        test('an in-flow atom still claims its whole band', () =>
        {
            const doc = schema.node('doc', null, [
                schema.node('widget'),
                schema.node('paragraph', null, [schema.text('below')]),
            ])
            const e = mk(doc, () => null)
            const ls = (e as any).lastLayouts as any[]
            const w = ls.find((b) => b.type === 'widget')
            // No floatRect → full-width, so any x in the band hits it.
            expect((e as any).clickToPos(ls, 5, 5).pos).toBe(w.pmStartPos)
            expect((e as any).clickToPos(ls, 400, 5).pos).toBe(w.pmStartPos)
            e.destroy()
        })
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


/**
 * A 2D context that records the drawing calls, not just the rects: a colour
 * decoration's whole observable effect is *which* string was filled at which x
 * in which colour, so `fillText` has to be captured to test it at all.
 */
interface PaintedText { fill: string, font: string, text: string, x: number, y: number }
interface PaintedRect { fill: string, x: number, y: number, w: number, h: number }

function recordPaint(e: CanvasEditor): { text: PaintedText[], rects: PaintedRect[] }
{
    const text: PaintedText[] = []
    const rects: PaintedRect[] = []
    let fill = ''
    let font = ''
    const ctx: any = {
        setTransform() {}, clearRect() {}, save() {}, restore() {},
        beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
        measureText: (s: string) => ({ width: s.length * 8 }),
        fillText: (t: string, x: number, y: number) => text.push({ fill, font, text: t, x, y }),
        fillRect: (x: number, y: number, w: number, h: number) => rects.push({ fill, x, y, w, h }),
        set fillStyle(v: string) { fill = v }, get fillStyle() { return fill },
        set font(v: string) { font = v }, get font() { return font },
        set textBaseline(_v: string) {}, set strokeStyle(_v: string) {}, set lineWidth(_v: number) {},
    }
    ;(e as any).canvas.getContext = () => ctx
    ;(e as any).render()
    return { text, rects }
}

function paragraphEditor(inline: any[], opts: any = {}): CanvasEditor
{
    const doc = schema.node('doc', null, [schema.node('paragraph', null, inline)])
    const container = document.createElement('div')
    document.body.appendChild(container)
    return new CanvasEditor({ state: EditorState.create({ doc, schema }), container, ...opts })
}


describe('inline color decorations (run splitting)', () =>
{
    const RED = '#ff0000'

    test('splits a plain line at the decorated range', () =>
    {
        // "hel" is doc [1,4) — block offsets 0..3, so x 0..24 in the mock.
        const e = paragraphEditor(
            [schema.text('hello')],
            { decorations: () => [Decoration.inline(1, 4, { color: RED })] },
        )
        const { text } = recordPaint(e)
        expect(text.map((t) => t.text)).toEqual(['hel', 'lo'])
        expect(text[0]).toMatchObject({ text: 'hel', x: 0, fill: RED })
        expect(text[1].x).toBe(24)
        expect(text[1].fill).not.toBe(RED)
        e.destroy()
    })

    test('a range covering a whole run recolors it without splitting', () =>
    {
        const e = paragraphEditor(
            [schema.text('hello')],
            { decorations: () => [Decoration.inline(1, 6, { color: RED })] },
        )
        const { text } = recordPaint(e)
        expect(text).toHaveLength(1)
        expect(text[0]).toMatchObject({ text: 'hello', x: 0, fill: RED })
        e.destroy()
    })

    test('an undecorated line is still one fillText', () =>
    {
        const e = paragraphEditor([schema.text('hello')], { decorations: () => [] })
        const { text } = recordPaint(e)
        expect(text).toHaveLength(1)
        expect(text[0].text).toBe('hello')
        e.destroy()
    })

    test('overrides a mark color mid-run, keeping the mark font', () =>
    {
        const green = schema.marks['textColor'].create({ color: '#00ff00' })
        const e = paragraphEditor(
            [schema.text('abcdef', [green])],
            { decorations: () => [Decoration.inline(3, 5, { color: RED })] },
        )
        const { text } = recordPaint(e)
        expect(text.map((t) => [t.text, t.fill])).toEqual([
            ['ab', '#00ff00'],
            ['cd', RED],
            ['ef', '#00ff00'],
        ])
        // The cut is a colour change only — every piece keeps the run's font.
        expect(new Set(text.map((t) => t.font)).size).toBe(1)
        expect(text.map((t) => t.x)).toEqual([0, 16, 32])
        e.destroy()
    })

    test('later decorations win where two overlap', () =>
    {
        const e = paragraphEditor([schema.text('hello')], {
            decorations: () => [
                Decoration.inline(1, 4, { color: RED }),
                Decoration.inline(2, 4, { color: '#0000ff' }),
            ],
        })
        const { text } = recordPaint(e)
        expect(text.map((t) => [t.text, t.fill])).toEqual([
            ['h', RED],
            ['el', '#0000ff'],
            ['lo', text[2].fill],
        ])
        expect(text[2].fill).not.toBe(RED)
        e.destroy()
    })

    test('recolored text lands on the same span as a background over the range', () =>
    {
        const e = paragraphEditor([schema.text('hello')], {
            decorations: () => [
                Decoration.inline(1, 4, { color: RED, background: '#ffee00' }),
            ],
        })
        const { text, rects } = recordPaint(e)
        const band = rects.find((r) => r.fill === '#ffee00')!
        const piece = text.find((t) => t.fill === RED)!
        expect(band.x).toBe(piece.x)
        expect(band.w).toBe(24)
        e.destroy()
    })

    test('clips to line boundaries across a hard break', () =>
    {
        // 'ab\ncd' lays out as two lines; doc [2,6) spans the newline.
        const e = paragraphEditor(
            [schema.text('ab\ncd')],
            { decorations: () => [Decoration.inline(2, 6, { color: RED })] },
        )
        const { text } = recordPaint(e)
        expect(text.map((t) => [t.text, t.fill, t.x])).toEqual([
            ['a', text[0].fill, 0],
            ['b', RED, 8],
            ['cd', RED, 0],
        ])
        expect(text[0].fill).not.toBe(RED)
        // Two lines, so the second pair sits a lineHeight lower.
        expect(text[2].y - text[0].y).toBe(26)
        e.destroy()
    })

    test('leaves atom blocks alone', () =>
    {
        const doc = schema.node('doc', null, [
            schema.node('widget'),
            schema.node('paragraph', null, [schema.text('hi')]),
        ])
        const container = document.createElement('div')
        document.body.appendChild(container)
        const e = new CanvasEditor({
            state: EditorState.create({ doc, schema }),
            container,
            nodeViews: { widget: () => document.createElement('div') },
            decorations: () => [Decoration.inline(0, 3, { color: RED })],
        })
        expect(() => recordPaint(e)).not.toThrow()
        e.destroy()
    })
})


describe('collaborative cursors (remote carets)', () =>
{
    const BLUE = '#3b82f6'

    test('paints a caret bar at the position', () =>
    {
        // pos 3 → block offset 2 → x 16; the caret is the local caret's width.
        const e = paragraphEditor(
            [schema.text('hello')],
            { decorations: () => [Decoration.cursor(3, BLUE)] },
        )
        const { rects } = recordPaint(e)
        expect(rects.some((r) => r.fill === BLUE && r.x === 16 && r.w === 2 && r.h === 26))
            .toBe(true)
        e.destroy()
    })

    test('a labelled caret draws a name flag', () =>
    {
        const e = paragraphEditor(
            [schema.text('hello')],
            { decorations: () => [Decoration.cursor(3, BLUE, { label: 'Ada' })] },
        )
        const { text, rects } = recordPaint(e)
        // 'Ada' = 24px in the mock, + 5px padding either side.
        const flag = rects.find((r) => r.fill === BLUE && r.w === 34 && r.h === 15)!
        expect(flag).toBeDefined()
        const name = text.find((t) => t.text === 'Ada')!
        expect(name.fill).toBe('#ffffff')
        expect(name.x).toBe(flag.x + 5)
        e.destroy()
    })

    test('the flag drops below a caret on the first line rather than clipping', () =>
    {
        const e = paragraphEditor(
            [schema.text('hello')],
            { decorations: () => [Decoration.cursor(3, BLUE, { label: 'Ada' })] },
        )
        const { rects } = recordPaint(e)
        const flag = rects.find((r) => r.fill === BLUE && r.h === 15)!
        expect(flag.y).toBe(26)
        e.destroy()
    })

    test('the flag is pulled back inside the content column', () =>
    {
        const long = 'x'.repeat(56) // 448px — a flag at the end would overhang 460.
        const e = paragraphEditor(
            [schema.text(long)],
            { decorations: () => [Decoration.cursor(57, BLUE, { label: 'Ada' })] },
        )
        const { rects } = recordPaint(e)
        const flag = rects.find((r) => r.fill === BLUE && r.h === 15)!
        expect(flag.x + flag.w).toBeLessThanOrEqual(460)
        e.destroy()
    })

    test('remoteSelection bands the range and puts the caret at the head', () =>
    {
        const e = paragraphEditor([schema.text('hello')], {
            decorations: () => remoteSelection({
                from: 1, to: 4, color: BLUE, name: 'Ada',
            }),
        })
        const { rects } = recordPaint(e)
        expect(rects.some((r) => r.fill === 'rgba(59, 130, 246, 0.25)' && r.w === 24))
            .toBe(true)
        // Caret at `to` (offset 3 → x 24) by default.
        expect(rects.some((r) => r.fill === BLUE && r.x === 24 && r.w === 2)).toBe(true)
        e.destroy()
    })

    test('a backwards selection puts the caret at the anchor end', () =>
    {
        const e = paragraphEditor([schema.text('hello')], {
            decorations: () => remoteSelection({ from: 1, to: 4, head: 1, color: BLUE }),
        })
        const { rects } = recordPaint(e)
        expect(rects.some((r) => r.fill === BLUE && r.x === 0 && r.w === 2)).toBe(true)
        e.destroy()
    })

    test('a collapsed remote selection is a caret with no band', () =>
    {
        const e = paragraphEditor([schema.text('hello')], {
            decorations: () => remoteSelection({ from: 3, to: 3, color: BLUE }),
        })
        const decos = remoteSelection({ from: 3, to: 3, color: BLUE })
        expect(decos).toHaveLength(1)
        expect(decos[0].kind).toBe('cursor')
        const { rects } = recordPaint(e)
        expect(rects.some((r) => r.fill === BLUE && r.x === 16 && r.w === 2)).toBe(true)
        e.destroy()
    })

    test('several participants paint independently', () =>
    {
        const e = paragraphEditor([schema.text('hello')], {
            decorations: () => [
                ...remoteSelection({ from: 1, to: 2, color: BLUE, name: 'Ada' }),
                ...remoteSelection({ from: 4, to: 5, color: '#ef4444', name: 'Lin' }),
            ],
        })
        const { text } = recordPaint(e)
        expect(text.some((t) => t.text === 'Ada')).toBe(true)
        expect(text.some((t) => t.text === 'Lin')).toBe(true)
        e.destroy()
    })

    test('withAlpha derives a band color from hex, and passes anything else through', () =>
    {
        expect(withAlpha('#f00', 0.25)).toBe('rgba(255, 0, 0, 0.25)')
        expect(withAlpha('#ff8800', 0.5)).toBe('rgba(255, 136, 0, 0.5)')
        expect(withAlpha('rebeccapurple', 0.25)).toBe('rebeccapurple')
        expect(withAlpha('rgb(1, 2, 3)', 0.25)).toBe('rgb(1, 2, 3)')
    })
})


describe('setWidth (re-laying into a new content column)', () =>
{
    function ed(text: string, opts: any = {}): CanvasEditor
    {
        const doc = schema.node('doc', null, [
            schema.node('paragraph', null, [schema.text(text)]),
        ])
        const container = document.createElement('div')
        document.body.appendChild(container)
        return new CanvasEditor({
            state: EditorState.create({ doc, schema }), container,
            autofocus: false, ...opts,
        })
    }

    test('re-lays the document at the new width', () =>
    {
        // A centred line sits at (column - text) / 2, so its x is a direct
        // readout of the width layout actually used. 'hello' is 40px in the mock.
        const doc = schema.node('doc', null, [
            schema.node('paragraph', { align: 'center' }, [schema.text('hello')]),
        ])
        const container = document.createElement('div')
        document.body.appendChild(container)
        const e = new CanvasEditor({
            state: EditorState.create({ doc, schema }), container,
            autofocus: false, width: 400,
        })
        ;(e as any).ensureLayout()
        expect((e as any).lastLayouts[0].lines[0].x).toBe(180)

        e.setWidth(240)
        ;(e as any).ensureLayout()
        expect((e as any).lastLayouts[0].lines[0].x).toBe(100)
        e.destroy()
    })

    test('the per-block cache is re-keyed to the new width', () =>
    {
        const e = ed('hello', { width: 400 })
        ;(e as any).ensureLayout()
        const node = e.state.doc.firstChild!
        expect((e as any).layoutCache.get(node).width).toBe(400)
        e.setWidth(240)
        ;(e as any).ensureLayout()
        expect((e as any).layoutCache.get(node).width).toBe(240)
        e.destroy()
    })

    test('reports the new width, and coordinates follow it', () =>
    {
        const e = ed('hello', { width: 400 })
        expect(e.width).toBe(400)
        e.setWidth(220)
        expect(e.width).toBe(220)
        // Painting is sized off the new column, not the old one.
        const { rects } = recordPaint(e)
        expect((e as any).canvas.style.width).toBe(`${220 + TEXT_BLEED}px`)
        expect(rects.every((r) => r.w <= 220 + TEXT_BLEED)).toBe(true)
        e.destroy()
    })

    test('drops the positional cache, so blocks are not reused at stale x', () =>
    {
        const e = ed('hello', { width: 400 })
        ;(e as any).ensureLayout()
        const cacheBefore = (e as any).positionedCache
        e.setWidth(300)
        expect((e as any).positionedCache).not.toBe(cacheBefore)
        e.destroy()
    })

    test('a scroller is re-sized along with the canvas', () =>
    {
        const e = ed('hello', { width: 400, maxHeight: 100 })
        expect((e as any).scroller.style.width).toBe(`${400 + TEXT_BLEED}px`)
        e.setWidth(250)
        expect((e as any).scroller.style.width).toBe(`${250 + TEXT_BLEED}px`)
        e.destroy()
    })

    test('setting the same width is a no-op', () =>
    {
        const e = ed('hello', { width: 400 })
        ;(e as any).ensureLayout()
        const cache = (e as any).positionedCache
        e.setWidth(400)
        expect((e as any).positionedCache).toBe(cache)
        e.destroy()
    })

    test('the caret still maps correctly after a resize', () =>
    {
        const e = ed('hello world', { width: 400 })
        e.setWidth(240)
        ;(e as any).ensureLayout()
        // Offset 3 is 24px in, whatever the column width, while it stays on
        // line one — the resize must not leave a stale coordinate cache behind.
        expect(e.coordsAtPos(4)!.x).toBe(24)
        expect(e.posAtCoords({ left: 24, top: 5 })!.pos).toBe(4)
        e.destroy()
    })
})


describe('display scale (editing under a CSS transform)', () =>
{
    // The canvas's own layout size. A client rect of 2x this means 2x zoom.
    const W = 466
    const H = 200

    /** Pretend an ancestor transform has moved and scaled the canvas. */
    function place(e: CanvasEditor, left: number, top: number, scale: number): void
    {
        const canvas = (e as any).canvas as HTMLCanvasElement
        Object.defineProperty(canvas, 'offsetWidth', { value: W, configurable: true })
        Object.defineProperty(canvas, 'offsetHeight', { value: H, configurable: true })
        canvas.getBoundingClientRect = (() => ({
            left, top, x: left, y: top,
            width: W * scale, height: H * scale,
            right: left + W * scale, bottom: top + H * scale,
            toJSON: () => ({}),
        })) as any
        e.invalidateGeometry()
    }

    function ed(text: string): CanvasEditor
    {
        const doc = schema.node('doc', null, [
            schema.node('paragraph', null, [schema.text(text)]),
        ])
        const container = document.createElement('div')
        document.body.appendChild(container)
        return new CanvasEditor({
            state: EditorState.create({ doc, schema }), container, autofocus: false,
        })
    }

    test('a click lands on the same character at 1x and at 2x', () =>
    {
        const e = ed('hello')
        // Column 3 sits at layout x 24 (the mock measures 8px per character).
        place(e, 0, 0, 1)
        expect(e.posAtCoords({ left: 24, top: 5 })!.pos).toBe(4)
        place(e, 0, 0, 2)
        expect(e.posAtCoords({ left: 48, top: 10 })!.pos).toBe(4)
        e.destroy()
    })

    test('the origin is subtracted before the scale is divided out', () =>
    {
        const e = ed('hello')
        place(e, 100, 40, 2)
        expect(e.posAtCoords({ left: 100 + 48, top: 40 + 10 })!.pos).toBe(4)
        e.destroy()
    })

    test('coordsAtPos reports viewport pixels, so it scales too', () =>
    {
        const e = ed('hello')
        place(e, 100, 40, 2)
        expect(e.coordsAtPos(4)).toEqual({ x: 148, y: 40, height: 52 })
        e.destroy()
    })

    test('coordsAtPos and posAtCoords stay inverses under zoom', () =>
    {
        const e = ed('hello world')
        place(e, 37, 11, 2)
        for (const pos of [1, 3, 6, 9])
        {
            const c = e.coordsAtPos(pos)!
            expect(e.posAtCoords({ left: c.x, top: c.y })!.pos).toBe(pos)
        }
        e.destroy()
    })

    test('a transform the editor cannot see needs invalidateGeometry', () =>
    {
        const e = ed('hello')
        place(e, 0, 0, 1)
        expect(e.coordsAtPos(4)!.x).toBe(24)

        // Zoom the host without saying so. A CSS transform fires no event, so
        // the cached geometry is now a lie — which is the whole reason the
        // invalidation hook is public.
        const canvas = (e as any).canvas as HTMLCanvasElement
        canvas.getBoundingClientRect = (() => ({
            left: 0, top: 0, x: 0, y: 0, width: W * 2, height: H * 2,
            right: W * 2, bottom: H * 2, toJSON: () => ({}),
        })) as any
        expect(e.coordsAtPos(4)!.x).toBe(24)

        e.invalidateGeometry()
        expect(e.coordsAtPos(4)!.x).toBe(48)
        e.destroy()
    })

    test('pointer mapping re-measures every time, so a press is never stale', () =>
    {
        const e = ed('hello')
        place(e, 0, 0, 1)
        const canvas = (e as any).canvas as HTMLCanvasElement
        Object.defineProperty(canvas, 'offsetWidth', { value: W, configurable: true })
        canvas.getBoundingClientRect = (() => ({
            left: 0, top: 0, x: 0, y: 0, width: W * 2, height: H * 2,
            right: W * 2, bottom: H * 2, toJSON: () => ({}),
        })) as any
        // No invalidateGeometry() — input reads fresh regardless.
        expect(e.posAtCoords({ left: 48, top: 10 })!.pos).toBe(4)
        e.destroy()
    })

    test('a zero-sized canvas maps as identity rather than NaN', () =>
    {
        const e = ed('hello')
        const canvas = (e as any).canvas as HTMLCanvasElement
        Object.defineProperty(canvas, 'offsetWidth', { value: 0, configurable: true })
        Object.defineProperty(canvas, 'offsetHeight', { value: 0, configurable: true })
        e.invalidateGeometry()
        const c = e.coordsAtPos(4)!
        expect(Number.isFinite(c.x)).toBe(true)
        expect(Number.isFinite(c.y)).toBe(true)
        expect(Number.isFinite(c.height)).toBe(true)
        e.destroy()
    })
})


describe('canvas bleed (a hair of overrun is drawn, not clipped)', () =>
{
    test('the canvas is wider than the content column', () =>
    {
        const e = paragraphEditor([schema.text('hello')], { autofocus: false })
        recordPaint(e)
        expect((e as any).canvas.style.width).toBe(`${460 + TEXT_BLEED}px`)
        e.destroy()
    })

    test('but painting still stops at the content width', () =>
    {
        const e = paragraphEditor([schema.text('hello')], {
            autofocus: false,
            decorations: () => [Decoration.node(0, { background: '#0000ff' })],
        })
        const { rects } = recordPaint(e)
        expect(rects.some((r) => r.fill === '#0000ff' && r.w === 460)).toBe(true)
        expect(rects.some((r) => r.w === 460 + TEXT_BLEED)).toBe(false)
        e.destroy()
    })

    test('a scroller reserves the bleed alongside the scrollbar gutter', () =>
    {
        const e = paragraphEditor([schema.text('hello')], {
            autofocus: false, maxHeight: 100,
        })
        // Overlay scrollbars measure 0 in the test DOM, so this is column+bleed.
        expect((e as any).scroller.style.width).toBe(`${460 + TEXT_BLEED}px`)
        e.destroy()
    })
})


describe('caret follows focus', () =>
{
    // The default caretColor, at the default caretWidth.
    const CARET = '#a5b4fc'
    const isCaret = (r: { fill: string, w: number }) => r.fill === CARET && r.w === 2

    test('an unfocused editor paints no caret', () =>
    {
        const e = paragraphEditor([schema.text('hello')], { autofocus: false })
        expect(recordPaint(e).rects.some(isCaret)).toBe(false)
        e.destroy()
    })

    test('a focused editor paints one', () =>
    {
        const e = paragraphEditor([schema.text('hello')], { autofocus: false })
        e.focus()
        expect(recordPaint(e).rects.some(isCaret)).toBe(true)
        e.destroy()
    })

    test('two editors on one surface show at most one caret', () =>
    {
        // `autofocus` defaults on, so several editors mounted together would
        // otherwise fight over focus — the reason it must be opted out of when
        // more than one shares a page.
        const a = paragraphEditor([schema.text('hello')], { autofocus: false })
        const b = paragraphEditor([schema.text('world')], { autofocus: false })
        b.focus()
        expect(recordPaint(a).rects.some(isCaret)).toBe(false)
        expect(recordPaint(b).rects.some(isCaret)).toBe(true)
        a.destroy()
        b.destroy()
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

describe('incremental layout correctness', () =>
{
    // The incremental layout path (single-block edits) must produce byte-for-byte
    // the same positions as a full from-scratch layout. We compare coordsAtPos at
    // every document position against a fresh editor built from the same doc.
    function coordsAll(ed: CanvasEditor): string[]
    {
        const size = (ed as any).state.doc.content.size as number
        const out: string[] = []
        for (let p = 0; p <= size; p++)
        {
            const c = (ed as any).coordsAtPos(p)
            out.push(c ? `${c.x.toFixed(2)},${c.y.toFixed(2)},${c.height.toFixed(2)}` : 'null')
        }
        return out
    }

    function freshFrom(ed: CanvasEditor): CanvasEditor
    {
        const container = document.createElement('div')
        document.body.appendChild(container)
        return new CanvasEditor({
            state: EditorState.create({ doc: (ed as any).state.doc, schema }),
            container,
        })
    }

    test('single-block inserts match a from-scratch layout', () =>
    {
        const { ed } = makeEditor(['hello world', 'second paragraph here', 'third'])
        const inserts: Array<[number, string]> = [
            [3, 'X'], [1, 'Y'], [25, 'ZZ'], [40, 'q'], [2, 'a'],
        ]
        for (const [pos, text] of inserts)
        {
            ;(ed as any).dispatch((ed as any).state.tr.insertText(text, pos))
            ;(ed as any).coordsAtPos(0) // force the incremental ensureLayout
        }
        expect(coordsAll(ed)).toEqual(coordsAll(freshFrom(ed)))
        ed.destroy()
    })

    test('a height-changing insert (line wrap) shifts blocks below correctly', () =>
    {
        const { ed } = makeEditor(['short', 'below one', 'below two'])
        // Insert enough to wrap the first paragraph onto multiple lines, changing
        // its height — blocks below must shift down.
        ;(ed as any).dispatch((ed as any).state.tr.insertText('x'.repeat(120), 3))
        ;(ed as any).coordsAtPos(0)
        expect(coordsAll(ed)).toEqual(coordsAll(freshFrom(ed)))
        ed.destroy()
    })

    test('structural edits (split/join) fall back to a correct full layout', () =>
    {
        const { ed } = makeEditor(['alpha beta', 'gamma'])
        // Split the first paragraph (block count changes → incremental bails).
        const splitPos = 4
        ;(ed as any).dispatch((ed as any).state.tr.split(splitPos))
        ;(ed as any).coordsAtPos(0)
        expect(coordsAll(ed)).toEqual(coordsAll(freshFrom(ed)))
        // Join back.
        ;(ed as any).dispatch((ed as any).state.tr.join((ed as any).state.doc.firstChild!.nodeSize))
        ;(ed as any).coordsAtPos(0)
        expect(coordsAll(ed)).toEqual(coordsAll(freshFrom(ed)))
        ed.destroy()
    })

    test('fuzz: 60 random single-char inserts stay consistent', () =>
    {
        const { ed } = makeEditor(['one two three', 'four five six'])
        let seed = 12345
        const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
        for (let i = 0; i < 60; i++)
        {
            const size = (ed as any).state.doc.content.size as number
            const pos = 1 + Math.floor(rand() * Math.max(1, size - 2))
            try { (ed as any).dispatch((ed as any).state.tr.insertText('z', pos)) }
            catch { continue } // skip invalid (non-text) positions
            ;(ed as any).coordsAtPos(0)
        }
        expect(coordsAll(ed)).toEqual(coordsAll(freshFrom(ed)))
        ed.destroy()
    })
})

describe('touch input (mobile)', () =>
{
    // The full touch-event path (tap / long-press / handle drag) is verified in a
    // real mobile browser; these lock in the core logic the handlers call.
    test('the canvas opts into native vertical scroll via touch-action', () =>
    {
        const { ed } = makeEditor(['hello world'])
        expect((ed as any).canvas.style.touchAction).toBe('pan-y')
        ed.destroy()
    })

    test('selectWordAt selects the word under a point (long-press)', () =>
    {
        const { ed } = makeEditor(['hello world'])
        // mock metrics: 8px/char, lineHeight 26 → x≈16 lands inside "hello", y in line 1
        ;(ed as any).selectWordAt(18, 13)
        const sel = ed.state.selection
        expect(sel.empty).toBe(false)
        expect(ed.state.doc.textBetween(sel.from, sel.to)).toBe('hello')
        ed.destroy()
    })

    test('dragSelectionEnd moves one end and anchors the other', () =>
    {
        const { ed } = makeEditor(['hello world'])
        ;(ed as any).selectWordAt(18, 13) // select "hello" (1..6)
        ;(ed as any).dragSelectionEnd('to', 9) // drag the end into "world"
        const sel = ed.state.selection
        expect(sel.from).toBe(1) // anchored at start of "hello"
        expect(sel.to).toBe(9)
        expect(ed.state.doc.textBetween(sel.from, sel.to)).toBe('hello wo')
        ed.destroy()
    })

    test('selection handles appear for a touch selection and hide when collapsed', async () =>
    {
        const { ed } = makeEditor(['hello world'])
        ;(ed as any).touchSelection = true
        ;(ed as any).selectWordAt(18, 13)
        await nextFrame()
        const h = (ed as any).selHandles as { from: HTMLElement, to: HTMLElement } | null
        expect(h).not.toBeNull()
        expect(h!.from.style.display).toBe('block')
        expect(h!.to.style.display).toBe('block')
        // Collapse the selection → handles hide.
        ;(ed as any).setHead(3, false)
        ;(ed as any).flush()
        expect(h!.from.style.display).toBe('none')
        ed.destroy()
    })

    // ── Multi-tap ────────────────────────────────────────────────────

    /** Register a tap at (x, y) as the touch handler would. */
    function tapAt(ed: CanvasEditor, x: number, y: number): boolean
    {
        ;(ed as any).touchStartX = x
        ;(ed as any).touchStartY = y
        return (ed as any).registerTap()
    }

    test('a lone tap is a first tap; a quick one beside it is a follow-up', () =>
    {
        const { ed } = makeEditor(['hello world'])
        expect(tapAt(ed, 18, 13)).toBe(false)
        expect((ed as any).tapCount).toBe(1)
        // A finger never lands twice in the same pixel, so near counts as same.
        expect(tapAt(ed, 22, 16)).toBe(true)
        expect((ed as any).tapCount).toBe(2)
        expect(tapAt(ed, 20, 14)).toBe(true)
        expect((ed as any).tapCount).toBe(3)
        ed.destroy()
    })

    test('a tap far away starts a new run', () =>
    {
        const { ed } = makeEditor(['hello world'])
        tapAt(ed, 18, 13)
        expect(tapAt(ed, 200, 13)).toBe(false)
        expect((ed as any).tapCount).toBe(1)
        ed.destroy()
    })

    test('a slow second tap starts a new run', () =>
    {
        const { ed } = makeEditor(['hello world'])
        tapAt(ed, 18, 13)
        ;(ed as any).lastTapTime = Date.now() - 5000
        expect(tapAt(ed, 18, 13)).toBe(false)
        ed.destroy()
    })

    test('double tap selects the word, triple selects the block', () =>
    {
        const { ed } = makeEditor(['hello world'])
        ;(ed as any).tapCount = 2
        expect((ed as any).selectForTapCount(3)).toBe(true)
        let sel = ed.state.selection
        expect(ed.state.doc.textBetween(sel.from, sel.to)).toBe('hello')

        ;(ed as any).tapCount = 3
        expect((ed as any).selectForTapCount(3)).toBe(true)
        sel = ed.state.selection
        expect(ed.state.doc.textBetween(sel.from, sel.to)).toBe('hello world')
        ed.destroy()
    })

    test('a multi-tap on an empty block selects nothing', () =>
    {
        const { ed } = makeEditor([''])
        ;(ed as any).tapCount = 3
        expect((ed as any).selectForTapCount(1)).toBe(false)
        ed.destroy()
    })

    // ── Magnifier loupe ──────────────────────────────────────────────

    test('the loupe shows over the touch, lifted clear of the fingertip', () =>
    {
        const { ed } = makeEditor(['hello world'])
        ;(ed as any).showLoupe({ x: 200, y: 100 })
        const el = (ed as any).loupe.el as HTMLElement
        expect(el.style.display).toBe('')
        expect(el.style.left).toBe('200px')
        expect(el.style.top).toBe('24px') // 100 - LOUPE_LIFT
        expect(el.style.pointerEvents).toBe('none')
        ed.destroy()
    })

    test('near the top it drops below the touch rather than off the edge', () =>
    {
        const { ed } = makeEditor(['hello world'])
        // A touch on the first line has no room for a loupe above it.
        ;(ed as any).showLoupe({ x: 200, y: 10 })
        const el = (ed as any).loupe.el as HTMLElement
        expect(el.style.top).toBe('40px') // 10 + LOUPE_DROP
        expect(parseFloat(el.style.top)).toBeGreaterThan(0)
        ed.destroy()
    })

    test('the loupe is kept inside the content column at the edges', () =>
    {
        const { ed } = makeEditor(['hello world'])
        ;(ed as any).showLoupe({ x: 4, y: 100 })
        expect(((ed as any).loupe.el as HTMLElement).style.left).toBe('56px')
        ;(ed as any).showLoupe({ x: 900, y: 100 })
        expect(((ed as any).loupe.el as HTMLElement).style.left).toBe('404px')
        ed.destroy()
    })

    test('the loupe hides again, and is built only once', () =>
    {
        const { ed } = makeEditor(['hello world'])
        ;(ed as any).showLoupe({ x: 100, y: 100 })
        const first = (ed as any).loupe.el
        ;(ed as any).showLoupe({ x: 120, y: 100 })
        expect((ed as any).loupe.el).toBe(first)
        ;(ed as any).showLoupe(null)
        expect((first as HTMLElement).style.display).toBe('none')
        ed.destroy()
    })
})


describe('drag & drop', () =>
{
    // doc: paragraph 'above' (0..7), widget atom (7..8), paragraph 'below' (8..15).
    // Mock metrics (8px/char, lineHeight 26, blockGap 20, atom height 40) put the
    // blocks at y 0..26, 46..86, and 106..132 — midpoints 13, 66, 119.
    function dndEditor(opts: Record<string, unknown> = {})
    {
        const doc = schema.node('doc', null, [
            schema.node('paragraph', null, [schema.text('above')]),
            schema.node('widget'),
            schema.node('paragraph', null, [schema.text('below')]),
        ])
        const container = document.createElement('div')
        document.body.appendChild(container)
        const ed = new CanvasEditor({
            state: EditorState.create({ doc, schema, plugins: [history()] }),
            container,
            nodeViews: { widget: () => { const el = document.createElement('div'); el.className = 'nv'; return el } },
            ...opts,
        })
        // happy-dom has no layout; pin the canvas at the origin so client
        // coordinates are document coordinates.
        ;(ed as any).canvas.getBoundingClientRect = () => ({ left: 0, top: 0 })
        return { ed, container }
    }

    const pointer = (type: string, init: PointerEventInit) =>
        new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, ...init })

    /** A DragEvent stand-in: happy-dom aliases DragEvent to Event. */
    function dragEvent(type: string, x: number, y: number, data: Record<string, string> = {}, files: unknown[] = []): Event
    {
        const e = new Event(type, { bubbles: true, cancelable: true })
        Object.assign(e, {
            clientX: x, clientY: y,
            dataTransfer: { getData: (t: string) => data[t] ?? '', files, dropEffect: 'none' },
        })
        return e
    }

    // ── Moving a node ────────────────────────────────────────────────

    test('moveNode reorders a block and selects it where it landed', () =>
    {
        const { ed } = dndEditor()
        expect(ed.moveNode(7, 0)).toBe(true) // widget → before the first paragraph
        expect(ed.state.doc.child(0).type.name).toBe('widget')
        expect(ed.state.doc.childCount).toBe(3)
        expect((ed.state.selection as NodeSelection).node.type.name).toBe('widget')
        ed.destroy()
    })

    test('a move is a single undo step', () =>
    {
        const { ed } = dndEditor()
        ed.moveNode(7, 0)
        expect(ed.state.doc.child(0).type.name).toBe('widget')
        ed.command(undo)
        expect(ed.state.doc.child(0).type.name).toBe('paragraph')
        expect(ed.state.doc.child(1).type.name).toBe('widget')
        ed.command(redo)
        expect(ed.state.doc.child(0).type.name).toBe('widget')
        ed.destroy()
    })

    test('moveNode works for text blocks too (drag-handle case)', () =>
    {
        const { ed } = dndEditor()
        expect(ed.moveNode(8, 0)).toBe(true) // 'below' → the top
        expect(ed.state.doc.child(0).textContent).toBe('below')
        ed.destroy()
    })

    test('moveNode refuses a drop inside the node or onto its own slot', () =>
    {
        const { ed } = dndEditor()
        expect(ed.moveNode(0, 3)).toBe(false) // inside the paragraph being moved
        expect(ed.moveNode(7, 7)).toBe(false) // the slot it already occupies
        expect(ed.moveNode(7, 8)).toBe(false) // …from the other side
        expect(ed.state.doc.child(1).type.name).toBe('widget') // untouched
        ed.destroy()
    })

    test('moveNode refuses a target no ancestor can hold the node in', () =>
    {
        const doc = schema.node('doc', null, [
            schema.node('paragraph', null, [schema.text('hi')]),
            schema.node('code_block', null, [schema.text('xy')]),
        ])
        const container = document.createElement('div')
        document.body.appendChild(container)
        const ed = new CanvasEditor({ state: EditorState.create({ doc, schema }), container })
        // Position 6 is *between* the code block's two characters: it takes only
        // text, and there's no block edge to climb out to.
        expect(ed.moveNode(0, 6)).toBe(false)
        // The block edge right before it does work — that climbs out to the doc.
        expect(ed.moveNode(0, 5)).toBe(false) // …but that's this node's own slot
        expect(ed.moveNode(4, 0)).toBe(true) // code block → the top
        expect(ed.state.doc.child(0).type.name).toBe('code_block')
        ed.destroy()
    })

    // ── Drop targets ─────────────────────────────────────────────────

    test('seamPosAt picks the seam before or after the nearest block', () =>
    {
        const { ed } = dndEditor()
        expect((ed as any).seamPosAt(5)).toBe(0)    // above everything
        expect((ed as any).seamPosAt(20)).toBe(7)   // below 'above' → before the widget
        expect((ed as any).seamPosAt(50)).toBe(7)   // top half of the widget
        expect((ed as any).seamPosAt(80)).toBe(8)   // bottom half of the widget
        expect((ed as any).seamPosAt(130)).toBe(15) // past the end of the doc
        ed.destroy()
    })

    test('a floated block is not a seam candidate (it is out of the flow)', () =>
    {
        const { ed } = dndEditor({
            floatRect: (n: any) => n.type.name === 'widget' ? { x: 0, y: 0, width: 100 } : null,
        })
        // The widget is pinned at y 0..40 beside the text now, so the paragraphs
        // are the only blocks whose y says anything about document order:
        // 'above' at 0..26, 'below' at 46..72.
        expect((ed as any).lastLayouts.find((b: any) => b.floatRect)).toBeTruthy()
        // y=30 is nearest the float's own midpoint (20) — but it must resolve to
        // the seam after 'above' (7), not the seam after the float (8).
        expect((ed as any).seamPosAt(30)).toBe(7)
        ed.destroy()
    })

    // ── The pointer gesture (mouse / touch / pen alike) ───────────────

    test('dragging an atom past the threshold moves it on release', async () =>
    {
        const { ed, container } = dndEditor()
        const view = container.querySelector('.nv')!
        view.dispatchEvent(pointer('pointerdown', { clientX: 10, clientY: 50 }))
        window.dispatchEvent(pointer('pointermove', { clientX: 10, clientY: 130 }))
        expect((ed as any).nodeDrag.active).toBe(true)
        window.dispatchEvent(pointer('pointerup', { clientX: 10, clientY: 130 }))
        expect(ed.state.doc.child(2).type.name).toBe('widget') // dropped at the end
        expect((ed as any).nodeDrag).toBeNull()
        await nextFrame()
        ed.destroy()
    })

    test('a press that never travels stays a click, not a drag', () =>
    {
        const { ed, container } = dndEditor()
        const before = ed.state.doc
        const view = container.querySelector('.nv')!
        view.dispatchEvent(pointer('pointerdown', { clientX: 10, clientY: 50 }))
        window.dispatchEvent(pointer('pointermove', { clientX: 13, clientY: 52 })) // < 6px
        expect((ed as any).nodeDrag.active).toBe(false)
        expect((ed as any).dropTarget).toBeNull()
        window.dispatchEvent(pointer('pointerup', { clientX: 13, clientY: 52 }))
        expect(ed.state.doc).toBe(before)
        ed.destroy()
    })

    test('the drop indicator marks the seam the node would land in', () =>
    {
        const { ed, container } = dndEditor()
        const view = container.querySelector('.nv')!
        view.dispatchEvent(pointer('pointerdown', { clientX: 10, clientY: 50 }))
        window.dispatchEvent(pointer('pointermove', { clientX: 10, clientY: 20 }))
        expect((ed as any).dropTarget).toEqual({ pos: 7, seam: true })
        // Painted where a gap cursor in that seam would be.
        expect((ed as any).gapCursorY(7)).toBe(36)
        ed.destroy()
    })

    test('Escape abandons a drag in flight', () =>
    {
        const { ed, container } = dndEditor()
        const before = ed.state.doc
        const view = container.querySelector('.nv')!
        view.dispatchEvent(pointer('pointerdown', { clientX: 10, clientY: 50 }))
        window.dispatchEvent(pointer('pointermove', { clientX: 10, clientY: 130 }))
        ;(ed as any).textarea.dispatchEvent(
            new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }),
        )
        expect((ed as any).nodeDrag).toBeNull()
        expect((ed as any).dropTarget).toBeNull()
        window.dispatchEvent(pointer('pointerup', { clientX: 10, clientY: 130 }))
        expect(ed.state.doc).toBe(before)
        ed.destroy()
    })

    test('pointercancel (the scroller taking over) abandons the drag', () =>
    {
        const { ed, container } = dndEditor()
        const view = container.querySelector('.nv')!
        view.dispatchEvent(pointer('pointerdown', { clientX: 10, clientY: 50 }))
        window.dispatchEvent(pointer('pointermove', { clientX: 10, clientY: 130 }))
        window.dispatchEvent(pointer('pointercancel', { clientX: 10, clientY: 130 }))
        expect((ed as any).nodeDrag).toBeNull()
        ed.destroy()
    })

    test('a dragStart handler can veto the drag', () =>
    {
        const seen: number[] = []
        const { ed, container } = dndEditor({
            handlers: { dragStart: (_e: unknown, pos: number) => { seen.push(pos); return true } },
        })
        container.querySelector('.nv')!.dispatchEvent(pointer('pointerdown', { clientX: 10, clientY: 50 }))
        expect(seen).toEqual([7])
        expect((ed as any).nodeDrag).toBeNull()
        ed.destroy()
    })

    test('a node view running its own gesture opts out via preventDefault', () =>
    {
        const { ed, container } = dndEditor()
        const view = container.querySelector('.nv')!
        view.addEventListener('pointerdown', (e) => e.preventDefault())
        view.dispatchEvent(pointer('pointerdown', { clientX: 10, clientY: 50 }))
        expect((ed as any).nodeDrag).toBeNull()
        ed.destroy()
    })

    test('dragDrop: false leaves presses on a node alone', () =>
    {
        const { ed, container } = dndEditor({ dragDrop: false })
        container.querySelector('.nv')!.dispatchEvent(pointer('pointerdown', { clientX: 10, clientY: 50 }))
        expect((ed as any).nodeDrag).toBeNull()
        // …and the container keeps the scroller's pan gesture.
        expect((container.querySelector('.nv')!.parentElement as HTMLElement).style.touchAction).toBe('')
        ed.destroy()
    })

    test('a node view container claims the touch gesture so a swipe can drag', () =>
    {
        const { ed, container } = dndEditor()
        const wrap = container.querySelector('.nv')!.parentElement as HTMLElement
        expect(wrap.style.touchAction).toBe('none')
        ed.destroy()
    })

    test('a read-only editor does not start node drags or move nodes', () =>
    {
        const { ed, container } = dndEditor({ editable: false })
        container.querySelector('.nv')!.dispatchEvent(pointer('pointerdown', { clientX: 10, clientY: 50 }))
        expect((ed as any).nodeDrag).toBeNull()
        expect(ed.moveNode(7, 0)).toBe(false)
        ed.destroy()
    })

    test('the browser’s own image drag is refused so it cannot steal the gesture', () =>
    {
        const { ed, container } = dndEditor()
        const e = new Event('dragstart', { bubbles: true, cancelable: true })
        container.querySelector('.nv')!.dispatchEvent(e)
        expect(e.defaultPrevented).toBe(true)
        ed.destroy()
    })

    // ── Dropping in from outside ─────────────────────────────────────

    test('dragging over the editor shows a caret at the drop position', () =>
    {
        const { ed } = dndEditor()
        ;(ed as any).stack.dispatchEvent(dragEvent('dragover', 16, 13))
        expect((ed as any).dropTarget).toEqual({ pos: 3, seam: false })
        ;(ed as any).stack.dispatchEvent(dragEvent('dragleave', 16, 300))
        expect((ed as any).dropTarget).toBeNull()
        ed.destroy()
    })

    test('dropped text lands where it was dropped, not at the caret', () =>
    {
        const { ed } = dndEditor()
        ;(ed as any).stack.dispatchEvent(dragEvent('drop', 16, 13, { 'text/plain': 'ZZ' }))
        expect(ed.state.doc.child(0).textContent).toBe('abZZove')
        expect((ed as any).dropTarget).toBeNull()
        ed.destroy()
    })

    test('dropped HTML is parsed through the schema', () =>
    {
        const { ed } = dndEditor()
        ;(ed as any).stack.dispatchEvent(
            dragEvent('drop', 16, 13, { 'text/html': '<p><strong>bold</strong></p>' }),
        )
        expect(ed.state.doc.textContent).toContain('bold')
        ed.destroy()
    })

    test('dropped files are handed to dropFiles with the drop position', () =>
    {
        const calls: Array<{ pos: number, names: string[] }> = []
        const { ed } = dndEditor({
            handlers: {
                dropFiles: (_e: unknown, pos: number, files: Array<{ name: string }>) =>
                {
                    calls.push({ pos, names: files.map((f) => f.name) })
                    return true
                },
            },
        })
        const file = { name: 'frog.png', type: 'image/png' }
        ;(ed as any).stack.dispatchEvent(dragEvent('drop', 16, 13, {}, [file]))
        expect(calls).toEqual([{ pos: 3, names: ['frog.png'] }])
        ed.destroy()
    })

    test('files with no dropFiles handler are ignored (no upload story built in)', () =>
    {
        const { ed } = dndEditor()
        const before = ed.state.doc
        ;(ed as any).stack.dispatchEvent(dragEvent('drop', 16, 13, { 'text/plain': 'x' }, [{ name: 'a.png' }]))
        expect(ed.state.doc).toBe(before)
        ed.destroy()
    })

    test('a drop handler takes over the whole drop', () =>
    {
        const seen: number[] = []
        const { ed } = dndEditor({
            handlers: {
                drop: (_e: unknown, pos: number) => { seen.push(pos); return true },
                dropFiles: () => { throw new Error('drop already handled it') },
            },
        })
        const before = ed.state.doc
        ;(ed as any).stack.dispatchEvent(dragEvent('drop', 16, 13, { 'text/plain': 'ZZ' }, [{ name: 'a.png' }]))
        expect(seen).toEqual([3])
        expect(ed.state.doc).toBe(before)
        ed.destroy()
    })

    test('a read-only editor ignores drops', () =>
    {
        const { ed } = dndEditor({ editable: false })
        const before = ed.state.doc
        ;(ed as any).stack.dispatchEvent(dragEvent('drop', 16, 13, { 'text/plain': 'ZZ' }))
        expect(ed.state.doc).toBe(before)
        ed.destroy()
    })
})


describe('drag & drop: text selections, drag-out, edge auto-scroll', () =>
{
    function ed(text = 'hello world', opts: any = {}): CanvasEditor
    {
        const doc = schema.node('doc', null, [
            schema.node('paragraph', null, [schema.text(text)]),
        ])
        const container = document.createElement('div')
        document.body.appendChild(container)
        const e = new CanvasEditor({
            state: EditorState.create({ doc, schema, plugins: [history()] }),
            container, autofocus: false, ...opts,
        })
        ;(e as any).canvas.getBoundingClientRect = () => ({ left: 0, top: 0 })
        return e
    }

    /** A DragEvent stand-in that records what gets written to its dataTransfer. */
    function dragEvent(type: string, x: number, y: number, opts: any = {}): any
    {
        const store: Record<string, string> = {}
        const e: any = new Event(type, { bubbles: true, cancelable: true })
        Object.assign(e, {
            clientX: x, clientY: y, altKey: !!opts.altKey,
            dataTransfer: {
                setData: (t: string, v: string) => { store[t] = v },
                getData: (t: string) => store[t] ?? '',
                files: [],
                dropEffect: opts.dropEffect ?? 'none',
                effectAllowed: 'none',
            },
        })
        e.written = store
        return e
    }

    const mouse = (type: string, x: number, y: number) =>
        new MouseEvent(type, {
            bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y,
        })

    /** Select a range and press inside it — the state every drag starts from. */
    function pressInside(e: CanvasEditor, from: number, to: number, x = 16): void
    {
        e.dispatch(e.state.tr.setSelection(
            TextSelection.create(e.state.doc, from, to),
        ))
        ;(e as any).canvas.dispatchEvent(mouse('mousedown', x, 5))
    }

    // ── Dragging a text selection ────────────────────────────────────

    test('a press inside the selection arms a drag rather than collapsing it', () =>
    {
        const e = ed()
        pressInside(e, 1, 6)
        expect(e.state.selection.from).toBe(1)
        expect(e.state.selection.to).toBe(6)
        expect((e as any).stack.draggable).toBe(true)
        e.destroy()
    })

    test('that press is left un-defaultPrevented, or no drag can ever start', () =>
    {
        // The regression this guards: `preventDefault()` on mousedown also stops
        // the browser from *starting* a native drag, so suppressing it here
        // would silently kill dragging out to another application — while every
        // test that dispatches `dragstart` by hand still passed.
        const e = ed()
        e.dispatch(e.state.tr.setSelection(
            TextSelection.create(e.state.doc, 1, 6),
        ))
        const inside = mouse('mousedown', 16, 5)
        ;(e as any).canvas.dispatchEvent(inside)
        expect(inside.defaultPrevented).toBe(false)

        // Everywhere else the default is still suppressed, as it always was.
        const outside = mouse('mousedown', 72, 5)
        ;(e as any).canvas.dispatchEvent(outside)
        expect(outside.defaultPrevented).toBe(true)
        e.destroy()
    })

    test('a modifier press inside the selection is not a drag', () =>
    {
        // Shift extends and Cmd follows a link; both must keep working, so
        // neither may be swallowed by the drag-arming branch.
        const e = ed()
        e.dispatch(e.state.tr.setSelection(
            TextSelection.create(e.state.doc, 1, 6),
        ))
        const shift = new MouseEvent('mousedown', {
            bubbles: true, cancelable: true, button: 0,
            clientX: 16, clientY: 5, shiftKey: true,
        })
        ;(e as any).canvas.dispatchEvent(shift)
        expect(shift.defaultPrevented).toBe(true)
        expect((e as any).pressInSelection).toBeNull()
        e.destroy()
    })

    test('DOM text selection is off, since the press is no longer suppressed', () =>
    {
        const e = ed()
        expect((e as any).stack.style.userSelect).toBe('none')
        e.destroy()
    })

    test('but a node view opts back in — its DOM is the consumer\'s', () =>
    {
        const doc = schema.node('doc', null, [
            schema.node('paragraph', null, [schema.text('hi')]),
            schema.node('widget'),
        ])
        const container = document.createElement('div')
        document.body.appendChild(container)
        const e = new CanvasEditor({
            state: EditorState.create({ doc, schema }),
            container, autofocus: false,
            nodeViews: {
                widget: () => {
                    const el = document.createElement('div')
                    el.textContent = 'selectable caption'
                    return el
                },
            },
        })
        const view = [...(e as any).mountedViews.values()][0] as any
        expect(view.dom.style.userSelect).toBe('text')
        e.destroy()
    })

    test('a read-only editor can still be dragged from, as a copy only', () =>
    {
        const e = ed()
        e.setEditable(false)
        pressInside(e, 1, 6)
        const ds = dragEvent('dragstart', 16, 5)
        ;(e as any).stack.dispatchEvent(ds)
        expect(ds.written['text/plain']).toBe('hello')
        expect(ds.dataTransfer.effectAllowed).toBe('copy')
        // And a "move" reported back must not delete from a read-only document.
        ;(e as any).stack.dispatchEvent(
            dragEvent('dragend', 0, 0, { dropEffect: 'move' }),
        )
        expect(e.state.doc.textContent).toBe('hello world')
        e.destroy()
    })

    test('a press inside the selection that never drags is just a click', () =>
    {
        const e = ed()
        pressInside(e, 1, 6)
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
        expect(e.state.selection.empty).toBe(true)
        expect(e.state.selection.head).toBe(3) // x 16 → offset 2
        expect((e as any).stack.draggable).toBe(false)
        e.destroy()
    })

    test('a press outside the selection still moves the caret immediately', () =>
    {
        const e = ed()
        e.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, 1, 6)))
        ;(e as any).canvas.dispatchEvent(mouse('mousedown', 72, 5))
        expect(e.state.selection.empty).toBe(true)
        // Never armed at all, so the property is left untouched.
        expect((e as any).stack.draggable).toBeFalsy()
        e.destroy()
    })

    test('dragstart offers the selection as both text and html', () =>
    {
        const e = ed()
        pressInside(e, 1, 6)
        const ds = dragEvent('dragstart', 16, 5)
        ;(e as any).stack.dispatchEvent(ds)
        expect(ds.written['text/plain']).toBe('hello')
        expect(ds.written['text/html']).toContain('hello')
        expect(ds.dataTransfer.effectAllowed).toBe('copyMove')
        e.destroy()
    })

    test('dropping back inside moves the text, as one undo step', () =>
    {
        const e = ed()
        pressInside(e, 1, 6)
        ;(e as any).stack.dispatchEvent(dragEvent('dragstart', 16, 5))
        ;(e as any).stack.dispatchEvent(dragEvent('drop', 88, 5))
        expect(e.state.doc.textContent).toBe(' worldhello')
        e.command(undo)
        expect(e.state.doc.textContent).toBe('hello world')
        e.destroy()
    })

    test('dropping inside the dragged range does nothing', () =>
    {
        const e = ed()
        pressInside(e, 1, 6)
        ;(e as any).stack.dispatchEvent(dragEvent('dragstart', 16, 5))
        ;(e as any).stack.dispatchEvent(dragEvent('drop', 24, 5))
        expect(e.state.doc.textContent).toBe('hello world')
        e.destroy()
    })

    test('Alt turns the move into a copy', () =>
    {
        const e = ed()
        pressInside(e, 1, 6)
        ;(e as any).stack.dispatchEvent(dragEvent('dragstart', 16, 5))
        ;(e as any).stack.dispatchEvent(dragEvent('drop', 88, 5, { altKey: true }))
        expect(e.state.doc.textContent).toBe('hello worldhello')
        e.destroy()
    })

    // ── Dragging out to another application ──────────────────────────

    test('another application taking it as a move removes the source', () =>
    {
        const e = ed()
        pressInside(e, 1, 6)
        ;(e as any).stack.dispatchEvent(dragEvent('dragstart', 16, 5))
        ;(e as any).stack.dispatchEvent(dragEvent('dragend', 0, 0, { dropEffect: 'move' }))
        expect(e.state.doc.textContent).toBe(' world')
        e.destroy()
    })

    test('a copy elsewhere, or a cancelled drag, leaves the document alone', () =>
    {
        for (const dropEffect of ['copy', 'none']) {
            const e = ed()
            pressInside(e, 1, 6)
            ;(e as any).stack.dispatchEvent(dragEvent('dragstart', 16, 5))
            ;(e as any).stack.dispatchEvent(dragEvent('dragend', 0, 0, { dropEffect }))
            expect(e.state.doc.textContent).toBe('hello world')
            e.destroy()
        }
    })

    test('a drop handled here is not also deleted by the dragend', () =>
    {
        const e = ed()
        pressInside(e, 1, 6)
        ;(e as any).stack.dispatchEvent(dragEvent('dragstart', 16, 5))
        ;(e as any).stack.dispatchEvent(dragEvent('drop', 88, 5))
        ;(e as any).stack.dispatchEvent(dragEvent('dragend', 0, 0, { dropEffect: 'move' }))
        expect(e.state.doc.textContent).toBe(' worldhello')
        e.destroy()
    })

    // ── Edge auto-scroll ─────────────────────────────────────────────

    test('a drag near an edge scrolls, and the middle does not', () =>
    {
        const e = ed('hello world', { maxHeight: 200 })
        ;(e as any).scroller.getBoundingClientRect =
            () => ({ top: 0, bottom: 200, height: 200 })
        const dy = (clientY: number) => {
            ;(e as any).updateAutoScroll(0, clientY)
            return (e as any).autoScrollDy
        }
        expect(dy(196)).toBeGreaterThan(0)   // near the bottom → scroll down
        expect(dy(4)).toBeLessThan(0)        // near the top → scroll up
        expect(dy(100)).toBe(0)              // middle → still
        // Deeper into the band is faster than its edge.
        expect(Math.abs(dy(199))).toBeGreaterThan(Math.abs(dy(180)))
        e.destroy()
    })

    test('without a scroller there is nothing to auto-scroll', () =>
    {
        const e = ed()
        ;(e as any).updateAutoScroll(0, 0)
        expect((e as any).autoScrollDy).toBe(0)
        e.destroy()
    })

    test('the auto-scroll loop is stopped when a node drag is cancelled', () =>
    {
        const e = ed('hello world', { maxHeight: 200 })
        ;(e as any).scroller.getBoundingClientRect =
            () => ({ top: 0, bottom: 200, height: 200 })
        ;(e as any).updateAutoScroll(0, 199)
        expect((e as any).autoScrollDy).not.toBe(0)
        ;(e as any).cancelNodeDrag()
        expect((e as any).autoScrollDy).toBe(0)
        e.destroy()
    })
})


describe('tables (side-by-side layout)', () =>
{
    // Mock: 8px/char, container 460. Cell inset per side is TABLE_BORDER(1) +
    // CELL_PAD_X(8) = 9, so a cell's content frame is its column minus 18.
    const cell = (text: string, attrs: any = {}) =>
        schema.node('table_cell', attrs, [schema.node('paragraph', null, [schema.text(text)])])
    const header = (text: string) =>
        schema.node('table_header', null, [schema.node('paragraph', null, [schema.text(text)])])
    const row = (...cells: any[]) => schema.node('table_row', null, cells)

    function mk(...rows: any[])
    {
        const container = document.createElement('div')
        document.body.appendChild(container)
        const doc = schema.node('doc', null, [schema.node('table', null, rows)])
        const ed = new CanvasEditor({ state: EditorState.create({ doc, schema }), container })
        return { ed, layouts: (ed as any).lastLayouts as any[], tables: (ed as any).lastTables as any[] }
    }

    test('cells in a row share a vertical band and differ only in x', () =>
    {
        const { ed, layouts } = mk(row(cell('aa'), cell('bb'), cell('cc')))
        expect(layouts.length).toBe(3)
        const ys = layouts.map((b) => b.lines[0].y)
        expect(new Set(ys).size).toBe(1)          // same band
        const xs = layouts.map((b) => b.lines[0].x)
        expect(xs[0]).toBeLessThan(xs[1])          // laid left to right
        expect(xs[1]).toBeLessThan(xs[2])
        ed.destroy()
    })

    test('columns divide the content width and the last absorbs rounding', () =>
    {
        const { ed, tables } = mk(row(cell('a'), cell('b'), cell('c')))
        const cols = tables[0].cols
        expect(cols.length).toBe(3)
        // 460 / 3 does not divide evenly; the table must still end exactly at 460.
        expect(cols.reduce((s: number, c: any) => s + c.width, 0)).toBe(460)
        expect(cols[0].x).toBe(0)
        expect(cols[2].x + cols[2].width).toBe(460)
        ed.destroy()
    })

    test('an explicit colwidth is honored and the rest share what is left', () =>
    {
        const { ed, tables } = mk(row(cell('a', { colwidth: [200] }), cell('b'), cell('c')))
        const cols = tables[0].cols
        expect(cols[0].width).toBe(200)
        expect(cols[1].width).toBe(cols[2].width)
        expect(cols.reduce((s: number, c: any) => s + c.width, 0)).toBe(460)
        ed.destroy()
    })

    test('row height is the tallest cell, and every box in the row matches it', () =>
    {
        // The mock puts one line per '\n' segment, so a two-line cell is taller.
        const tall = schema.node('table_cell', null, [
            schema.node('paragraph', null, [schema.text('one')]),
            schema.node('paragraph', null, [schema.text('two')]),
        ])
        const { ed, tables } = mk(row(cell('short'), tall))
        const boxes = tables[0].cells
        expect(boxes.length).toBe(2)
        expect(boxes[0].height).toBe(boxes[1].height)
        // Two stacked paragraphs must make the row taller than a single one.
        const { ed: ed2, tables: t2 } = mk(row(cell('short'), cell('also short')))
        expect(boxes[0].height).toBeGreaterThan(t2[0].cells[0].height)
        ed.destroy(); ed2.destroy()
    })

    test('a cell block carries its frame, and it matches the column', () =>
    {
        const { ed, layouts, tables } = mk(row(cell('aa'), cell('bb')))
        const cols = tables[0].cols
        for (let i = 0; i < 2; i++)
        {
            const f = layouts[i].frame
            expect(f).toBeTruthy()
            expect(f.x).toBe(cols[i].x + 9)         // border + pad
            expect(f.width).toBe(cols[i].width - 18)
        }
        ed.destroy()
    })

    test('clicking in a cell resolves into that cell, not its neighbour', () =>
    {
        const { ed, layouts, tables } = mk(row(cell('aa'), cell('bb'), cell('cc')))
        const cols = tables[0].cols
        for (let i = 0; i < 3; i++)
        {
            const midX = cols[i].x + cols[i].width / 2
            const y = layouts[i].lines[0].y + 1
            const hit = (ed as any).clickToPos(layouts, midX, y)
            // Each cell's block owns [pmStartPos, pmEndPos]; the hit must land there.
            expect(hit.pos).toBeGreaterThanOrEqual(layouts[i].pmStartPos)
            expect(hit.pos).toBeLessThanOrEqual(layouts[i].pmEndPos)
        }
        ed.destroy()
    })

    test('header cells are flagged for the chrome to fill', () =>
    {
        const { ed, tables } = mk(row(header('h1'), header('h2')), row(cell('a'), cell('b')))
        const boxes = tables[0].cells
        expect(boxes.filter((c: any) => c.header).length).toBe(2)
        expect(boxes.filter((c: any) => !c.header).length).toBe(2)
        expect(boxes.filter((c: any) => c.row === 0).every((c: any) => c.header)).toBe(true)
        ed.destroy()
    })

    test('colspan widens a cell across the columns it covers', () =>
    {
        const { ed, tables } = mk(
            row(cell('wide', { colspan: 2 })),
            row(cell('a'), cell('b')),
        )
        const cols = tables[0].cols
        expect(cols.length).toBe(2)
        const spanning = tables[0].cells.find((c: any) => c.row === 0)
        expect(spanning.width).toBe(cols[0].width + cols[1].width)
        ed.destroy()
    })

    test('rows stack, and the table advances the document cursor', () =>
    {
        const container = document.createElement('div')
        document.body.appendChild(container)
        const doc = schema.node('doc', null, [
            schema.node('table', null, [row(cell('a')), row(cell('b'))]),
            schema.node('paragraph', null, [schema.text('after')]),
        ])
        const ed = new CanvasEditor({ state: EditorState.create({ doc, schema }), container })
        const tables = (ed as any).lastTables as any[]
        const layouts = (ed as any).lastLayouts as any[]
        expect(tables[0].rows.length).toBe(2)
        expect(tables[0].rows[1].y).toBe(tables[0].rows[0].y + tables[0].rows[0].height)
        const after = layouts.find((b) => b.text === 'after')
        expect(after.yOffset).toBeGreaterThanOrEqual(tables[0].y + tables[0].height)
        ed.destroy()
    })

    test('an edit inside a cell declines the incremental path', () =>
    {
        const { ed } = mk(row(cell('aa'), cell('bb')))
        const cellBlock = ((ed as any).lastLayouts as any[])[0]
        expect(cellBlock.frame).toBeTruthy()
        ;(ed as any).dispatch((ed as any).state.tr.insertText('X', cellBlock.pmStartPos))
        ;(ed as any).prevDoc = (ed as any).prevDoc // no-op, keep prevDoc as-is
        // A cell's height change only moves rows below when it is its row's
        // tallest, which the incremental shift cannot express.
        expect((ed as any).tryIncrementalLayout()).toBe(false)
        ed.destroy()
    })
})


describe('tables: grid model, spans, selection, commands', () =>
{
    const p = (t: string) => schema.node('paragraph', null, t ? [schema.text(t)] : [])
    const td = (t: string, attrs: any = {}) => schema.node('table_cell', attrs, [p(t)])
    const th = (t: string, attrs: any = {}) => schema.node('table_header', attrs, [p(t)])
    const tr_ = (...c: any[]) => schema.node('table_row', null, c)
    const tbl = (...rows: any[]) => schema.node('table', null, rows)

    function mk(table: any)
    {
        const container = document.createElement('div')
        document.body.appendChild(container)
        const doc = schema.node('doc', null, [table])
        const ed = new CanvasEditor({ state: EditorState.create({ doc, schema }), container })
        return ed
    }
    const gridOf = (ed: CanvasEditor) =>
    {
        const t = findTable(ed.state.doc, 1)!
        return buildGrid(t.node, t.pos)
    }

    // ── grid model ──
    test('a rowspan shifts later cells right, and slots resolve to the spanner', () =>
    {
        // r0: [A(rowspan2)][B]   r1: [C]  -> C must land in column 1, not 0.
        const ed = mk(tbl(
            tr_(td('A', { rowspan: 2 }), td('B')),
            tr_(td('C')),
        ))
        const g = gridOf(ed)
        expect(g.width).toBe(2)
        expect(g.height).toBe(2)
        const c = g.cells.find((x) => x.node.textContent === 'C')!
        expect(c.col).toBe(1)
        expect(cellAt(g, 1, 0)!.node.textContent).toBe('A')   // spanner occupies it
        expect(cellAt(g, 0, 0)!.node.textContent).toBe('A')
        ed.destroy()
    })

    test('colspan widens the grid and occupies every column it covers', () =>
    {
        const ed = mk(tbl(tr_(td('wide', { colspan: 3 })), tr_(td('a'), td('b'), td('c'))))
        const g = gridOf(ed)
        expect(g.width).toBe(3)
        for (let c = 0; c < 3; c++) expect(cellAt(g, 0, c)!.node.textContent).toBe('wide')
        ed.destroy()
    })

    test('a rowspan cell reserves height across the rows it covers', () =>
    {
        // Control: the same three-paragraph cell, not spanning. Its row height
        // is the height that content actually needs.
        const control = mk(tbl(tr_(schema.node('table_cell', null, [p('x'), p('y'), p('z')]))))
        const needed = (control as any).lastTables[0].rows[0].height as number
        control.destroy()

        // Spanning over two rows whose other cells are each a single line: the
        // rows must be grown to fit it. Asserting the box equals the sum of its
        // rows would be vacuous — pass 3 computes it that way by construction —
        // so compare against what the content genuinely needs.
        const tall = schema.node('table_cell', { rowspan: 2 }, [p('x'), p('y'), p('z')])
        const ed = mk(tbl(tr_(tall, td('b')), tr_(td('c'))))
        const chrome = (ed as any).lastTables[0]
        const r0 = chrome.rows[0].height as number
        const r1 = chrome.rows[1].height as number
        expect(r0 + r1).toBeGreaterThanOrEqual(needed)
        // And the deficit lands on the last row it covers, not the first, so a
        // shorter cell already fixing row 0 is not disturbed.
        expect(r1).toBeGreaterThan(r0)
        const spanBox = chrome.cells.find((c: any) => c.row === 0 && c.col === 0)!
        expect(spanBox.height).toBe(r0 + r1)
        ed.destroy()
    })

    // ── nested / non-textblock cell content ──
    test('a list inside a cell lays out inside that cell frame', () =>
    {
        const listCell = schema.node('table_cell', null, [
            schema.node('bullet_list', null, [
                schema.node('list_item', null, [p('one')]),
                schema.node('list_item', null, [p('two')]),
            ]),
        ])
        const ed = mk(tbl(tr_(listCell, td('right'))))
        const layouts = (ed as any).lastLayouts as any[]
        const items = layouts.filter((b) => b.text === 'one' || b.text === 'two')
        expect(items.length).toBe(2)
        const chrome = (ed as any).lastTables[0]
        const col0 = chrome.cols[0]
        for (const it of items)
        {
            expect(it.marker).toBeTruthy()                       // bullets survive
            expect(it.lines[0].x).toBeGreaterThanOrEqual(col0.x) // stays in its column
            expect(it.lines[0].x).toBeLessThan(col0.x + col0.width)
        }
        ed.destroy()
    })

    test('a table nested in a cell produces its own chrome', () =>
    {
        const inner = tbl(tr_(td('i1'), td('i2')))
        const outerCell = schema.node('table_cell', null, [inner])
        const ed = mk(tbl(tr_(outerCell, td('right'))))
        const tables = (ed as any).lastTables as any[]
        expect(tables.length).toBe(2)                 // outer + nested
        const nested = tables.find((t) => t.cols.length === 2 && t.y > tables[0].y - 1 && t !== tables[0])
        expect(nested).toBeTruthy()
        expect(nested.width).toBeLessThan(tables[0].width)
        ed.destroy()
    })

    // ── cell selection ──
    test('CellSelection.between snaps to a rectangle and is not visible', () =>
    {
        const ed = mk(tbl(tr_(td('a'), td('b')), tr_(td('c'), td('d'))))
        const g = gridOf(ed)
        const a = g.cells[0], d = g.cells[3]
        const sel = CellSelection.between(ed.state.doc, a.pos + 1, d.pos + 1)!
        expect(sel).toBeTruthy()
        expect(sel.cells.length).toBe(4)
        expect(sel.visible).toBe(false)
        ed.destroy()
    })

    test('a cell selection grows to cover a merged cell rather than clipping it', () =>
    {
        // Selecting a..b in row 0 must pull in the colspan cell fully.
        const ed = mk(tbl(
            tr_(td('a'), td('wide', { colspan: 2 })),
            tr_(td('c'), td('d'), td('e')),
        ))
        const g = gridOf(ed)
        const a = g.cells.find((c) => c.node.textContent === 'a')!
        const sel = new CellSelection(ed.state.doc, a.pos, a.pos)
        expect(sel.cells.length).toBe(1)
        const wide = g.cells.find((c) => c.node.textContent === 'wide')!
        const sel2 = new CellSelection(ed.state.doc, a.pos, wide.pos)
        // The rectangle spans all three columns, so row 0 contributes 2 cells.
        expect(sel2.cells.map((c) => c.node.textContent).sort()).toEqual(['a', 'wide'])
        ed.destroy()
    })

    test('a cell selection survives a mapping through a transaction', () =>
    {
        const ed = mk(tbl(tr_(td('a'), td('b')), tr_(td('c'), td('d'))))
        const g = gridOf(ed)
        const sel = new CellSelection(ed.state.doc, g.cells[0].pos, g.cells[3].pos)
        ed.dispatch(ed.state.tr.setSelection(sel))
        expect(ed.state.selection).toBeInstanceOf(CellSelection)
        // Type into the first cell; the selection must remap, not throw.
        const tr = ed.state.tr.insertText('zz', g.cells[0].pos + 2)
        ed.dispatch(tr)
        expect(ed.state.selection).toBeInstanceOf(CellSelection)
        ed.destroy()
    })

    // ── commands ──
    test('addRowAfter inserts a row with the right number of cells', () =>
    {
        const ed = mk(tbl(tr_(td('a'), td('b'))))
        ed.command((s, d) => { d?.(s.tr.setSelection(TextSelection.near(s.doc.resolve(4)))); return true })
        expect(ed.command(addRowAfter)).toBe(true)
        const g = gridOf(ed)
        expect(g.height).toBe(2)
        expect(g.width).toBe(2)
        ed.destroy()
    })

    test('deleteRow removes it and refuses on the last remaining row', () =>
    {
        const ed = mk(tbl(tr_(td('a')), tr_(td('b'))))
        ed.command((s, d) => { d?.(s.tr.setSelection(TextSelection.near(s.doc.resolve(4)))); return true })
        expect(ed.command(deleteRow)).toBe(true)
        expect(gridOf(ed).height).toBe(1)
        expect(ed.command(deleteRow)).toBe(false)   // last row is protected
        ed.destroy()
    })

    test('addColumnAfter widens every row', () =>
    {
        const ed = mk(tbl(tr_(td('a'), td('b')), tr_(td('c'), td('d'))))
        ed.command((s, d) => { d?.(s.tr.setSelection(TextSelection.near(s.doc.resolve(4)))); return true })
        expect(ed.command(addColumnAfter)).toBe(true)
        const g = gridOf(ed)
        expect(g.width).toBe(3)
        expect(g.height).toBe(2)
        ed.destroy()
    })

    test('deleteColumn narrows a spanning cell instead of deleting it', () =>
    {
        const ed = mk(tbl(
            tr_(td('wide', { colspan: 2 })),
            tr_(td('a'), td('b')),
        ))
        ed.command((s, d) => { d?.(s.tr.setSelection(TextSelection.near(s.doc.resolve(4)))); return true })
        expect(ed.command(deleteColumn)).toBe(true)
        const g = gridOf(ed)
        expect(g.width).toBe(1)
        const wide = g.cells.find((c) => c.node.textContent === 'wide')
        expect(wide).toBeTruthy()                     // survived, narrowed
        expect(wide!.colspan).toBe(1)
        ed.destroy()
    })

    test('deleteColumn refuses on a single-column table', () =>
    {
        const ed = mk(tbl(tr_(td('a')), tr_(td('b'))))
        ed.command((s, d) => { d?.(s.tr.setSelection(TextSelection.near(s.doc.resolve(4)))); return true })
        expect(ed.command(deleteColumn)).toBe(false)
        ed.destroy()
    })

    test('goToNextCell walks cells and appends a row past the last one', () =>
    {
        const ed = mk(tbl(tr_(td('a'), td('b'))))
        ed.command((s, d) => { d?.(s.tr.setSelection(TextSelection.near(s.doc.resolve(4)))); return true })
        expect(ed.command(goToNextCell(1))).toBe(true)
        const g1 = gridOf(ed)
        expect(g1.height).toBe(1)
        // Now on the last cell: another Tab grows the table.
        expect(ed.command(goToNextCell(1))).toBe(true)
        expect(gridOf(ed).height).toBe(2)
        ed.destroy()
    })

    test('selectRow / selectColumn produce cell selections', () =>
    {
        const ed = mk(tbl(tr_(td('a'), td('b')), tr_(td('c'), td('d'))))
        ed.command((s, d) => { d?.(s.tr.setSelection(TextSelection.near(s.doc.resolve(4)))); return true })
        expect(ed.command(selectRow)).toBe(true)
        expect(ed.state.selection).toBeInstanceOf(CellSelection)
        expect((ed.state.selection as any).cells.length).toBe(2)
        ed.destroy()
    })

    test('deleteTable removes the whole node', () =>
    {
        const ed = mk(tbl(tr_(td('a'))))
        ed.command((s, d) => { d?.(s.tr.setSelection(TextSelection.near(s.doc.resolve(4)))); return true })
        expect(ed.command(deleteTable)).toBe(true)
        expect(findTable(ed.state.doc, 0)).toBeNull()
        ed.destroy()
    })
})


describe('incremental layout with tables present', () =>
{
    // The regression guard that matters: after any edit, the incrementally
    // maintained layout must be indistinguishable from a from-scratch one —
    // block coordinates *and* table chrome, which carries its own absolute
    // coordinates and so can silently drift out of step with the cells.
    const p = (t: string) => schema.node('paragraph', null, [schema.text(t)])
    const td = (t: string) => schema.node('table_cell', null, [p(t)])
    const tr_ = (...c: any[]) => schema.node('table_row', null, c)

    function build(docNode: any)
    {
        const container = document.createElement('div')
        document.body.appendChild(container)
        return new CanvasEditor({ state: EditorState.create({ doc: docNode, schema }), container })
    }
    const fresh = (ed: CanvasEditor) => build((ed as any).state.doc)

    const snapshot = (ed: CanvasEditor) =>
    {
        const size = (ed as any).state.doc.content.size as number
        const coords: string[] = []
        for (let i = 0; i <= size; i++)
        {
            const c = (ed as any).coordsAtPos(i)
            coords.push(c ? `${c.x.toFixed(2)},${c.y.toFixed(2)}` : 'null')
        }
        const chrome = ((ed as any).lastTables as any[]).map((t) => ({
            y: t.y, h: t.height,
            rows: t.rows.map((r: any) => r.y),
            cells: t.cells.map((c: any) => `${c.x},${c.y},${c.width},${c.height}`),
        }))
        return { coords, chrome, total: (ed as any).lastTotalHeight }
    }

    const docWithTable = () => schema.node('doc', null, [
        p('before the table'),
        schema.node('table', null, [tr_(td('a'), td('b')), tr_(td('c'), td('d'))]),
        p('after the table'),
    ])

    test('typing before a table stays incremental and keeps chrome aligned', () =>
    {
        const ed = build(docWithTable())
        const before = ((ed as any).lastTables as any[])[0].y as number
        ;(ed as any).dispatch((ed as any).state.tr.insertText('XYZ', 3))
        expect((ed as any).tryIncrementalLayout()).toBe(true)   // no full pass
        ;(ed as any).coordsAtPos(0)
        const f = fresh(ed)
        expect(snapshot(ed)).toEqual(snapshot(f))
        // Sanity: the table did not move, because the edit did not change height.
        expect(((ed as any).lastTables as any[])[0].y).toBe(before)
        ed.destroy(); f.destroy()
    })

    test('an edit before a table that changes height moves the chrome with it', () =>
    {
        // A long insert wraps the first paragraph onto another line, growing it.
        const ed = build(docWithTable())
        const before = ((ed as any).lastTables as any[])[0].y as number
        ;(ed as any).dispatch((ed as any).state.tr.insertText('\n', 3))
        ;(ed as any).coordsAtPos(0)
        const after = ((ed as any).lastTables as any[])[0].y as number
        expect(after).toBeGreaterThan(before)      // chrome followed the text
        const f = fresh(ed)
        expect(snapshot(ed)).toEqual(snapshot(f))  // and matches a full pass
        ed.destroy(); f.destroy()
    })

    test('typing after a table stays incremental and matches a full pass', () =>
    {
        const ed = build(docWithTable())
        const size = (ed as any).state.doc.content.size as number
        ;(ed as any).dispatch((ed as any).state.tr.insertText('Q', size - 1))
        expect((ed as any).tryIncrementalLayout()).toBe(true)
        ;(ed as any).coordsAtPos(0)
        const f = fresh(ed)
        expect(snapshot(ed)).toEqual(snapshot(f))
        ed.destroy(); f.destroy()
    })

    test('typing inside a cell falls back, and still matches a full pass', () =>
    {
        const ed = build(docWithTable())
        const cellBlock = ((ed as any).lastLayouts as any[]).find((b: any) => b.text === 'a')
        expect(cellBlock.frame).toBeTruthy()
        ;(ed as any).dispatch((ed as any).state.tr.insertText('ZZ', cellBlock.pmStartPos))
        expect((ed as any).tryIncrementalLayout()).toBe(false)
        ;(ed as any).coordsAtPos(0)
        const f = fresh(ed)
        expect(snapshot(ed)).toEqual(snapshot(f))
        ed.destroy(); f.destroy()
    })

    test('a run of mixed edits around a table converges on the full-pass layout', () =>
    {
        const ed = build(docWithTable())
        const edits: Array<[number, string]> = [[3, 'a'], [5, 'bb'], [2, 'c']]
        for (const [at, t] of edits)
        {
            ;(ed as any).dispatch((ed as any).state.tr.insertText(t, at))
            ;(ed as any).coordsAtPos(0)
        }
        const f = fresh(ed)
        expect(snapshot(ed)).toEqual(snapshot(f))
        ed.destroy(); f.destroy()
    })
})


describe('visible-range culling (frame cost)', () =>
{
    // A wrong window drops blocks from the frame, and the test canvas is a stub
    // so nothing downstream would notice. These compare the window against a
    // brute-force filter instead of trusting it.
    const mkLayouts = (spec: Array<[number, number]>) =>
        spec.map(([y, h], i) => ({
            type: 'paragraph', node: null as any, text: `b${i}`,
            yOffset: y, height: h, lines: [], pmStartPos: i, pmEndPos: i,
            lineHeight: 26, font: '', fontSize: 16, color: null,
            paddingTop: 0, paddingBottom: 0, background: null, borderLeft: null,
            marker: null,
        })) as any[]

    const brute = (ls: any[], top: number, bottom: number) =>
        ls.filter((b) => b.yOffset + b.height >= top && b.yOffset <= bottom).map((b) => b.text)

    const windowed = (ls: any[], top: number, bottom: number, sorted: boolean) =>
    {
        const [lo, hi] = visibleRange(ls, top, bottom, sorted)
        return ls.slice(lo, hi)
            .filter((b) => b.yOffset + b.height >= top && b.yOffset <= bottom)
            .map((b) => b.text)
    }

    test('the window matches a brute-force filter across many viewports', () =>
    {
        const ls = mkLayouts(Array.from({ length: 200 }, (_, i) => [i * 30, 26]))
        for (let top = -50; top < 6200; top += 37)
        {
            const bottom = top + 400
            expect(windowed(ls, top, bottom, true)).toEqual(brute(ls, top, bottom))
        }
    })

    test('a tall block straddling the viewport top is not missed', () =>
    {
        // Block 1 is very tall and starts well above the viewport; a naive
        // lower bound on yOffset alone would skip it.
        const ls = mkLayouts([[0, 20], [20, 900], [920, 20], [940, 20]])
        expect(windowed(ls, 500, 700, true)).toEqual(brute(ls, 500, 700))
        expect(windowed(ls, 500, 700, true)).toContain('b1')
    })

    test('unsorted layouts return the whole array rather than narrowing', () =>
    {
        // The table shape: blocks in one row share a band, so a later block can
        // sit *above* an earlier one. Chosen so narrowing would genuinely lose
        // b2 — a viewport where everything is visible would pass either way.
        const ls = mkLayouts([[0, 20], [1000, 20], [10, 20]])
        expect(visibleRange(ls, 0, 30, false)).toEqual([0, 3])
        expect(windowed(ls, 0, 30, false)).toEqual(brute(ls, 0, 30))
        expect(windowed(ls, 0, 30, false)).toEqual(['b0', 'b2'])
        // And narrowing this input really would drop it — the guard is earning
        // its keep, not decorating a case that works anyway.
        const [lo, hi] = visibleRange(ls, 0, 30, true)
        expect(ls.slice(lo, hi).map((b: any) => b.text)).not.toContain('b2')
    })

    test('empty and fully-out-of-view inputs behave', () =>
    {
        expect(visibleRange([], 0, 100, true)).toEqual([0, 0])
        const ls = mkLayouts([[0, 10], [10, 10]])
        expect(windowed(ls, 5000, 5400, true)).toEqual([])
    })

    test('the editor refuses to claim sorted order when a table is present', () =>
    {
        // This is the guard that keeps the binary search safe. A table makes
        // position order stop implying vertical order.
        const p = (t: string) => schema.node('paragraph', null, [schema.text(t)])
        const cellA = schema.node('table_cell', null, [p('a1'), p('a2')])
        const cellB = schema.node('table_cell', null, [p('b1')])
        const doc = schema.node('doc', null, [
            schema.node('table', null, [schema.node('table_row', null, [cellA, cellB])]),
        ])
        const c = document.createElement('div'); document.body.appendChild(c)
        const ed = new CanvasEditor({ state: EditorState.create({ doc, schema }), container: c })
        const ys = ((ed as any).lastLayouts as any[]).map((b) => b.yOffset)
        expect(ys.some((y, i) => i > 0 && y < ys[i - 1])).toBe(true)   // genuinely unsorted
        expect((ed as any).layoutsSortedByY).toBe(false)               // and known to be
        ed.destroy()
    })

    test('a plain document does claim sorted order (so the fast path is live)', () =>
    {
        const { ed } = makeEditor(['one', 'two', 'three'])
        expect((ed as any).layoutsSortedByY).toBe(true)
        ed.destroy()
    })
})


describe('clipboard fidelity (copy / cut carry what a drag carries)', () =>
{
    /** Fire copy/cut and return what landed on the clipboard, per MIME type. */
    function clip(e: CanvasEditor, type: 'copy' | 'cut'): Record<string, string>
    {
        const got: Record<string, string> = {}
        const ev = new Event(type, { bubbles: true, cancelable: true })
        ;(ev as any).clipboardData = { setData: (t: string, d: string) => { got[t] = d } }
        ;(e as any).textarea.dispatchEvent(ev)
        return got
    }

    function pasteInto(e: CanvasEditor, data: Record<string, string>): void
    {
        const ev = new Event('paste', { bubbles: true, cancelable: true })
        ;(ev as any).clipboardData = { getData: (t: string) => data[t] ?? '' }
        ;(e as any).textarea.dispatchEvent(ev)
    }

    function selectRange(e: CanvasEditor, from: number, to: number): void
    {
        e.dispatch(e.state.tr.setSelection(
            TextSelection.create(e.state.doc, from, to)))
    }

    function boldChars(e: CanvasEditor): number
    {
        let n = 0
        e.state.doc.descendants((node) =>
        {
            if (node.isText && node.marks.some((m) => m.type.name === 'strong'))
                n += node.nodeSize
        })
        return n
    }

    test('copy writes text/html beside text/plain', () =>
    {
        const e = paragraphEditor([schema.text('plain '), mtext('BOLD', 'strong')])
        selectRange(e, 1, e.state.doc.content.size - 1)
        const got = clip(e, 'copy')
        // The MIME type is the whole point: asserting only the payload is how
        // an html-less copy passed for as long as it did.
        expect(Object.keys(got).sort()).toEqual(['text/html', 'text/plain'])
        expect(got['text/plain']).toBe('plain BOLD')
        e.destroy()
    })

    test('the html carries the mark through the schema toDOM', () =>
    {
        const e = paragraphEditor([schema.text('plain '), mtext('BOLD', 'strong')])
        selectRange(e, 1, e.state.doc.content.size - 1)
        expect(clip(e, 'copy')['text/html']).toContain('<strong>BOLD</strong>')
        e.destroy()
    })

    test('copy -> paste inside the editor keeps the mark', () =>
    {
        const e = paragraphEditor([schema.text('plain '), mtext('BOLD', 'strong')])
        selectRange(e, 1, e.state.doc.content.size - 1)
        const before = boldChars(e)
        expect(before).toBe(4)

        const got = clip(e, 'copy')
        selectRange(e, 1, e.state.doc.content.size - 1)
        pasteInto(e, got)
        // Went through plain text before this: the round-trip returned 0.
        expect(boldChars(e)).toBe(before)
        e.destroy()
    })

    test('cut carries both flavours and removes the text', () =>
    {
        const e = paragraphEditor([schema.text('a'), mtext('B', 'strong')])
        selectRange(e, 1, e.state.doc.content.size - 1)
        const got = clip(e, 'cut')
        expect(got['text/html']).toContain('<strong>B</strong>')
        expect(e.state.doc.textBetween(0, e.state.doc.content.size, '')).toBe('')
        e.destroy()
    })

    test('a selection spanning two blocks records its open depths', () =>
    {
        const { ed } = makeEditor(['hello', 'world'])
        selectRange(ed, 3, 10)                 // inside p1 .. inside p2
        const html = clip(ed, 'copy')['text/html']
        expect(html).toContain('data-pm-slice="1 1 []"')
        ed.destroy()
    })

    test('an inline-only selection is not stamped — 0/0 is already the default', () =>
    {
        const e = paragraphEditor([schema.text('hello')])
        selectRange(e, 2, 4)
        expect(clip(e, 'copy')['text/html']).not.toContain('data-pm-slice')
        e.destroy()
    })

    test('a cross-block copy pasted back over itself leaves the document alone', () =>
    {
        const { ed } = makeEditor(['hello', 'world'])
        const json = JSON.stringify(ed.state.doc.toJSON())
        selectRange(ed, 3, 10)
        const got = clip(ed, 'copy')
        selectRange(ed, 3, 10)
        pasteInto(ed, got)
        // The open depths are what make this hold: pasted as a closed slice,
        // the two half-paragraphs arrive as whole new blocks instead.
        expect(JSON.stringify(ed.state.doc.toJSON())).toBe(json)
        ed.destroy()
    })

    test('a cell selection stays plain-text only', () =>
    {
        const cell = (t: string) => schema.node('table_cell', null, [
            schema.node('paragraph', null, [schema.text(t)]),
        ])
        const doc = schema.node('doc', null, [
            schema.node('table', null, [
                schema.node('table_row', null, [cell('a'), cell('b')]),
            ]),
        ])
        const container = document.createElement('div')
        document.body.appendChild(container)
        const e = new CanvasEditor({ state: EditorState.create({ doc, schema }), container })
        const cellPos: number[] = []
        e.state.doc.descendants((n, pos) =>
        {
            if (n.type.name === 'table_cell') cellPos.push(pos)
        })
        const sel = CellSelection.between(
            e.state.doc, cellPos[0]! + 1, cellPos[1]! + 1)
        expect(sel).toBeTruthy()
        e.dispatch(e.state.tr.setSelection(sel!))

        const got = clip(e, 'copy')
        // Bare <td>s are unplaceable without the table around them, so cells
        // keep the plain-text payload until table clipboard lands properly.
        expect(Object.keys(got)).toEqual(['text/plain'])
        e.destroy()
    })

    test('a nonsense data-pm-slice does not fail the paste', () =>
    {
        const e = paragraphEditor([schema.text('abc')])
        selectRange(e, 2, 2)
        pasteInto(e, { 'text/html': '<p data-pm-slice="9 9 []">X</p>' })
        // Impossible depths fall back to what the parser worked out.
        expect(e.state.doc.textBetween(0, e.state.doc.content.size, ' ')).toContain('X')
        e.destroy()
    })
})


describe('IME composition preview', () =>
{
    function fire(e: CanvasEditor, type: string, data: string | null): void
    {
        const ev = new Event(type, { bubbles: true, cancelable: true })
        ;(ev as any).data = data
        ;(e as any).textarea.dispatchEvent(ev)
    }

    /** Start a composition and feed it one revision. */
    function compose(e: CanvasEditor, text: string): void
    {
        fire(e, 'compositionstart', null)
        fire(e, 'compositionupdate', text)
    }

    const JP = 'にほん'          // 3 chars → 24px in the mock metric

    test('the in-flight string is painted at the caret', () =>
    {
        const e = paragraphEditor([schema.text('hi')])
        e.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, 3)))
        compose(e, JP)
        const { text } = recordPaint(e)
        const preview = text.find((t) => t.text === JP)
        // Nothing was drawn at all before this — the composition lived in a
        // 1px transparent textarea until it committed.
        expect(preview).toBeTruthy()
        expect(preview!.x).toBe(16)                     // after 'hi'
        e.destroy()
    })

    test('the caret sits after the preview, not under it', () =>
    {
        const e = paragraphEditor([schema.text('hi')])
        e.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, 3)))
        compose(e, JP)
        const { rects } = recordPaint(e)
        const caret = rects.find((r) => r.fill === '#a5b4fc' && r.h > 1)
        expect(caret).toBeTruthy()
        expect(caret!.x).toBe(16 + 24)                  // past the composition
        e.destroy()
    })

    test('the IME anchor follows the end of the preview', () =>
    {
        const e = paragraphEditor([schema.text('hi')])
        e.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, 3)))
        compose(e, JP)
        recordPaint(e)
        // The candidate window tracks the textarea, so it belongs under the
        // end of what is being composed.
        expect((e as any).textarea.style.transform).toContain('translate(40px')
        e.destroy()
    })

    test('the preview is underlined, the way uncommitted text always is', () =>
    {
        const e = paragraphEditor([schema.text('hi')])
        e.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, 3)))
        compose(e, JP)
        const { rects } = recordPaint(e)
        const underline = rects.find((r) => r.h === 1 && r.w === 24 && r.x === 16)
        expect(underline).toBeTruthy()
        e.destroy()
    })

    test('a backdrop goes down first, so the preview occludes rather than blends', () =>
    {
        const e = paragraphEditor([schema.text('hi')])
        e.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, 3)))
        compose(e, JP)
        const { rects, text } = recordPaint(e)
        const backdrop = rects.findIndex((r) => r.x === 16 && r.w === 24 && r.h > 1)
        const glyphs = text.findIndex((t) => t.text === JP)
        expect(backdrop).toBeGreaterThanOrEqual(0)
        expect(glyphs).toBeGreaterThanOrEqual(0)
        e.destroy()
    })

    test('a commit replaces the preview with real content', () =>
    {
        const e = paragraphEditor([schema.text('hi')])
        e.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, 3)))
        compose(e, JP)
        fire(e, 'compositionend', JP)
        expect(e.state.doc.textBetween(0, e.state.doc.content.size, '')).toBe('hi' + JP)
        const { text } = recordPaint(e)
        // Painted once, as laid-out document text — not twice, with a preview
        // still floating over it.
        expect(text.filter((t) => t.text.includes(JP)).length).toBe(1)
        e.destroy()
    })

    test('a cancelled composition leaves nothing behind', () =>
    {
        const e = paragraphEditor([schema.text('hi')])
        e.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, 3)))
        compose(e, JP)
        fire(e, 'compositionend', '')
        expect(e.state.doc.textBetween(0, e.state.doc.content.size, '')).toBe('hi')
        const { text } = recordPaint(e)
        expect(text.find((t) => t.text === JP)).toBeUndefined()
        e.destroy()
    })

    test('nothing is painted when no composition is in flight', () =>
    {
        const e = paragraphEditor([schema.text('hi')])
        const { rects } = recordPaint(e)
        expect(rects.find((r) => r.h === 1 && r.w === 24)).toBeUndefined()
        e.destroy()
    })

    test('a composition in a heading is drawn at the heading size', () =>
    {
        const doc = schema.node('doc', null, [
            schema.node('heading', { level: 1 }, [schema.text('T')]),
        ])
        const container = document.createElement('div')
        document.body.appendChild(container)
        const e = new CanvasEditor({ state: EditorState.create({ doc, schema }), container })
        e.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, 2)))
        compose(e, JP)
        const { text } = recordPaint(e)
        const heading = text.find((t) => t.text === 'T')
        const preview = text.find((t) => t.text === JP)
        expect(preview).toBeTruthy()
        // The block's own font, not the editor's base one.
        expect(preview!.font).toBe(heading!.font)
        e.destroy()
    })
})
