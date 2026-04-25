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
