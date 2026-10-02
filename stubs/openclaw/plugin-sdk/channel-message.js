// OpenClaw 宿主替身：typing 指示回调。我们不需要「正在输入」，给空实现。
export function createTypingCallbacks() { return { start: () => {}, stop: () => {} }; }
