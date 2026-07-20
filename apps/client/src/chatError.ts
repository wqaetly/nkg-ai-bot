import { RuntimeTransportError } from "@nkg-ai-bot/runtime-router";

export function describeChatError(cause: unknown): string {
  if (isAbort(cause)) {
    return "已停止生成，本次不完整回复未保存。";
  }
  if (cause instanceof RuntimeTransportError) {
    if (cause.phase === "stream") {
      return "运行时连接在生成过程中中断，不完整回复未保存。为避免重复执行，本次不会自动续跑；下次发送前会重新准备运行时。";
    }
    return cause.requestMayHaveExecuted
      ? "运行时连接中断，本次请求可能已经开始执行。为避免重复操作，本次不会自动重试；下次发送前会重新准备运行时。"
      : "运行时暂时不可用，下次发送前会自动重新准备。";
  }
  return cause instanceof Error ? cause.message : String(cause);
}

function isAbort(cause: unknown): boolean {
  return cause instanceof Error && cause.name === "AbortError";
}
