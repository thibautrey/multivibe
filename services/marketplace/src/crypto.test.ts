import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import {
  bodySignature,
  enrollmentCode,
  openSecret,
  sealSecret,
  sha256,
  verifyRequestSignature,
  verifyStripeSignature,
  stripeSignature,
} from "./crypto.js";

test("sealed secrets round-trip with and without a key", () => {
  const key = crypto.randomBytes(32).toString("hex");
  const secret = "inst_secret_value";
  const sealed = sealSecret(secret, key);
  assert.match(sealed, /^v1:/);
  assert.equal(openSecret(sealed, key), secret);
  assert.throws(() => openSecret(sealed), /ENCRYPTION_KEY/);
  const plain = sealSecret(secret);
  assert.match(plain, /^plain:/);
  assert.equal(openSecret(plain), secret);
});

test("instance request signatures bind method, path, body and time", () => {
  const secret = "s3cret";
  const timestamp = String(Date.now());
  const body = JSON.stringify({ amountCents: 1000 });
  const path = "/v1/checkout";
  const material = `${timestamp}.POST.${path}.${sha256(body)}`;
  const signature = crypto.createHmac("sha256", secret).update(material).digest("hex");
  assert.equal(
    verifyRequestSignature({ secret, timestamp, method: "POST", path, body, signature }),
    true,
  );
  assert.equal(
    verifyRequestSignature({ secret, timestamp, method: "POST", path, body: "{}", signature }),
    false,
  );
  assert.equal(
    verifyRequestSignature({
      secret,
      timestamp: String(Date.now() - 6 * 60 * 1000),
      method: "POST",
      path,
      body,
      signature,
    }),
    false,
  );
});

test("stripe webhook signatures use the raw body and a tolerance", () => {
  const secret = "whsec_test";
  const raw = JSON.stringify({ id: "evt_1" });
  const header = stripeSignature(raw, secret);
  assert.equal(verifyStripeSignature(raw, header, secret), true);
  assert.equal(verifyStripeSignature(raw, header, "whsec_other"), false);
  assert.equal(verifyStripeSignature(`${raw} `, header, secret), false);
  const old = stripeSignature(raw, secret, Math.floor(Date.now() / 1000) - 3600);
  assert.equal(verifyStripeSignature(raw, old, secret), false);
  assert.equal(verifyStripeSignature(raw, "garbage", secret), false);
});

test("response bodies are signed with the instance secret", () => {
  const body = JSON.stringify({ ok: true });
  assert.match(bodySignature("secret", body), /^sha256=[0-9a-f]{64}$/);
  assert.notEqual(bodySignature("secret", body), bodySignature("other", body));
});

test("enrollment codes are readable and unguessable enough", () => {
  const codes = new Set(Array.from({ length: 50 }, () => enrollmentCode()));
  assert.equal(codes.size, 50);
  for (const code of codes) assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
});
