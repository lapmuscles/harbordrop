/** 統一錯誤：code 供前端判斷，message 為正體中文可直接顯示 */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
export const badRequest = (msg: string, code = "bad_request", details?: unknown) => new HttpError(400, code, msg, details);
export const unauthorized = (msg = "請先登入", code = "unauthorized") => new HttpError(401, code, msg);
export const forbidden = (msg = "沒有權限", code = "forbidden") => new HttpError(403, code, msg);
export const notFound = (msg = "找不到資源", code = "not_found") => new HttpError(404, code, msg);
export const conflict = (msg: string, code = "conflict") => new HttpError(409, code, msg);
export const gone = (msg: string, code = "gone") => new HttpError(410, code, msg);
export const notImplemented = (feature: string) => new HttpError(501, "not_implemented", `「${feature}」尚未實作`);
