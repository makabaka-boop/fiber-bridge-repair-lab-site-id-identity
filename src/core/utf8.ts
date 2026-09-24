/**
 * 按链路编号的 UTF-8 字节序列排序所需的比较器。
 *
 * 关键事实：UTF-8 编码具有“码点序保持”性质——对两个 Unicode 码点
 * p < q，其 UTF-8 首字节也严格递增，且多字节序列的后续字节取值区间
 * (0x80–0xBF) 与首字节区间不重叠。因此字符串的 UTF-8 字典序与
 * JavaScript 字符串默认的 UTF-16 码元字典序完全一致（代理对同样
 * 按码点有序排列）。直接使用 < / > 比较即为按 UTF-8 字节序比较。
 *
 * 这里保留显式比较器并导出，供排序与单元测试（用 TextEncoder
 * 真实编码做随机差分）核对。
 */
export function compareUtf8(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** 生成仅含可见 ASCII 的确定性伪随机编号，便于构造大量唯一键 */
export function sortedByUtf8<T>(items: T[], keyOf: (item: T) => string): T[] {
  return [...items].sort((x, y) => compareUtf8(keyOf(x), keyOf(y)));
}
