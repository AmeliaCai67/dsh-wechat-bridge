// OpenClaw 宿主替身：基础设施。
//   resolvePreferredOpenClawTmpDir → 系统临时目录
//   withFileLock → 直通执行回调（无宿主，跨进程锁没意义）
//
// ⚠️ withFileLock 的签名是 (filePath, options, fn) —— 三个参数！
//    官方调用点：auth/pairing.ts:99  `withFileLock(filePath, LOCK_OPTIONS, async () => {…})`
//    所以不能写成 (path, fn)；这里取【最后一个参数】当回调，无论几个参数都不会错。
import os from 'node:os';
export function resolvePreferredOpenClawTmpDir() { return os.tmpdir(); }
export async function withFileLock(...args) {
  const fn = args[args.length - 1];
  return typeof fn === 'function' ? await fn() : undefined;
}
