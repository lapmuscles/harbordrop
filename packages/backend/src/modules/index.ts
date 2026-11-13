import type { HdModule } from "./types";
import { authModule } from "./auth";
import { settingsModule } from "./settings";
import { storagesModule } from "./storages";
import { uploadsModule } from "./uploads";
import { sharesModule } from "./shares";
import { fsModule } from "./fs";
import { pastesModule } from "./pastes";
import { apikeysModule } from "./apikeys";
import { webdavModule } from "./webdav";
import { fsmetaModule } from "./fsmeta";
import { searchModule } from "./search";
import { backupModule } from "./backup";
import { jobsModule } from "./jobs";
import { tasksModule } from "./tasks";

/** 所有功能模組（順序 = 路由註冊順序；authenticate 依此順序嘗試） */
export const MODULES: HdModule[] = [
  authModule,
  settingsModule,
  storagesModule,
  uploadsModule,
  sharesModule,
  // —— 以下為預留模組（目前回應 501） ——
  apikeysModule,
  fsModule,
  fsmetaModule,
  pastesModule,
  webdavModule,
  searchModule,
  backupModule,
  jobsModule,
  tasksModule,
];
