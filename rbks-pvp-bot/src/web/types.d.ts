import 'express-session';

declare module 'express-session' {
  interface SessionData {
    user?: { id: string; username: string; globalName: string | null; avatar: string | null };
    csrf?: string;
    oauthState?: string;
    flash?: { type: 'success' | 'error' | 'info'; message: string }[];
    returnTo?: string;
  }
}
