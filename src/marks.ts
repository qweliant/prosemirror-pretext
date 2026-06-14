/**
 * Optional starter marks + key bindings for a WYSIWYG editor. This layer is
 * convenience, not core: bring your own schema if you prefer. The mark names
 * here (`strong`, `em`, `code`) line up with the default `markStyles` in
 * CanvasEditor, so bold/italic/code render out of the box.
 */
import { type MarkSpec, type Schema } from 'prosemirror-model'
import { type Command } from 'prosemirror-state'
import { toggleMark } from 'prosemirror-commands'

/** Mark specs for bold, italic, and inline code. Spread into your schema. */
export const markSpecs: Record<string, MarkSpec> = {
    strong: {
        toDOM: () => ['strong', 0],
        parseDOM: [
            { tag: 'strong' },
            { tag: 'b' },
            { style: 'font-weight', getAttrs: (v) => /^(bold|[5-9]\d\d)$/.test(v as string) && null },
        ],
    },
    em: {
        toDOM: () => ['em', 0],
        parseDOM: [{ tag: 'em' }, { tag: 'i' }, { style: 'font-style=italic' }],
    },
    code: {
        toDOM: () => ['code', 0],
        parseDOM: [{ tag: 'code' }],
    },
}

/**
 * Bold/italic/code key bindings for any schema that defines the matching
 * marks. Missing marks are skipped, so this is safe on a partial schema.
 * Pass the result as the editor's `keymap` option.
 */
export function buildMarkKeymap(schema: Schema): Record<string, Command>
{
    const keys: Record<string, Command> = {}
    const bind = (key: string, markName: string) =>
    {
        const mark = schema.marks[markName]
        if (mark) keys[key] = toggleMark(mark)
    }
    bind('Mod-b', 'strong')
    bind('Mod-i', 'em')
    bind('Mod-`', 'code')
    return keys
}
