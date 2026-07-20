export const INSECURE_PROVIDER_WARNING =
  "明文 HTTP 不会加密 API Key、提示词或模型回复，网络中的其他设备可能读取或篡改这些内容。仅可用于你信任的本机或局域网服务。";

export function isPlainHttpProviderUrl(value: string): boolean {
  try {
    return new URL(value.trim()).protocol === "http:";
  } catch {
    return false;
  }
}
