/**
 * Document structure: what kind of block a node is, and how the document tree
 * flattens into the linear list layout walks.
 *
 * These were filed under "Painting" in editor.ts, but nothing here paints —
 * `collectBlocks` is the front half of `computeLayout`, and the `is*` helpers
 * are the schema-name sniffing that keeps the editor schema-agnostic (a
 * consumer may name their list `bullet_list` or `bulletList`; both are honored).
 *
 * Kept as free functions rather than methods: they depend on the document and,
 * in one case, on which node types have a node view — nothing else about the
 * editor. That makes them the natural place to start reading how layout works.
 */

import type { Node as PMNode } from 'prosemirror-model'
import type { BlockDesc } from '../types'
import { LIST_INDENT, MARKER_PAD } from '../constants'

/** Whether a node type name has a registered node view. */
export type HasNodeView = (typeName: string) => boolean

export function isRuleNode(node: PMNode): boolean
{
    const n = node.type.name
    return n === 'horizontal_rule' || n === 'hr'
}

export function isListNode(node: PMNode): boolean
{
    const n = node.type.name
    return n === 'bullet_list' || n === 'ordered_list'
        || n === 'bulletList' || n === 'orderedList'
}

export function isOrderedList(node: PMNode): boolean
{
    const n = node.type.name
    return n === 'ordered_list' || n === 'orderedList'
}

/** A non-textblock the editor reserves space for: a node view, or a rule. */
export function isLeafBlock(node: PMNode, hasNodeView: HasNodeView): boolean
{
    return !node.isTextblock && (hasNodeView(node.type.name) || isRuleNode(node))
}

/**
 * Flatten the document tree into block descriptors in document order. Lists
 * recurse: each item's blocks carry a per-level indent, and the item's first
 * block gets the bullet/number marker. Non-list containers recurse without
 * indent. The flat (no-list) case yields exactly the top-level blocks.
 */
export function collectBlocks(
    node: PMNode,
    contentStart: number,
    depth: number,
    marker: BlockDesc['marker'],
    out: BlockDesc[],
    hasNodeView: HasNodeView,
): void
{
    let pending = marker
    node.forEach((child, offset) =>
    {
        const pos = contentStart + offset
        if (isListNode(child))
        {
            const ordered = isOrderedList(child)
            let n = ordered
                ? ((child.attrs['order'] as number) ?? (child.attrs['start'] as number) ?? 1)
                : 0
            const markerX = depth * LIST_INDENT + MARKER_PAD
            child.forEach((item, itemOffset) =>
            {
                const itemPos = pos + 1 + itemOffset
                const text = ordered ? `${n}.` : '•'
                collectBlocks(item, itemPos + 1, depth + 1, { text, x: markerX }, out, hasNodeView)
                n++
            })
            pending = null
        }
        else if (child.isTextblock)
        {
            out.push({ node: child, pos, indent: depth * LIST_INDENT, marker: pending, leaf: false })
            pending = null
        }
        else if (isLeafBlock(child, hasNodeView))
        {
            out.push({ node: child, pos, indent: depth * LIST_INDENT, marker: pending, leaf: true })
            pending = null
        }
        else if (child.isBlock)
        {
            // A generic block container (e.g. nesting blockquote): descend.
            collectBlocks(child, pos + 1, depth, pending, out, hasNodeView)
            pending = null
        }
    })
}

/** True when the document is a single empty text block. */
export function isDocEmpty(doc: PMNode): boolean
{
    return doc.childCount === 1
        && !!doc.firstChild?.isTextblock
        && doc.firstChild.content.size === 0
}
