import { type Doc, encodeStateAsUpdate } from "yjs";

interface BackpressureSocket {
  bufferedAmount?: number;
  close(code?: number, reason?: string): void;
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void;
}

interface InboundEditingSession {
  handleMessage(data: Uint8Array): void;
  waitForPendingMessages(): Promise<void>;
  webSocket: BackpressureSocket;
}

export function protectInboundQueue(
  editingSession: InboundEditingSession,
  maxBytes: number,
  maxMessages: number,
): void {
  const handleMessage = editingSession.handleMessage.bind(editingSession);
  let queuedBytes = 0;
  let queuedMessages = 0;
  let closed = false;
  editingSession.handleMessage = (data) => {
    if (closed) {
      return;
    }
    if (queuedBytes + data.byteLength > maxBytes || queuedMessages + 1 > maxMessages) {
      closed = true;
      editingSession.webSocket.close(1008, "Editing Session sent messages too quickly");
      return;
    }
    queuedBytes += data.byteLength;
    queuedMessages += 1;
    handleMessage(data);
    void editingSession.waitForPendingMessages().finally(() => {
      queuedBytes -= data.byteLength;
      queuedMessages -= 1;
    });
  };
}

export function protectSlowEditingSession(
  socket: BackpressureSocket,
  maxBackpressureBytes: number,
  onLimit: () => void,
): void {
  const send = socket.send.bind(socket);
  let closed = false;
  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    onLimit();
    socket.close(1013, "Editing Session is too slow");
  };
  socket.send = (data) => {
    if (closed) {
      return;
    }
    if ((socket.bufferedAmount ?? 0) > maxBackpressureBytes) {
      close();
      return;
    }
    send(data);
    if ((socket.bufferedAmount ?? 0) > maxBackpressureBytes) {
      close();
    }
  };
  if ((socket.bufferedAmount ?? 0) > maxBackpressureBytes) {
    close();
  }
}

export function enforceDocumentLimit(document: Doc | Uint8Array, maxBytes: number): void {
  const bytes = document instanceof Uint8Array
    ? document.byteLength
    : encodeStateAsUpdate(document).byteLength;
  if (bytes > maxBytes) {
    throw new ResourceLimitError("Document resource limit exceeded");
  }
}

export function enforceSyncLimit(
  document: Doc,
  payload: Uint8Array,
  type: number,
  maxBytes: number,
): void {
  if ((type === 1 || type === 2) &&
      encodeStateAsUpdate(document).byteLength + payload.byteLength > maxBytes) {
    throw new ResourceLimitError("Document resource limit exceeded");
  }
}

class ResourceLimitError extends Error {
  readonly code = 1009;
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}
