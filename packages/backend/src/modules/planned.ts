import type { HdModule } from "./types";
import { notImplemented } from "../core/errors";

/**
 * 預留模組：路由前綴已保留並回應 501。實作時把 modules/<name>/index.ts 換成真正的 HdModule 即可，
 * 不需改動其他檔案。
 */
export function plannedModule(name: string, label: string, prefixes: string[]): HdModule {
  return {
    name,
    routes(app) {
      for (const p of prefixes) {
        app.all(p, () => {
          throw notImplemented(label);
        });
        app.all(`${p}/*`, () => {
          throw notImplemented(label);
        });
      }
    },
  };
}
