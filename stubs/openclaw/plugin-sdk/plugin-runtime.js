// OpenClaw 宿主替身：全局钩子运行器。给一个 no-op run。
export function getGlobalHookRunner() { return { run: async () => {} }; }
