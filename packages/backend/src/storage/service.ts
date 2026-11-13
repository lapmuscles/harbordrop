import type { Db } from "../db/adapter";
import type { SecretBox } from "../core/crypto";
import { badRequest, notFound } from "../core/errors";
import { getDriverDef } from "./registry";
import type { DriverContext, StorageDriver } from "./types";
import type { StorageDto } from "@harbordrop/shared";

export interface StorageRow {
  id: number;
  name: string;
  type: string;
  config: string;
  secrets: string | null;
  enabled: number;
  is_default: number;
  allow_anonymous_upload: number;
  remark: string | null;
  sort: number;
  created_at: number;
  updated_at: number;
}

/** 儲存設定的讀寫與驅動實例化。機密欄位只在這裡解密 */
export class StorageService {
  private drivers = new Map<number, { stamp: number; driver: StorageDriver }>();
  constructor(
    private db: Db,
    private box: SecretBox,
    private dctx: DriverContext,
  ) {}

  async row(id: number): Promise<StorageRow> {
    const r = await this.db.first<StorageRow>("SELECT * FROM storages WHERE id = ?", [id]);
    if (!r) throw notFound("找不到此儲存");
    return r;
  }

  async list(): Promise<StorageRow[]> {
    return this.db.all<StorageRow>("SELECT * FROM storages ORDER BY sort, id");
  }

  async toDto(r: StorageRow): Promise<StorageDto> {
    const secrets = await this.box.open(r.secrets);
    return {
      id: r.id,
      name: r.name,
      type: r.type,
      config: JSON.parse(r.config),
      secretsSet: Object.keys(secrets).filter((k) => secrets[k] !== "" && secrets[k] != null),
      enabled: !!r.enabled,
      isDefault: !!r.is_default,
      allowAnonymousUpload: !!r.allow_anonymous_upload,
      remark: r.remark,
      sort: r.sort,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  /** 依驅動欄位定義拆成 config（明文）與 secrets（加密）。secret 欄位留空 = 保留舊值 */
  async split(type: string, input: Record<string, unknown>, oldSecretsSealed?: string | null) {
    const def = getDriverDef(type);
    if (!def) throw badRequest(`不支援的儲存類型：${type}`);
    if (def.platforms && !def.platforms.includes(this.dctx.platform)) throw badRequest(`此類型不支援 ${this.dctx.platform} 平台`);
    const config: Record<string, unknown> = {};
    const secrets: Record<string, unknown> = await this.box.open(oldSecretsSealed);
    for (const f of def.fields) {
      const v = input[f.key];
      if (f.type === "secret") {
        if (typeof v === "string" && v !== "") secrets[f.key] = v;
        if (f.required && !secrets[f.key]) throw badRequest(`請填寫「${f.label}」`);
      } else {
        const val = v === undefined || v === "" ? f.default : f.type === "number" ? Number(v) : f.type === "boolean" ? v === true || v === "true" : v;
        if (f.required && (val === undefined || val === "")) throw badRequest(`請填寫「${f.label}」`);
        if (val !== undefined) config[f.key] = val;
      }
    }
    // 先試建驅動，及早回報設定錯誤
    def.create({ ...config, ...secrets }, this.dctx);
    return { config, sealed: await this.box.seal(secrets) };
  }

  async driver(id: number): Promise<StorageDriver> {
    const r = await this.row(id);
    return this.driverFor(r);
  }

  async driverFor(r: StorageRow): Promise<StorageDriver> {
    const cached = this.drivers.get(r.id);
    if (cached && cached.stamp === r.updated_at) return cached.driver;
    const def = getDriverDef(r.type);
    if (!def) throw badRequest(`不支援的儲存類型：${r.type}`);
    const driver = def.create({ ...JSON.parse(r.config), ...(await this.box.open(r.secrets)) }, this.dctx);
    this.drivers.set(r.id, { stamp: r.updated_at, driver });
    return driver;
  }

  invalidate(id: number) {
    this.drivers.delete(id);
  }
}
