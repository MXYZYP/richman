import { hapTasks } from '@ohos/hvigor-ohos-plugin';

/*
 * entry 模块的构建入口。
 *
 * 没有这个文件时 hvigor 会在 Sync / Build 阶段直接报「找不到模块的构建脚本」——
 * 它属于「必须有、内容恒定」的那类文件，与 DevEco 版本无关，所以这里可以放心固化。
 * 根目录的 hvigorfile.ts 用的是 appTasks（应用级），这里是 hapTasks（模块级）。
 */
export default {
  system: hapTasks,  /* Built-in plugin of Hvigor. It cannot be modified. */
  plugins: []         /* Custom plugin to extend the functionality of Hvigor. */
}
