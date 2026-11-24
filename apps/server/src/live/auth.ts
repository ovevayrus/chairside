import { DeviceTokenSchema } from '@chairside/shared'

import type { PairingService } from '../devices/pairing.js'

export type Authenticate = (token: string) => string | null

/** US-005 development credentials belong to this server's configured shop. */
export function createDevAuthenticator(
  shopId: string,
  acceptDevTokens: boolean,
): Authenticate {
  return (token) =>
    acceptDevTokens && DeviceTokenSchema.safeParse(token).success
      ? shopId
      : null
}

export function authenticateBearer(
  header: string | undefined,
  authenticate: Authenticate,
): string | null {
  const token = /^Bearer (\S+)$/i.exec(header ?? '')?.[1]
  return token ? authenticate(token) : null
}

/**
 * Production authenticator: paired device tokens only. The dev bypass (any
 * well-formed token) is on only when `devBypassShopId` is given, which the
 * bootstrap does for DEV_INJECT=1 outside production.
 */
export function createDeviceAuthenticator(
  pairing: Pick<PairingService, 'authenticate'>,
  devBypassShopId?: string,
): Authenticate {
  const dev = devBypassShopId
    ? createDevAuthenticator(devBypassShopId, true)
    : undefined
  return (token) => pairing.authenticate(token) ?? dev?.(token) ?? null
}
