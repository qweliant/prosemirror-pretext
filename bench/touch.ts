// Manual/automated harness for the touch input layer (tap, long-press, handles).
// Served by vite.bench.config; imports the editor from ../src so it runs the
// working tree, not the published package.
import { Schema } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import { CanvasEditor } from "../src/index";

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*", toDOM: () => ["p", 0], parseDOM: [{ tag: "p" }] },
    text: { inline: true },
  },
});

const doc = schema.node("doc", null, [
  schema.node("paragraph", null, [schema.text("The quick brown fox jumps over the lazy dog.")]),
  schema.node("paragraph", null, [schema.text("Second paragraph with several selectable words here.")]),
  schema.node("paragraph", null, [schema.text("Third line for good measure and vertical room.")]),
]);

const host = document.getElementById("host")!;
const out = document.getElementById("out")!;

let editor: CanvasEditor | undefined;
function report() {
  if (!editor) return;
  const s = editor.state.selection;
  const handles = (editor as unknown as { selHandles: { from: HTMLElement; to: HTMLElement } | null }).selHandles;
  out.textContent = JSON.stringify({
    from: s.from,
    to: s.to,
    empty: s.empty,
    selText: editor.state.doc.textBetween(s.from, s.to, " "),
    handlesVisible: handles ? handles.from.style.display !== "none" : false,
  });
}

editor = new CanvasEditor({
  state: EditorState.create({ doc, schema }),
  container: host,
  width: 340,
  font: "18px Georgia, serif",
  lineHeight: 28,
  autofocus: false,
  onRender: () => report(),
});
report();

// Expose for the driver.
(window as unknown as { ed: CanvasEditor; report: () => void }).ed = editor;
(window as unknown as { report: () => void }).report = report;
