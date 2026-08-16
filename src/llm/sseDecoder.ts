export interface SseEvent {
  event?: string;
  data: string;
}

export class SseDecoder {
  private buffer = "";

  public push(chunk: string): SseEvent[] {
    this.buffer += chunk.replace(/\r\n/g, "\n");
    const events: SseEvent[] = [];

    while (true) {
      const boundary = this.buffer.indexOf("\n\n");
      if (boundary < 0) {
        break;
      }
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const parsed = parseBlock(block);
      if (parsed !== undefined) {
        events.push(parsed);
      }
    }

    return events;
  }

  public flush(): SseEvent[] {
    const trailing = this.buffer.trim();
    this.buffer = "";
    if (trailing.length === 0) {
      return [];
    }
    const parsed = parseBlock(trailing);
    return parsed === undefined ? [] : [parsed];
  }
}

function parseBlock(block: string): SseEvent | undefined {
  const data: string[] = [];
  let event: string | undefined;

  for (const line of block.split("\n")) {
    if (line.length === 0 || line.startsWith(":")) {
      continue;
    }
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    if (field === "data") {
      data.push(value);
    } else if (field === "event") {
      event = value;
    }
  }

  if (data.length === 0) {
    return undefined;
  }
  return event === undefined
    ? { data: data.join("\n") }
    : { event, data: data.join("\n") };
}
