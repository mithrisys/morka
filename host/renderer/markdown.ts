import DOMPurify from "dompurify";
import highlight from "highlight.js/lib/common";
import { Marked } from "marked";
import markedFootnote from "marked-footnote";
import { gfmHeadingId } from "marked-gfm-heading-id";

const markdown = new Marked({ gfm: true, async: false }, gfmHeadingId(), markedFootnote());

DOMPurify.addHook("uponSanitizeAttribute", (node, attribute) => {
  if (attribute.attrName === "class") {
    attribute.keepAttr = node.nodeName === "CODE" && /^language-[\w+-]+$/.test(attribute.attrValue);
  }
});

export function renderMarkdown(body: HTMLElement, text: string, messageId: string) {
  const fragment = DOMPurify.sanitize(markdown.parse(text, { async: false }), {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: [
      "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote",
      "ul", "ol", "li", "pre", "code", "em", "strong", "del", "s", "a", "img",
      "table", "thead", "tbody", "tfoot", "tr", "th", "td", "input", "section",
      "dl", "dt", "dd", "details", "summary", "sup", "sub", "kbd", "mark", "div", "span",
    ],
    ALLOWED_ATTR: ["href", "src", "alt", "title", "id", "class", "start", "align", "type", "checked", "disabled", "open"],
    ALLOW_DATA_ATTR: false,
    ADD_URI_SAFE_ATTR: ["type", "align", "start"],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|#|data:image\/(?:png|jpe?g|gif|webp|avif);base64,)/i,
  });
  const prefix = `message-${messageId}-`;
  for (const element of fragment.querySelectorAll<HTMLElement>("[id]")) element.id = prefix + element.id;
  for (const element of fragment.querySelectorAll<HTMLElement>("[aria-labelledby], [aria-describedby]")) {
    for (const attribute of ["aria-labelledby", "aria-describedby"]) {
      const ids = element.getAttribute(attribute);
      if (ids) element.setAttribute(attribute, ids.split(/\s+/).map(id => prefix + id).join(" "));
    }
  }
  for (const link of fragment.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const href = link.getAttribute("href")!;
    if (href.startsWith("#")) link.setAttribute("href", "#" + prefix + href.slice(1));
    else link.rel = "noreferrer noopener";
  }
  for (const image of fragment.querySelectorAll<HTMLImageElement>("img")) {
    if (!/^(?:https:\/\/|data:image\/(?:png|jpe?g|gif|webp|avif);base64,)/i.test(image.getAttribute("src") ?? "")) {
      image.removeAttribute("src");
    }
    image.loading = "lazy";
    image.referrerPolicy = "no-referrer";
  }
  for (const input of fragment.querySelectorAll<HTMLInputElement>("input")) {
    if (input.type === "checkbox") input.disabled = true;
    else input.remove();
  }
  for (const code of fragment.querySelectorAll<HTMLElement>("pre > code")) {
    const language = code.className.replace(/^language-/, "");
    code.className = `language-${highlight.getLanguage(language) ? language : "plaintext"}`;
    highlight.highlightElement(code);
    code.parentElement!.dir = "ltr";
  }
  for (const table of fragment.querySelectorAll("table")) {
    const scroll = document.createElement("div");
    scroll.className = "markdown-table";
    scroll.tabIndex = 0;
    scroll.setAttribute("role", "region");
    scroll.setAttribute("aria-label", "Table");
    table.replaceWith(scroll);
    scroll.append(table);
  }
  for (const block of fragment.querySelectorAll<HTMLElement>("p, li, h1, h2, h3, h4, h5, h6, th, td, blockquote")) block.dir = "auto";
  body.replaceChildren(fragment);
}
