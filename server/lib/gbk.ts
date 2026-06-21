export function decodeGBK(buffer: ArrayBuffer): string {
  try {
    return new TextDecoder('gbk').decode(buffer);
  } catch {
    // Fallback for Cloudflare Workers which only support UTF-8
    // The numbers and English characters (e.g. market codes) will decode fine,
    // and Chinese characters will be replaced by the replacement character.
    // Ideally we would include a full GBK mapping table or a custom wasm decoder,
    // but for simplicity and size we use the fatal:false fallback.
    return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  }
}
