# Node views: inline atoms & content-holding nodes

Status: **design / feasibility** (not yet implemented). Written 2026-06.

## What exists today

`prosemirror-pretext` already ships **block-level atom node views**:

- Option `nodeViews?: Record<string, NodeViewFn>`, `NodeViewFn = (node, getPos) => HTMLElement`
  (`src/editor.ts`).
- Layout reserves vertical space per atom block (`nodeViewHeights`, `defaultAtomHeight`,
  `BlockLayout.isAtom`), measures the rendered DOM, and positions it over the canvas
  (`syncNodeViews`).
- Atom blocks participate in hit-testing (click → `NodeSelection`) and float-wrap
  (`floatRect` returns a content-space rect; text reflows around it).

What it does **not** have, and what this doc scopes:

1. **Interactive inline DOM node views** — an atom that flows *within* a text line
   (mention chip, inline `@date` picker, inline math) and holds interactive DOM.
2. **Content-holding node views** — a node whose interior is *editable child content*
   laid out by the editor, wrapped in custom chrome (callout, collapsible `<details>`,
   table cell).

## Key correction: Pretext already has the inline-box primitive

Earlier notes assumed inline node views were blocked on Pretext lacking a fixed-width
inline box. **That is wrong.** `@chenglou/pretext/rich-inline`'s `RichInlineItem`
carries exactly this:

```ts
export type RichInlineItem = {
  text: string
  font: string
  letterSpacing?: number
  break?: 'normal' | 'never' // `never` keeps the item atomic, like a pill or mention chip
  extraWidth?: number        // Caller-owned horizontal chrome, e.g. padding + border width
}
```

The source comments name the use case verbatim ("a pill or mention chip"). A fragment's
`occupiedWidth` is "text width plus the item's extraWidth contribution", and `break:
'never'` keeps the item from splitting across a soft-wrap. So an inline atom is just a
`RichInlineItem` with `break: 'never'` and `extraWidth` set to the box chrome — no
Pretext change required.

## Design 1 — Inline atom node views

**Schema.** An inline, atomic node, e.g.
`mention: { inline: true, atom: true, attrs: { id: {} }, ... }`.

**Injection point.** `prepareMarkedSegments` (`src/editor.ts`) walks `node.forEach(child)`
and today only handles `child.isText`. Add an `else if (child.isInline && child.isAtom)`
branch that:

1. `flushRun()` to close the current text run.
2. Push `seg.items.push({ text: label, font, break: 'never', extraWidth: chrome })`
   — `label` is the canvas-drawn text (or `'​'` for a pure DOM box), `chrome` is
   padding+border, or the full box width when there's no text.
3. Push a parallel `seg.meta` entry tagged as an atom (carry the `PMNode` + its
   block-space `pmStart`), so paint/positioning can find the fragment.
4. Advance `offset` by `child.nodeSize` (1), same as the text path.

**Render.** Two modes, reusing existing machinery:
- *Canvas-drawn* (fast, non-interactive: tags, simple chips) — in the marked-line paint
  pass, for atom metas, draw the pill background/border/label at the fragment rect. The
  rect already exists: marked lines map item offsets → x for underline/bg today; the
  fragment's `gapBefore`/`occupiedWidth` give `x` and `width`.
- *Interactive DOM* (date pickers, editable mentions) — register an
  `inlineNodeViews?: Record<string, NodeViewFn>` and position the returned element over
  the canvas at the fragment rect, exactly like `syncNodeViews`/`syncWidgets` do for
  blocks/widgets. Width is fixed (`extraWidth`), so the DOM box and the reserved layout
  box stay in lockstep.

**Selection / caret.** An atom is one position; clicking its rect → `NodeSelection`
(hit-testing already special-cases atoms for blocks — extend to inline fragments).
Backspace deletes the atom (PM default). No caret *inside* the atom.

**Effort:** moderate. One new branch in `prepareMarkedSegments`, one meta variant, one
paint case + one DOM-positioning pass, hit-testing for inline atoms. No Pretext change,
no cache-model change. ~Comparable to the decorations work.

## Design 2 — Content-holding node views

These hold **editable children** laid out by the editor, inside custom chrome.

**The good news:** the recursion already exists. `blockquote` and lists nest child
blocks with an indent and paint a border/marker at paint time. A callout/`<details>`/
table-cell is "blockquote-like nesting + a registered chrome renderer."

**What's missing** is a registration API to, for an arbitrary node type:
- Reserve an inset (top/right/bottom/left) for chrome — header bar, padding, border.
- Paint that chrome (canvas) and/or mount an interactive DOM overlay (collapse toggle,
  callout-type dropdown) positioned at the node's rect, like a block node view but with
  the child region laid out *inside* it rather than replaced by it.
- Optionally make it collapsible (skip laying out children, reserve only the header).

This is **not** a `contentDOM` (there is no DOM content — children are canvas-laid-out
blocks). It's "recurse into children with an inset + chrome callback."

**Effort:** larger than inline atoms — touches the block-layout recursion and the
node-view positioning to support a node that both *contains laid-out children* and
*owns chrome*. The float/indent/decoration plumbing covers most of the geometry; the new
surface is the chrome-inset registration + interior recursion hook.

## Recommendation / order

1. **Inline atom node views first.** The Pretext primitive exists, the block-atom node
   view is a working template, and it's the more common ask (mentions, chips, inline
   widgets). Ship canvas-drawn pills + an `inlineNodeViews` DOM-overlay mode.
2. **Content-holding node views second.** Higher leverage for docs-style content
   (callouts, toggles, tables) but a deeper change to layout recursion.

Neither needs a Pretext change. Both reuse the existing DOM-overlay positioning
(`syncNodeViews`/`syncWidgets`) and offset→x mapping.
