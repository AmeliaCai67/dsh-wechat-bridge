// OpenClaw 宿主替身：命令鉴权。桥接是全权信任的本机进程，一律放行。
export async function resolveSenderCommandAuthorizationWithRuntime() { return { outcome: 'allowed' }; }
export async function resolveDirectDmAuthorizationOutcome() { return { outcome: 'allowed' }; }
