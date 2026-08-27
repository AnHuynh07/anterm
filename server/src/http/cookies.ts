import type { CookieSerializeOptions } from '@fastify/cookie';
import type { AppConfig } from '../config.js';

export function sessionCookieOptions(config: AppConfig): CookieSerializeOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: !config.isDev,
    path: config.base,
    maxAge: Math.floor(config.sessionTtlHours * 3600),
  };
}

export function csrfCookieOptions(config: AppConfig): CookieSerializeOptions {
  return { ...sessionCookieOptions(config), httpOnly: false };
}

export function clearCookieOptions(config: AppConfig): CookieSerializeOptions {
  return { path: config.base };
}
