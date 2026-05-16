/**
 * 轻量类型守卫，供 runner 输入校验复用。
 * Minimal record guard reused by runner input normalization.
 */

/** 判断是否为普通对象 / True when value is a non-null object */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
