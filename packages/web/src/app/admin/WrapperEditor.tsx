"use client";
// The §12 HTML message wrapper WYSIWYG (TipTap). True rich-text editing — headings, bold/
// italic/underline/strike, lists, links, alignment, text color — with a responsive,
// wrap-friendly toolbar so it stays usable in the mobile viewport. The [SYSTEM MESSAGE]
// placeholder is plain text in the document; an Insert button adds it where the cursor is.
// Loaded lazily (nextDynamic, ssr:false) — TipTap stays out of the admin route's initial bundle.
import { useEffect, useRef } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TextAlign from "@tiptap/extension-text-align";
import { TextStyle } from "@tiptap/extension-text-style";
import { Color } from "@tiptap/extension-color";
import { EMAIL_WRAPPER_PLACEHOLDER } from "@skilly/shared/email-template";

function ToolButton({ label, active, disabled, onClick, children }: { label: string; active?: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      // onMouseDown preventDefault keeps the editor selection (and the mobile keyboard) alive.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`facet${active ? " facet-on" : ""}`}
      style={{ minWidth: 34, padding: "6px 9px", fontSize: 13, lineHeight: 1 }}
    >
      {children}
    </button>
  );
}

function setLink(editor: Editor) {
  const prev = (editor.getAttributes("link").href as string | undefined) ?? "";
  const url = window.prompt("Link URL (https://…)", prev);
  if (url === null) return; // cancelled
  if (url === "") {
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
    return;
  }
  editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
}

export default function WrapperEditor({ value, onChange, disabled }: { value: string; onChange: (html: string) => void; disabled?: boolean }) {
  const lastEmitted = useRef(value);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false } }),
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      TextStyle,
      Color,
    ],
    content: value,
    editable: !disabled,
    // Next.js SSR: render nothing on the server, hydrate the editor client-side.
    immediatelyRender: false,
    onUpdate: ({ editor: e }) => {
      lastEmitted.current = e.getHTML();
      onChange(lastEmitted.current);
    },
  });

  // Adopt external value changes (e.g. the server's sanitized HTML after a save) without
  // clobbering in-progress typing: only reset when the change didn't originate here.
  useEffect(() => {
    if (editor && value !== lastEmitted.current) {
      lastEmitted.current = value;
      editor.commands.setContent(value);
    }
  }, [editor, value]);

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  if (!editor) return <div className="skeleton" style={{ height: 220, borderRadius: "var(--radius-sm)" }} />;

  const colors: { c: string; label: string }[] = [
    { c: "", label: "Default" },
    { c: "#082773", label: "Navy" },
    { c: "#14ABE3", label: "Cyan" },
    { c: "#888888", label: "Grey" },
  ];

  return (
    <div className="wrapper-editor" style={{ border: "1px solid var(--line)", borderRadius: "var(--radius-sm)", background: "var(--surface)" }}>
      <style>{`
        .wrapper-editor .ProseMirror { min-height: 180px; padding: 12px 14px; outline: none; font-size: 14px; line-height: 1.55; }
        .wrapper-editor .ProseMirror p { margin: 0 0 0.6em; }
        .wrapper-editor .ProseMirror a { color: var(--accent); }
      `}</style>
      <div role="toolbar" aria-label="Formatting" style={{ display: "flex", flexWrap: "wrap", gap: 4, padding: 8, borderBottom: "1px solid var(--line)" }}>
        <ToolButton label="Heading 2" active={editor.isActive("heading", { level: 2 })} disabled={disabled} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>H2</ToolButton>
        <ToolButton label="Heading 3" active={editor.isActive("heading", { level: 3 })} disabled={disabled} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>H3</ToolButton>
        <ToolButton label="Bold" active={editor.isActive("bold")} disabled={disabled} onClick={() => editor.chain().focus().toggleBold().run()}><b>B</b></ToolButton>
        <ToolButton label="Italic" active={editor.isActive("italic")} disabled={disabled} onClick={() => editor.chain().focus().toggleItalic().run()}><i>I</i></ToolButton>
        <ToolButton label="Underline" active={editor.isActive("underline")} disabled={disabled} onClick={() => editor.chain().focus().toggleUnderline().run()}><u>U</u></ToolButton>
        <ToolButton label="Strikethrough" active={editor.isActive("strike")} disabled={disabled} onClick={() => editor.chain().focus().toggleStrike().run()}><s>S</s></ToolButton>
        <ToolButton label="Bullet list" active={editor.isActive("bulletList")} disabled={disabled} onClick={() => editor.chain().focus().toggleBulletList().run()}>••</ToolButton>
        <ToolButton label="Numbered list" active={editor.isActive("orderedList")} disabled={disabled} onClick={() => editor.chain().focus().toggleOrderedList().run()}>1.</ToolButton>
        <ToolButton label="Link" active={editor.isActive("link")} disabled={disabled} onClick={() => setLink(editor)}>🔗</ToolButton>
        <ToolButton label="Align left" active={editor.isActive({ textAlign: "left" })} disabled={disabled} onClick={() => editor.chain().focus().setTextAlign("left").run()}>⯇</ToolButton>
        <ToolButton label="Align center" active={editor.isActive({ textAlign: "center" })} disabled={disabled} onClick={() => editor.chain().focus().setTextAlign("center").run()}>≡</ToolButton>
        <ToolButton label="Align right" active={editor.isActive({ textAlign: "right" })} disabled={disabled} onClick={() => editor.chain().focus().setTextAlign("right").run()}>⯈</ToolButton>
        <span className="select-wrap" style={{ display: "inline-flex" }}>
          <select
            aria-label="Text color"
            disabled={disabled}
            value={(editor.getAttributes("textStyle").color as string | undefined) ?? ""}
            onChange={(e) => (e.target.value ? editor.chain().focus().setColor(e.target.value).run() : editor.chain().focus().unsetColor().run())}
            style={{ padding: "5px 8px", borderRadius: "var(--radius-sm)", border: "1px solid var(--line)", background: "var(--surface)", color: "var(--ink)", fontSize: 12 }}
          >
            {colors.map((o) => (
              <option key={o.label} value={o.c}>{o.label}</option>
            ))}
          </select>
        </span>
        <span style={{ flex: 1 }} />
        <ToolButton label={`Insert ${EMAIL_WRAPPER_PLACEHOLDER}`} disabled={disabled} onClick={() => editor.chain().focus().insertContent(EMAIL_WRAPPER_PLACEHOLDER).run()}>
          <span className="mono" style={{ fontSize: 11 }}>{EMAIL_WRAPPER_PLACEHOLDER}</span>
        </ToolButton>
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}
