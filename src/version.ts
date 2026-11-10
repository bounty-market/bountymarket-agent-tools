/**
 * Package version reported by `bountymarket --version`, the MCP `initialize`
 * handshake and the User-Agent header. Bump together with package.json.
 */
import { PACKAGE_NAME } from './brand.ts';

export const VERSION = '0.1.0';
export const USER_AGENT = `${PACKAGE_NAME}/${VERSION}`;
