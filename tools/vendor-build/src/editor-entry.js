// tools\vendor-build\src\editor-entry.js
// Ο WYSIWYG editor άρθρων (Tiptap): ο χρήστης βλέπει το άρθρο όπως θα φανεί, και ο editor αποθηκεύει Markdown.
// Η σελίδα φτιάχνει ΜΟΝΗ της τη γραμμή κουμπιών (ελληνικές ετικέτες, 44px) και μιλά με τον editor μόνο μέσω αυτού του μικρού API.
import { Editor, Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import Image from "@tiptap/extension-image";
import { TableKit } from "@tiptap/extension-table";

const LINK_OK = /^(https?:\/\/|mailto:)/i;
const IMAGE_FILE = /^image\/(png|jpe?g|gif|webp)$/;

// Επικόλληση και σύρσιμο αρχείων εικόνας: περνούν από δικό μας σημείο (στη Φάση 2 εδώ γίνεται η αποστολή στον server).
// Επιτρέπονται μόνο png, jpeg, gif, webp: το SVG ΔΕΝ περνά ποτέ (μπορεί να φέρει κώδικα).
function filesOf(dt) { return Array.from((dt && dt.files) || []).filter((f) => IMAGE_FILE.test(f.type)); }
const ImageFiles = Extension.create({
  name: "imageFiles",
  addOptions() { return { onFiles: null }; },
  addProseMirrorPlugins() {
    const opts = this.options;
    return [new Plugin({ props: {
      handlePaste(view, event) {
        const files = filesOf(event.clipboardData);
        if (!files.length || !opts.onFiles) return false;
        event.preventDefault(); opts.onFiles(files, view.state.selection.from); return true;
      },
      handleDrop(view, event) {
        const files = filesOf(event.dataTransfer);
        if (!files.length || !opts.onFiles) return false;
        event.preventDefault();
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
        opts.onFiles(files, at ? at.pos : view.state.selection.from); return true;
      },
      // Εικόνες μέσα σε επικολλημένο HTML (Google Docs, ιστοσελίδες) δεν μπαίνουν ποτέ: ούτε απομακρυσμένες ούτε base64.
      transformPastedHTML(html) { return html.replace(/<img\b[^>]*>/gi, ""); },
    } })];
  },
});

function stateOf(editor) {
  const link = editor.getAttributes("link");
  return {
    bold: editor.isActive("bold"), italic: editor.isActive("italic"),
    h2: editor.isActive("heading", { level: 2 }), h3: editor.isActive("heading", { level: 3 }),
    bulletList: editor.isActive("bulletList"), orderedList: editor.isActive("orderedList"), blockquote: editor.isActive("blockquote"),
    link: editor.isActive("link"), linkHref: link && link.href ? link.href : null,
    table: editor.isActive("table"),
    canUndo: editor.can().undo(), canRedo: editor.can().redo(),
  };
}

const COMMANDS = {
  bold: (c) => c.toggleBold(), italic: (c) => c.toggleItalic(),
  h2: (c) => c.toggleHeading({ level: 2 }), h3: (c) => c.toggleHeading({ level: 3 }),
  bulletList: (c) => c.toggleBulletList(), orderedList: (c) => c.toggleOrderedList(), blockquote: (c) => c.toggleBlockquote(),
  table: (c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }),
  tableAddRow: (c) => c.addRowAfter(), tableAddCol: (c) => c.addColumnAfter(),
  tableDelRow: (c) => c.deleteRow(), tableDelCol: (c) => c.deleteColumn(), tableDelete: (c) => c.deleteTable(),
  undo: (c) => c.undo(), redo: (c) => c.redo(),
  unsetLink: (c) => c.extendMarkRange("link").unsetLink(),
};

function create(host, opts) {
  opts = opts || {};
  const editor = new Editor({
    element: host,
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, autolink: true, protocols: ["http", "https", "mailto"], isAllowedUri: (url) => LINK_OK.test(url), HTMLAttributes: { rel: "noopener noreferrer nofollow", target: "_blank" } } }),
      Markdown.configure({ markedOptions: { gfm: true, breaks: true } }), // breaks: τα παλιά έγγραφα (σκέτο κείμενο) κρατούν τις αλλαγές γραμμής
      Image.configure({ inline: false, allowBase64: false }),
      TableKit,
      ImageFiles.configure({ onFiles: opts.onImageFiles || null }),
    ],
    content: opts.markdown || "",
    contentType: "markdown",
    editorProps: { attributes: { class: "prose rte-surface", role: "textbox", "aria-multiline": "true", "aria-label": opts.ariaLabel || "Κείμενο", spellcheck: "true", lang: "el" } },
    onUpdate: () => { if (opts.onChange) opts.onChange(); },
  });
  const notify = () => { if (opts.onState) opts.onState(stateOf(editor)); };
  editor.on("transaction", notify);
  notify();
  return {
    getMarkdown() { return editor.getMarkdown(); },
    setMarkdown(md) { editor.commands.setContent(md || "", { contentType: "markdown", emitUpdate: false }); notify(); },
    focus() { editor.commands.focus(); },
    destroy() { editor.destroy(); },
    state() { return stateOf(editor); },
    exec(name) { const make = COMMANDS[name]; if (!make) return false; return make(editor.chain().focus()).run(); },
    // Σύνδεσμος: ΜΟΝΟ http, https, mailto. Επιστρέφει {ok:false} για οτιδήποτε άλλο (π.χ. javascript:).
    setLink(url) {
      const u = String(url || "").trim();
      if (!LINK_OK.test(u)) return { ok: false };
      return { ok: editor.chain().focus().extendMarkRange("link").setLink({ href: u }).run() };
    },
    insertImage(src, alt) { return editor.chain().focus().setImage({ src, alt: alt || "" }).run(); },
    isEmpty() { return editor.isEmpty; },
    selectAll() { return editor.commands.selectAll(); },
    version: 1,
  };
}

globalThis.IdmonEditor = { create, version: 1 };
