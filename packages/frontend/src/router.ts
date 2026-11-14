import { createRouter, createWebHistory } from "vue-router";
import { session, refreshSession } from "./api";

/**
 * 路由表。預留路徑（由對應模組實作頁面）：
 *   /fs/:path*      檔案瀏覽器（fs 模組）
 *   /p/:slug        文字分享（pastes 模組）
 *   /admin/mounts、/admin/api-keys、/admin/fs-meta、/admin/backup、/admin/jobs、/admin/tasks
 */
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", component: () => import("./pages/UploadPage.vue") },
    { path: "/login", component: () => import("./pages/LoginPage.vue") },
    { path: "/f/:slug", component: () => import("./pages/SharePage.vue") },
    { path: "/p/:slug", component: () => import("./pages/PastePage.vue") },
    { path: "/paste", component: () => import("./pages/PasteNewPage.vue") },
    // feat/files-ui
    { path: "/files/:path*", component: () => import("./pages/FilesPage.vue") },
    { path: "/fs/:path*", redirect: (to) => ({ path: to.fullPath.replace(/^\/fs/, "/files") }) },
    {
      path: "/admin",
      component: () => import("./pages/admin/AdminLayout.vue"),
      meta: { admin: true },
      children: [
        { path: "", component: () => import("./pages/admin/DashboardPage.vue") },
        { path: "storages", component: () => import("./pages/admin/StoragesPage.vue") },
        { path: "shares", component: () => import("./pages/admin/SharesPage.vue") },
        { path: "pastes", component: () => import("./pages/admin/PastesPage.vue") },
        { path: "settings", component: () => import("./pages/admin/SettingsPage.vue") },
        // feat/files-ui
        { path: "mounts", component: () => import("./pages/admin/MountsPage.vue") },
        { path: "fs-meta", component: () => import("./pages/admin/FsMetaPage.vue") },
        { path: "tasks", component: () => import("./pages/admin/TasksPage.vue") },
        // --- feat/admin-ui ---
        { path: "api-keys", component: () => import("./pages/admin/ApiKeysPage.vue") },
        { path: "account", component: () => import("./pages/admin/AccountPage.vue") },
        { path: "backup", component: () => import("./pages/admin/BackupPage.vue") },
        { path: "jobs", component: () => import("./pages/admin/JobsPage.vue") },
        // --- end feat/admin-ui ---
      ],
    },
    { path: "/:pathMatch(.*)*", component: () => import("./pages/NotFound.vue") },
  ],
});

router.beforeEach(async (to) => {
  if (!session.me) await refreshSession().catch(() => {});
  if (to.matched.some((r) => r.meta.admin) && session.me?.kind !== "admin") return { path: "/login", query: { next: to.fullPath } };
});
