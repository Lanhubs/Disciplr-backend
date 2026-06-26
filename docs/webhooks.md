# Webhooks

## Outbound Webhooks
The Disciplr backend dispatches webhooks to subscribers when specific events occur. Subscribers can register to receive webhook deliveries for events such as `vault_created`, `vault_completed`, etc.

The outbound webhooks include signatures in headers which the subscriber can verify.

## Inbound Webhooks

When third-party providers (e.g., payment gateways) send webhook callbacks to our backend, we must ensure these callbacks are authentic, timely, and not replayed.

### Verification Flow

The inbound webhook endpoint uses the `webhookVerify` middleware to validate requests:
1. **Timestamp Check**: Ensures the request was generated recently.
2. **Replay Protection**: Stores a nonce combined with the timestamp. If the same nonce is seen again within the allowed time window, the request is rejected.
3. **Signature Verification**: Validates the HMAC-SHA256 signature calculated over the timestamp, nonce, and raw request body using a shared secret.

### Required Headers
Inbound webhook requests must include the following headers:
- `x-webhook-signature`: The HMAC-SHA256 signature in the format `sha256=<hex_digest>`.
- `x-webhook-timestamp`: A unix timestamp (in milliseconds) representing when the request was made.
- `x-webhook-nonce`: A unique string for the request.

### Calculating the Signature
The signature is generated as an HMAC-SHA256 digest of the following string:
`<timestamp>.<nonce>.<raw_body>`

Using the shared secret (`WEBHOOK_INBOUND_SECRET`):

```javascript
const crypto = require('crypto');

const secret = process.env.WEBHOOK_INBOUND_SECRET;
const timestamp = Date.now();
const nonce = crypto.randomUUID();
const rawBody = JSON.stringify(payload); // Ensure this matches exactly what is sent over the wire

const signatureString = `${timestamp}.${nonce}.${rawBody}`;
const digest = crypto.createHmac('sha256', secret).update(signatureString).digest('hex');
const signatureHeader = `sha256=${digest}`;
```
