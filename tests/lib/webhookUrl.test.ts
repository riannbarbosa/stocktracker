import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { config } from '../../src/config.ts';
import { assertWebhookAllowed, isBlockedAddress, WebhookUrlError } from '../../src/lib/webhookUrl.ts';

const notificationDefaults = { ...config.notifications };

/** Stands in for DNS so the suite never resolves a real name. */
function resolvingTo(...addresses: string[]) {
  return async () => addresses;
}

const neverCalled = async (): Promise<string[]> => {
  throw new Error('resolver should not have been called for a literal address');
};

async function rejection(promise: Promise<unknown>): Promise<WebhookUrlError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof WebhookUrlError, `expected WebhookUrlError, got ${String(error)}`);
    return error;
  }
  throw new assert.AssertionError({ message: 'expected the url to be rejected' });
}

describe('lib/webhookUrl', () => {
  beforeEach(() => {
    Object.assign(config.notifications, {
      webhookSchemes: ['https:'],
      webhookAllowedHosts: [],
      webhookAllowPrivate: false,
    });
  });

  afterEach(() => {
    Object.assign(config.notifications, notificationDefaults);
  });

  describe('isBlockedAddress', () => {
    it('blocks the cloud metadata endpoint', () => {
      assert.equal(isBlockedAddress('169.254.169.254'), true);
    });

    it('blocks loopback, private and CGNAT ranges', () => {
      for (const address of ['127.0.0.1', '127.1.2.3', '10.0.0.1', '192.168.1.1', '172.20.0.1', '100.64.0.1', '0.0.0.0']) {
        assert.equal(isBlockedAddress(address), true, `${address} should be blocked`);
      }
    });

    it('allows ordinary public addresses', () => {
      for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34']) {
        assert.equal(isBlockedAddress(address), false, `${address} should be allowed`);
      }
    });

    /* These pin the prefix arithmetic: one address inside the block and one
     * just outside it, on both sides. */
    it('gets the 172.16.0.0/12 boundaries right', () => {
      assert.equal(isBlockedAddress('172.15.255.255'), false);
      assert.equal(isBlockedAddress('172.16.0.0'), true);
      assert.equal(isBlockedAddress('172.31.255.255'), true);
      assert.equal(isBlockedAddress('172.32.0.0'), false);
    });

    it('gets the 100.64.0.0/10 boundaries right', () => {
      assert.equal(isBlockedAddress('100.63.255.255'), false);
      assert.equal(isBlockedAddress('100.64.0.0'), true);
      assert.equal(isBlockedAddress('100.127.255.255'), true);
      assert.equal(isBlockedAddress('100.128.0.0'), false);
    });

    it('blocks IPv6 loopback, unique-local, link-local and multicast', () => {
      for (const address of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1']) {
        assert.equal(isBlockedAddress(address), true, `${address} should be blocked`);
      }
    });

    it('gets the IPv6 prefix boundaries right', () => {
      assert.equal(isBlockedAddress('fdff:ffff::1'), true, 'inside fc00::/7');
      assert.equal(isBlockedAddress('fe00::1'), false, 'outside fc00::/7');
      assert.equal(isBlockedAddress('febf:ffff::1'), true, 'inside fe80::/10');
      assert.equal(isBlockedAddress('fec0::1'), false, 'outside fe80::/10');
    });

    it('allows a public IPv6 address', () => {
      assert.equal(isBlockedAddress('2606:4700:4700::1111'), false);
    });

    /* An IPv4-mapped address must be judged by the address it wraps, or
     * ::ffff:169.254.169.254 walks straight past the v4 table. */
    it('unwraps IPv4-mapped addresses instead of trusting the wrapper', () => {
      assert.equal(isBlockedAddress('::ffff:127.0.0.1'), true);
      assert.equal(isBlockedAddress('::ffff:169.254.169.254'), true);
      assert.equal(isBlockedAddress('::ffff:10.0.0.1'), true);
      assert.equal(isBlockedAddress('::ffff:8.8.8.8'), false);
    });
  });

  describe('scheme', () => {
    it('rejects plain http by default', async () => {
      const error = await rejection(assertWebhookAllowed('http://example.com/hook', neverCalled));
      assert.match(error.message, /scheme "http:" is not allowed/);
    });

    it('rejects non-http schemes', async () => {
      for (const url of ['file:///etc/passwd', 'gopher://example.com/', 'ftp://example.com/']) {
        await rejection(assertWebhookAllowed(url, neverCalled));
      }
    });

    it('accepts http when the operator allows it', async () => {
      config.notifications.webhookSchemes = ['https:', 'http:'];
      await assertWebhookAllowed('http://example.com/hook', resolvingTo('93.184.216.34'));
    });

    it('rejects a string that is not an absolute url', async () => {
      const error = await rejection(assertWebhookAllowed('/just/a/path', neverCalled));
      assert.match(error.message, /not a valid absolute URL/);
    });
  });

  describe('destination', () => {
    it('rejects the metadata endpoint given as a literal', async () => {
      const error = await rejection(
        assertWebhookAllowed('https://169.254.169.254/latest/meta-data/', neverCalled),
      );
      assert.match(error.message, /blocked address/);
    });

    it('rejects an IPv6 literal in brackets', async () => {
      await rejection(assertWebhookAllowed('https://[::1]:9200/hook', neverCalled));
    });

    it('rejects a name that resolves into the private network', async () => {
      const error = await rejection(
        assertWebhookAllowed('https://internal.example.com/hook', resolvingTo('10.1.2.3')),
      );
      assert.match(error.message, /resolves to a blocked address \(10\.1\.2\.3\)/);
    });

    /* A name answering with one public and one private address must not be
     * usable to reach the private one. */
    it('rejects when any answer is blocked, not just the first', async () => {
      await rejection(
        assertWebhookAllowed('https://split.example.com/hook', resolvingTo('93.184.216.34', '127.0.0.1')),
      );
    });

    it('rejects a host that does not resolve', async () => {
      const error = await rejection(
        assertWebhookAllowed('https://nope.example.com/hook', async () => {
          throw new Error('ENOTFOUND');
        }),
      );
      assert.match(error.message, /does not resolve/);
    });

    it('rejects a host that resolves to nothing', async () => {
      await rejection(assertWebhookAllowed('https://empty.example.com/hook', resolvingTo()));
    });

    it('accepts a public destination', async () => {
      await assertWebhookAllowed('https://hooks.example.com/hook', resolvingTo('93.184.216.34'));
    });

    it('rejects embedded credentials', async () => {
      const error = await rejection(
        assertWebhookAllowed('https://user:secret@example.com/hook', neverCalled),
      );
      assert.match(error.message, /must not embed credentials/);
    });
  });

  describe('operator overrides', () => {
    it('lets an allowlisted host through even when it is private', async () => {
      config.notifications.webhookAllowedHosts = ['collector.internal'];
      await assertWebhookAllowed('https://collector.internal/hook', neverCalled);
    });

    it('rejects everything outside a non-empty allowlist', async () => {
      config.notifications.webhookAllowedHosts = ['collector.internal'];
      const error = await rejection(
        assertWebhookAllowed('https://hooks.example.com/hook', resolvingTo('93.184.216.34')),
      );
      assert.match(error.message, /not in WEBHOOK_ALLOWED_HOSTS/);
    });

    it('still enforces the scheme inside the allowlist', async () => {
      config.notifications.webhookAllowedHosts = ['collector.internal'];
      await rejection(assertWebhookAllowed('http://collector.internal/hook', neverCalled));
    });

    it('skips the range check when WEBHOOK_ALLOW_PRIVATE is on', async () => {
      config.notifications.webhookAllowPrivate = true;
      await assertWebhookAllowed('https://127.0.0.1:3099/hook', neverCalled);
    });
  });
});
