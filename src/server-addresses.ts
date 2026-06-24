export type ServerAddresses = {
  privateIpv4: string[]
  privateIpv6: string[]
  publicIpv4: string[]
  publicIpv6: string[]
}

/** Workers-safe empty address payload for runtimes without host interface access. */
export function emptyServerAddresses(): ServerAddresses {
  return {
    privateIpv4: [],
    privateIpv6: [],
    publicIpv4: [],
    publicIpv6: [],
  }
}
