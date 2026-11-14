import { defineAsyncComponent, type Component } from "vue";
import { CODE_EXT, extOf } from "./util";

/**
 * 預覽元件註冊表（kind 定義見 @harbordrop/shared 的 previewKind）。
 * 元件介面：props { src: string（可直接 GET 的內容 URL，inline）; info: ShareInfo }。
 * 另外 markdown、code 也接受 { text, lang } 直接渲染（文字分享用）。
 * 注意：預覽每次載入都會計入瀏覽次數，故預覽需由使用者點擊才載入。
 */
const registry: Record<string, Component> = {
  image: defineAsyncComponent(() => import("./ImagePreview.vue")),
  video: defineAsyncComponent(() => import("./MediaPreview.vue")),
  audio: defineAsyncComponent(() => import("./MediaPreview.vue")),
  text: defineAsyncComponent(() => import("./TextPreview.vue")),
  pdf: defineAsyncComponent(() => import("./PdfPreview.vue")),
  markdown: defineAsyncComponent(() => import("./MarkdownPreview.vue")),
  code: defineAsyncComponent(() => import("./CodePreview.vue")),
  office: defineAsyncComponent(() => import("./OfficePreview.vue")),
  epub: defineAsyncComponent(() => import("./EpubPreview.vue")),
};

/** 依 kind（與副檔名）挑元件：text 類若副檔名是程式碼則用語法高亮 */
export function previewComponent(kind: string, filename?: string): Component | null {
  if (kind === "text" && filename && CODE_EXT[extOf(filename)]) return registry.code;
  if (kind === "none" && filename && ["csv", "ods"].includes(extOf(filename))) return registry.office;
  return registry[kind] ?? null;
}

export const MarkdownPreview = registry.markdown;
export const CodePreview = registry.code;
