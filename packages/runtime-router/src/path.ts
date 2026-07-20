export function assertRelativeRuntimePath(path: string): string {
  if (!path.startsWith("/")) {
    throw new TypeError(`Runtime path must start with '/': ${path}`);
  }
  if (path.startsWith("//")) {
    throw new TypeError("Protocol-relative runtime paths are not allowed");
  }

  const parsed = new URL(path, "http://runtime.invalid");
  if (parsed.origin !== "http://runtime.invalid") {
    throw new TypeError("Absolute runtime URLs are not allowed");
  }
  return `${parsed.pathname}${parsed.search}`;
}

export function assertLoopbackHttpUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  const host = url.hostname.toLowerCase();
  const loopback =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1";

  if (url.protocol !== "http:" || !loopback) {
    throw new Error(
      `Node sidecar must use a loopback HTTP URL, received: ${rawUrl}`,
    );
  }
  if (url.username || url.password) {
    throw new Error("Node sidecar URL must not contain credentials");
  }
  return url;
}
