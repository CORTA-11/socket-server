import assert from "node:assert/strict";
import { test } from "node:test";

import { TiptapTransformer } from "@hocuspocus/transformer";
import StarterKit from "@tiptap/starter-kit";
import { applyUpdate, encodeStateAsUpdate } from "yjs";

import { materializeDocument } from "../src/projections.js";

test("title and rich-text body projections are derived from their named Yjs fields", () => {
  const document = TiptapTransformer.toYdoc(tiptapDocument("Research notes"), "title", [StarterKit]);
  const body = TiptapTransformer.toYdoc({
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Results" }] },
      { type: "paragraph", content: [{ type: "text", marks: [{ type: "bold" }], text: "Converged" }] },
    ],
  }, "body", [StarterKit]);
  applyUpdate(document, encodeStateAsUpdate(body));

  assert.deepEqual(materializeDocument(document), {
    title: "Research notes",
    bodyHTML: "<h2>Results</h2><p><strong>Converged</strong></p>",
  });
});

function tiptapDocument(text: string) {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}
