export interface ServerSentEvent {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
}

export async function* parseServerSentEvents(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<ServerSentEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  let event: string | undefined;
  let id: string | undefined;
  let retry: number | undefined;
  let fullyRead = false;

  const dispatch = (): ServerSentEvent | undefined => {
    if (dataLines.length === 0) return undefined;
    const result: ServerSentEvent = {
      data: dataLines.join("\n"),
      ...(event !== undefined ? { event } : {}),
      ...(id !== undefined ? { id } : {}),
      ...(retry !== undefined ? { retry } : {}),
    };
    dataLines = [];
    event = undefined;
    retry = undefined;
    return result;
  };

  const consumeLine = (line: string): ServerSentEvent | undefined => {
    if (line === "") return dispatch();
    if (line.startsWith(":")) return undefined;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "data": dataLines.push(value); break;
      case "event": event = value; break;
      case "id": if (!value.includes("\0")) id = value; break;
      case "retry": {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed) && parsed >= 0) retry = parsed;
        break;
      }
    }
    return undefined;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        fullyRead = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r\n|\r|\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const message = consumeLine(line);
        if (message) yield message;
      }
    }
    buffer += decoder.decode();
    if (buffer) {
      const message = consumeLine(buffer);
      if (message) yield message;
    }
    const trailing = dispatch();
    if (trailing) yield trailing;
  } finally {
    if (!fullyRead) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
