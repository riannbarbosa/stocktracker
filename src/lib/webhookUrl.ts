/* Guard for user-supplied webhook destinations.
 *
 * An alert's webhookUrl is attacker-chosen and the poller POSTs to it from
 * inside the deployment network, so `format: 'uri'` is not a control: it admits
 * any scheme and any host, including loopback, RFC1918 and the link-local
 * 169.254.169.254 that carries cloud instance metadata. Every destination is
 * checked here instead, both when the alert is written and again before each
 * delivery. */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { config } from '../config.ts';

export class WebhookUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookUrlError';
  }
}

/** Resolves a hostname to every address it answers with. Injectable for tests. */
export type AddressResolver = (host: string) => Promise<string[]>;

/* IPv4 blocks that must never be reachable from a webhook: this-network,
 * RFC1918 private, CGNAT, loopback, link-local (cloud metadata), IETF protocol
 * assignments, the documentation/benchmark ranges, multicast and reserved. */
const BLOCKED_V4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

/* IPv6 equivalents. ::ffff:0:0/96 is deliberately absent — an IPv4-mapped
 * address is unwrapped and judged by the IPv4 table, so ::ffff:127.0.0.1
 * cannot slip past as "just another v6 address". */
const BLOCKED_V6: ReadonlyArray<readonly [string, number]> = [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
];

function ipv4ToInt(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;

  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function ipv6ToBytes(address: string): Uint8Array | null {
  let text = address;

  /* A trailing dotted-quad (::ffff:1.2.3.4) is rewritten into two hex groups so
   * the rest of the parser only ever sees hextets. */
  const tail = /^(.*:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(text);
  if (tail) {
    const value = ipv4ToInt(tail[2]!);
    if (value === null) return null;
    text = `${tail[1]}${((value >>> 16) & 0xffff).toString(16)}:${(value & 0xffff).toString(16)}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;

  const groups: string[] = [];
  if (rest === null) {
    if (head.length !== 8) return null;
    groups.push(...head);
  } else {
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    groups.push(...head, ...new Array<string>(missing).fill('0'), ...rest);
  }

  const bytes = new Uint8Array(16);
  for (let index = 0; index < 8; index += 1) {
    const group = groups[index]!;
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    const value = Number.parseInt(group, 16);
    bytes[index * 2] = value >> 8;
    bytes[index * 2 + 1] = value & 0xff;
  }
  return bytes;
}

function withinV4(value: number, base: string, prefix: number): boolean {
  const baseValue = ipv4ToInt(base);
  if (baseValue === null) return false;
  const divisor = 2 ** (32 - prefix);
  return Math.floor(value / divisor) === Math.floor(baseValue / divisor);
}

function withinV6(bytes: Uint8Array, base: string, prefix: number): boolean {
  const baseBytes = ipv6ToBytes(base);
  if (!baseBytes) return false;

  const wholeBytes = prefix >> 3;
  for (let index = 0; index < wholeBytes; index += 1) {
    if (bytes[index] !== baseBytes[index]) return false;
  }

  const remainingBits = prefix & 7;
  if (remainingBits === 0) return true;

  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return (bytes[wholeBytes]! & mask) === (baseBytes[wholeBytes]! & mask);
}

/** True when the literal address is in a range a webhook must not reach. */
export function isBlockedAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const value = ipv4ToInt(address);
    return value === null || BLOCKED_V4.some(([base, prefix]) => withinV4(value, base, prefix));
  }

  const bytes = ipv6ToBytes(address);
  if (!bytes) return true;

  /* ::ffff:a.b.c.d — judge the embedded IPv4 address, not the wrapper. */
  const mapped = bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (mapped) {
    return isBlockedAddress(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  }

  return BLOCKED_V6.some(([base, prefix]) => withinV6(bytes, base, prefix));
}

const resolveAddresses: AddressResolver = async (host) => {
  const results = await lookup(host, { all: true, verbatim: true });
  return results.map((result) => result.address);
};

/**
 * Throws WebhookUrlError unless `raw` is a destination this deployment is
 * willing to POST to. Callers surface the message to the client (on write) or
 * log it (on delivery).
 */
export async function assertWebhookAllowed(
  raw: string,
  resolver: AddressResolver = resolveAddresses,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebhookUrlError('webhookUrl is not a valid absolute URL');
  }

  const { webhookSchemes, webhookAllowedHosts, webhookAllowPrivate } = config.notifications;

  if (!webhookSchemes.includes(url.protocol)) {
    throw new WebhookUrlError(
      `webhookUrl scheme "${url.protocol}" is not allowed (allowed: ${webhookSchemes.join(', ')})`,
    );
  }

  if (url.username !== '' || url.password !== '') {
    throw new WebhookUrlError('webhookUrl must not embed credentials');
  }

  /* URL keeps the brackets on an IPv6 literal host. */
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === '') {
    throw new WebhookUrlError('webhookUrl has no host');
  }

  /* An explicit allowlist is an operator decision, so it wins over the range
   * check — that is the supported way to reach an internal collector. */
  if (webhookAllowedHosts.length > 0) {
    if (!webhookAllowedHosts.includes(host)) {
      throw new WebhookUrlError(`webhookUrl host "${host}" is not in WEBHOOK_ALLOWED_HOSTS`);
    }
    return;
  }

  if (webhookAllowPrivate) return;

  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = await resolver(host);
    } catch {
      throw new WebhookUrlError(`webhookUrl host "${host}" does not resolve`);
    }
  }

  if (addresses.length === 0) {
    throw new WebhookUrlError(`webhookUrl host "${host}" does not resolve`);
  }

  /* Every answer has to be acceptable: a name that returns one public and one
   * private address must not be usable to reach the private one. */
  for (const address of addresses) {
    if (isBlockedAddress(address)) {
      throw new WebhookUrlError(
        `webhookUrl host "${host}" resolves to a blocked address (${address})`,
      );
    }
  }
}
