// 换个入口文件名：DSH 的重载按 specifier 缓存，之前 import 失败过的那条会一直失败。
// 用一个新文件名（→ 新的 specifier）可以强制它重新 import。
export * from './index.js'
export { default } from './index.js'
