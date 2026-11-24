import { DeviceTokenSchema } from '@chairside/shared'

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
