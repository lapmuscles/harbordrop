import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";

/** Markdown → 已消毒的 HTML（markdown-it 不允許原始 HTML，再經 DOMPurify） */
const md: MarkdownIt = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  highlight(code, lang) {
    try {
      if (lang && hljs.getLanguage(lang)) return `<pre class="hljs"><code>${hljs.highlight(code, { language: lang, ignoreIllegals: true }).value}</code></pre>`;
    } catch {}
    return `<pre class="hljs"><code>${md.utils.escapeHtml(code)}</code></pre>`;
  },
});

// 外部連結另開新分頁並加 noopener
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && /^https?:/i.test(node.getAttribute("href") ?? "")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

export function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(md.render(text));
}

export function highlightCode(code: string, lang?: string): string {
  if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  if (code.length > 200_000) return md.utils.escapeHtml(code);
  return hljs.highlightAuto(code).value;
}

export const sanitizeHtml = (html: string) => DOMPurify.sanitize(html);
