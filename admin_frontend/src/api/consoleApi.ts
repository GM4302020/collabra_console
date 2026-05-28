// FILE: ~/otmega/otmega_app/console/admin_frontend/src/api/consoleApi.ts
// ماموریت: کلاینت REST برای health، session، config و APIهای read-only کنسول.

export type ConsoleHealth = {
  status: string;
  service: string;
  mode: string;
  write_enabled: boolean;
  timestamp: string;
};

export type ConsoleSession = {
  status: string;
  mode: string;
  write_enabled: boolean;
  login_enabled: boolean;
  actor: {
    authenticated: boolean;
    bearer_present: boolean;
    user_id: string | null;
    email: string | null;
    full_name: string | null;
    title: string | null;
    avatar_url: string | null;
    tier: number;
    role: string;
    access_level: string;
    is_user_zero: boolean;
  };
  capabilities: string[];
};

export type ConfigDomain = {
  key: string;
  source: string;
  write_enabled: boolean;
};

export type ConfigDomainsResponse = {
  status: string;
  mode: string;
  domains: ConfigDomain[];
};

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, {
    credentials: 'include',
    headers: {
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(`${path} failed with ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    method: 'POST',
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(payload?.message || `${path} failed with ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export function fetchConsoleHealth(): Promise<ConsoleHealth> {
  return getJson<ConsoleHealth>('/api/console/health');
}

export function fetchConsoleSession(): Promise<ConsoleSession> {
  return getJson<ConsoleSession>('/api/console/session');
}

export function loginConsole(email: string, password: string): Promise<ConsoleSession> {
  return postJson<ConsoleSession>('/api/console/login', { email, password });
}

export function logoutConsole(): Promise<ConsoleSession> {
  return postJson<ConsoleSession>('/api/console/logout');
}

export function fetchConfigDomains(): Promise<ConfigDomainsResponse> {
  return getJson<ConfigDomainsResponse>('/api/console/config/domains');
}
