/// <reference types="vite/client" />

/**
 * SVG 模块类型声明
 * 允许在 TypeScript 中将 SVG 文件作为 URL 字符串导入
 */
declare module '*.svg' {
  const src: string;
  export default src;
}
