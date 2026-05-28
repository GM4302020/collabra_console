// FILE: ~/otmega/otmega_app/console/admin_frontend/src/api/traceStream.ts
// ماموریت: مدیریت اتصال SSE/EventSource برای trace و مانیتورینگ زنده.

export type TraceStreamMessage = {
  event: string;
  mode: string;
  timestamp: string;
};

export function openTraceStream(onMessage: (message: TraceStreamMessage) => void): EventSource {
  const stream = new EventSource('/api/console/traces/stream');
  stream.addEventListener('console-heartbeat', (event) => {
    onMessage(JSON.parse((event as MessageEvent).data) as TraceStreamMessage);
  });
  return stream;
}
