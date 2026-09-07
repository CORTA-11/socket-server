import { TiptapTransformer } from "@hocuspocus/transformer";
import { generateJSON } from "@tiptap/html";
import StarterKit from "@tiptap/starter-kit";
import { applyUpdate, Doc, encodeStateAsUpdate } from "yjs";

const extensions = [StarterKit];

export function initializeDocument(title: string, bodyHTML: string): Doc {
  const document = TiptapTransformer.toYdoc({
    type: "doc",
    content: [{ type: "paragraph", content: title === "" ? [] : [{ type: "text", text: title }] }],
  }, "title", extensions);
  if (bodyHTML !== "") {
    const body = TiptapTransformer.toYdoc(
      generateJSON(bodyHTML, extensions),
      "body",
      extensions,
    );
    applyUpdate(document, encodeStateAsUpdate(body));
  }
  return document;
}
