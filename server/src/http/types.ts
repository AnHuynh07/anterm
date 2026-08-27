import type { FastifyInstance } from 'fastify';

/**
 * The app is built with a custom pino logger instance, which specialises the
 * FastifyInstance generics and makes them awkward to thread through helper and
 * route-registration functions. This alias keeps those signatures simple.
 */
export type AnyFastify = FastifyInstance<any, any, any, any, any>;
