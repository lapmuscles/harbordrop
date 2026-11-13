import { defineAsyncComponent, type Component } from "vue";

/**
 * 預覽元件註冊表（kind 定義見 @harbordrop/shared 的 previewKind）。
 * 元件介面：props { src: string（可直接 GET 的內容 URL，inline）; info: ShareInfo }。
 * 預留：markdown、office、epub —— 新增元件後在此註冊即可。
 * 注意：預覽每次載入都會計入瀏覽次數，故預覽需由使用者點擊才載入。
 */
const registry: Record<string, Component> = {
  image: defineAsyncComponent(() => import("./ImagePreview.vue")),
  video: defineAsyncComponent(() => import("./MediaPreview.vue")),
  audio: defineAsyncComponent(() => import("./MediaPreview.vue")),
  text: defineAsyncComponent(() => import("./TextPreview.vue")),
  pdf: defineAsyncComponent(() => import("./PdfPreview.vue")),
};

export function previewComponent(kind: string): Component | null {
  return registry[kind] ?? null;
}
