import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { WIKILINK_RE, normTitle } from "./wikiLinks";

/**
 * Highlights [[links]] inside the sheet and opens them with Ctrl+click (a plain click must keep placing the caret).
 * `resolve(title)` tells whether the target note exists so unresolved links get a different style.
 */
export const WikiLinks = (opts: { resolve: (title: string) => boolean; open: (title: string) => void }) =>
  Extension.create({
    name: "wikiLinks",
    addProseMirrorPlugins() {
      const key = new PluginKey("wikiLinks");
      return [new Plugin({
        key,
        state: {
          init: () => DecorationSet.empty,
          apply: (tr, old, _o, state) => {
            if (!tr.docChanged && !tr.getMeta(key) && old !== DecorationSet.empty) return old.map(tr.mapping, tr.doc);
            const decorations: Decoration[] = [];
            state.doc.descendants((node, pos) => {
              if (!node.isText || !node.text) return;
              for (const match of node.text.matchAll(WIKILINK_RE)) {
                const from = pos + (match.index ?? 0);
                const title = match[1].trim();
                decorations.push(Decoration.inline(from, from + match[0].length, {
                  class: opts.resolve(normTitle(title)) ? "wikilink" : "wikilink wikilink-missing",
                  "data-wikilink": title,
                  title: "Ctrl+клик — открыть",
                }));
              }
            });
            return DecorationSet.create(tr.doc, decorations);
          },
        },
        props: {
          decorations(state) { return key.getState(state); },
          handleClick(_view, _pos, event) {
            if (!(event.ctrlKey || event.metaKey)) return false;
            const el = (event.target as HTMLElement | null)?.closest?.("[data-wikilink]");
            const title = el?.getAttribute("data-wikilink");
            if (!title) return false;
            event.preventDefault();
            opts.open(title);
            return true;
          },
        },
      })];
    },
  });
