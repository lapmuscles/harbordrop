import type { DriverDefinition } from "./types";
import { huggingfaceDriver } from "./drivers/huggingface";
import { s3Driver } from "./drivers/s3";

/**
 * 渠道註冊表。新增渠道：在 drivers/<type>/index.ts 匯出 DriverDefinition，再加到下方陣列。
 * 預定渠道（尚未實作）：onedrive、gdrive、webdav、local、github、telegram、discord、mirror
 */
export const DRIVERS: DriverDefinition[] = [s3Driver, huggingfaceDriver];

export function getDriverDef(type: string): DriverDefinition | undefined {
  return DRIVERS.find((d) => d.type === type);
}
