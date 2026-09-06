const ID_TOKEN_KEY = "qm-id-token";
const REFRESH_TOKEN_KEY = "qm-refresh-token";

export type DashboardSession = {
  idToken: string;
  refreshToken: string;
};

export class SessionExpiredError extends Error {
  constructor(message = "Your sign-in session has expired. Please sign in again.") {
    super(message);
    this.name = "SessionExpiredError";
  }
}

export function readSession(): DashboardSession | null {
  const idToken = sessionStorage.getItem(ID_TOKEN_KEY);
  const refreshToken = sessionStorage.getItem(REFRESH_TOKEN_KEY);
  return idToken && refreshToken ? { idToken, refreshToken } : null;
}

export function writeSession(session: DashboardSession): void {
  sessionStorage.setItem(ID_TOKEN_KEY, session.idToken);
  sessionStorage.setItem(REFRESH_TOKEN_KEY, session.refreshToken);
}

export function clearSession(): void {
  sessionStorage.removeItem(ID_TOKEN_KEY);
  sessionStorage.removeItem(REFRESH_TOKEN_KEY);
}

export function tokenExpiresSoon(token: string, now = Date.now(), skewSeconds = 60): boolean {
  try {
    const payload = token.split(".")[1];
    if (!payload) return true;
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = JSON.parse(atob(normalized)) as { exp?: number };
    return !decoded.exp || decoded.exp * 1000 <= now + skewSeconds * 1000;
  } catch {
    return true;
  }
}
