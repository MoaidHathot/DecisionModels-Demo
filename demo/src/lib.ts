export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body: unknown = await response.json();
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'error' in body ? String(body.error) : `Request failed (${response.status}).`;
    throw new ApiError(message, response.status);
  }
  return body as T;
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

export function post<T>(url: string, body: unknown): Promise<T> {
  return api<T>(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${ms < 100 ? ms.toFixed(1) : Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)} s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function percent(value: number | null): string {
  if (value === null) return '—';
  if (value === 1) return '100%';
  if (value === 0) return '0%';
  if (value > 0.999) return '>99.9%';
  if (value < 0.001) return '<0.1%';
  return `${(value * 100).toFixed(1)}%`;
}

export const colors = ['#7863df', '#259b8b', '#d79538', '#508ac7', '#cf719a', '#8e9b46', '#a178c9', '#498892'];
export const colorAt = (index: number) => colors[Math.max(0, index) % colors.length]!;
export const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export const timeOf = (date: string | null) => date ? new Date(date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
export const cleanOutput = (text: string) => text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '');
