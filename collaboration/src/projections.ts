import { TiptapTransformer } from "@hocuspocus/transformer";
import { generateText, type JSONContent } from "@tiptap/core";
import { generateHTML } from "@tiptap/html";
import StarterKit from "@tiptap/starter-kit";
import type { Doc } from "yjs";

import type { DocumentProjections } from "./storage.js";

const extensions = [StarterKit];

export function materializeDocument(document: Doc): DocumentProjections {
  const fields = TiptapTransformer.fromYdoc(document, ["title", "body"]) as Record<string, JSONContent>;
  const title = generateText(fields.title ?? emptyDocument(), extensions)
    .replace(/\s+/g, " ")
    .trim();
  return {
    bodyHTML: generateHTML(fields.body ?? emptyDocument(), extensions),
    title,
  };
}

function emptyDocument(): JSONContent {
  return { type: "doc", content: [] };
}
