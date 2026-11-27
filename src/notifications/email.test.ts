import assert from "node:assert/strict";
import test from "node:test";
import type { AccountStore } from "../store.js";
import type { User } from "../types.js";
import type { SmtpConfig } from "./config.js";
import { NotificationService } from "./service.js";
import { renderNotification } from "./templates.js";
import type {
  EmailMessage,
  EmailTransport,
  NotificationEvent,
} from "./types.js";

const NOW = 1_760_000_000_000;
const PASSWORD = "smtp-super-secret-value";
const USERNAME = "multivibe-mailer";

const BASE_CONFIG: SmtpConfig = {
  enabled: true,
  host: "smtp.example.test",
  port: 587,
  secure: false,
  user: USERNAME,
  password: PASSWORD,
  from: "MultiVibe <no-reply@multivibe.cloud>",
  replyTo: "support@multivibe.cloud",
  appUrl: "https://app.example.test",
};

function smtpConfig(overrides: Partial<SmtpConfig> = {}): SmtpConfig {
  return { ...BASE_CONFIG, ...overrides };
}

function makeUser(
  id: string,
  email: string,
  overrides: Partial<User> = {},
): User {
  return {
    id,
    email,
    name: id,
    role: "member",
    status: "active",
    quota: { period: "month", creditUsd: 20 },
    usage: {
      periodStart: undefined,
      requests: 0,
      tokens: 0,
      costUsd: 0,
      grantedCostUsd: 0,
    },
    walletUsd: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function storeWith(users: User[]): {
  store: Pick<AccountStore, "findUser">;
  lookups: string[];
} {
  const lookups: string[] = [];
  return {
    lookups,
    store: {
      async findUser(id: string) {
        lookups.push(id);
        return users.find((user) => user.id === id);
      },
    },
  };
}

function recordingTransport(): {
  messages: EmailMessage[];
  transport: EmailTransport;
} {
  const messages: EmailMessage[] = [];
  return {
    messages,
    transport: {
      async send(message) {
        messages.push(message);
        return { messageId: "test-message-id" };
      },
    },
  };
}

test("disabled SMTP is a no-op that never looks up the user", async () => {
  const { messages, transport } = recordingTransport();
  const { store, lookups } = storeWith([makeUser("usr_1", "sam@example.com")]);
  const service = new NotificationService({
    config: smtpConfig({ enabled: false }),
    transport,
    logger: null,
  });

  const result = await service.notifyUserEvent(store, "usr_1", {
    type: "balance_low",
    data: { balanceUsd: 1.25 },
  });

  assert.deepEqual(result, {
    status: "skipped",
    type: "balance_low",
    reason: "disabled",
  });
  assert.equal(lookups.length, 0);
  assert.equal(messages.length, 0);
});

test("incomplete SMTP settings are a no-op instead of throwing", async () => {
  for (const overrides of [
    { host: undefined },
    { from: "" },
    { password: undefined },
  ]) {
    const { messages, transport } = recordingTransport();
    const { store } = storeWith([makeUser("usr_1", "sam@example.com")]);
    const service = new NotificationService({
      config: smtpConfig(overrides),
      transport,
      logger: null,
    });

    const result = await service.notifyUserEvent(store, "usr_1", {
      type: "topup_succeeded",
      data: { amountUsd: 10 },
    });

    assert.deepEqual(result, {
      status: "skipped",
      type: "topup_succeeded",
      reason: "incomplete_config",
    });
    assert.equal(messages.length, 0);
  }
});

test("every event renders its subject, USD amounts and escaped HTML", () => {
  const recipientName = `<img src=x onerror="alert(1)">`;
  const cases: Array<{
    event: NotificationEvent;
    subject: string;
    expected: string[];
  }> = [
    {
      event: {
        type: "balance_low",
        data: { balanceUsd: 2.5, thresholdUsd: 5 },
      },
      subject: "Your MultiVibe balance is low",
      expected: ["$2.50", "$5.00", "Current balance", "Low-balance threshold"],
    },
    {
      event: {
        type: "topup_succeeded",
        data: { amountUsd: 25, balanceUsd: 30 },
      },
      subject: "Your MultiVibe top-up succeeded",
      expected: ["Top-up confirmed", "$25.00", "$30.00", "New balance"],
    },
    {
      event: {
        type: "spend_limit_reached",
        data: { limitUsd: 50, spentUsd: 50.75, periodLabel: "November 2026" },
      },
      subject: "You reached your MultiVibe spend limit",
      expected: [
        "Spend limit reached",
        "$50.00",
        "$50.75",
        "November 2026",
      ],
    },
  ];

  for (const { event, subject, expected } of cases) {
    const rendered = renderNotification(event, {
      recipientName,
      appUrl: "https://app.example.test",
    });

    assert.equal(rendered.subject, subject);
    for (const value of expected) {
      assert.ok(
        rendered.html.includes(value),
        `${event.type} HTML should include ${value}`,
      );
      assert.ok(
        rendered.text.includes(value),
        `${event.type} text should include ${value}`,
      );
    }

    // The only angle brackets in the HTML are the layout's own tags.
    assert.ok(rendered.html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"));
    assert.ok(!rendered.html.includes(recipientName));
    assert.ok(!rendered.html.includes('onerror="alert(1)"'));
    assert.ok(
      rendered.html.includes('href="https://app.example.test/billing"'),
    );
    assert.ok(rendered.text.includes("https://app.example.test/billing"));
  }
});

test("event string fields are escaped in HTML", () => {
  const rendered = renderNotification({
    type: "spend_limit_reached",
    data: {
      limitUsd: 10,
      periodLabel: `<b>November</b> & "Q4"`,
    },
  });

  assert.ok(
    rendered.html.includes(
      "&lt;b&gt;November&lt;/b&gt; &amp; &quot;Q4&quot;",
    ),
  );
  assert.ok(!rendered.html.includes("<b>November</b>"));
});

test("unsafe CTA schemes fall back to the app billing URL", () => {
  const rendered = renderNotification(
    {
      type: "balance_low",
      data: { balanceUsd: 1, ctaUrl: "javascript:alert(1)" },
    },
    { appUrl: "https://app.example.test" },
  );

  assert.ok(!rendered.html.includes("javascript:"));
  assert.ok(rendered.html.includes("https://app.example.test/billing"));
});

test("missing users and missing/invalid emails are skipped", async () => {
  const { messages, transport } = recordingTransport();
  const service = new NotificationService({
    config: smtpConfig(),
    transport,
    logger: null,
  });

  const missingUser = storeWith([]);
  const missingUserResult = await service.notifyUserEvent(
    missingUser.store,
    "usr_missing",
    { type: "balance_low", data: { balanceUsd: 0 } },
  );
  assert.deepEqual(missingUserResult, {
    status: "skipped",
    type: "balance_low",
    reason: "user_not_found",
  });

  for (const email of ["", "not-an-email"]) {
    const { store } = storeWith([makeUser("usr_1", email)]);
    const result = await service.notifyUserEvent(store, "usr_1", {
      type: "balance_low",
      data: { balanceUsd: 0 },
    });
    assert.deepEqual(result, {
      status: "skipped",
      type: "balance_low",
      reason: "missing_email",
    });
  }

  assert.equal(messages.length, 0);
});

test("delivers to a suspended member and normalizes the address", async () => {
  const { messages, transport } = recordingTransport();
  const { store } = storeWith([
    makeUser("usr_1", "Sam@Example.com", {
      name: "Sam",
      status: "suspended",
    }),
  ]);
  const service = new NotificationService({
    config: smtpConfig(),
    transport,
    logger: null,
  });

  const result = await service.notifyUserEvent(store, "usr_1", {
    type: "topup_succeeded",
    data: { amountUsd: 10, balanceUsd: 12.5 },
  });

  assert.deepEqual(result, {
    status: "sent",
    type: "topup_succeeded",
    to: "sam@example.com",
    messageId: "test-message-id",
  });
  assert.equal(messages.length, 1);
  const [message] = messages;
  assert.equal(message.to, "sam@example.com");
  assert.equal(message.from, BASE_CONFIG.from);
  assert.equal(message.replyTo, BASE_CONFIG.replyTo);
  assert.equal(message.subject, "Your MultiVibe top-up succeeded");
  assert.ok(message.html.includes("$10.00"));
  assert.ok(message.text.includes("$10.00"));
});

test("explicit-recipient API normalizes and validates its address", async () => {
  const { messages, transport } = recordingTransport();
  const service = new NotificationService({
    config: smtpConfig(),
    transport,
    logger: null,
  });

  const sent = await service.sendNotification({
    to: "Member@Example.com",
    type: "spend_limit_reached",
    data: { limitUsd: 20 },
  });
  assert.equal(sent.status, "sent");
  assert.equal(messages[0]?.to, "member@example.com");

  const skipped = await service.sendNotification({
    to: "",
    type: "spend_limit_reached",
    data: { limitUsd: 20 },
  });
  assert.deepEqual(skipped, {
    status: "skipped",
    type: "spend_limit_reached",
    reason: "missing_email",
  });
});

test("credentials never appear in rendered messages", async () => {
  const { messages, transport } = recordingTransport();
  const { store } = storeWith([makeUser("usr_1", "sam@example.com")]);
  const service = new NotificationService({
    config: smtpConfig(),
    transport,
    logger: null,
  });

  await service.notifyUserEvent(store, "usr_1", {
    type: "balance_low",
    data: { balanceUsd: 3.5 },
  });

  const rendered = renderNotification(
    { type: "balance_low", data: { balanceUsd: 3.5 } },
    { appUrl: BASE_CONFIG.appUrl },
  );
  const surfaces = [
    rendered.subject,
    rendered.html,
    rendered.text,
    ...messages.flatMap((message) => [
      message.subject,
      message.html,
      message.text,
      message.from,
      message.replyTo ?? "",
    ]),
  ];

  for (const surface of surfaces) {
    assert.ok(!surface.includes(PASSWORD));
    assert.ok(!surface.includes(USERNAME));
  }
});

test("transport failures return failed and redact credentials from logs", async () => {
  const { store } = storeWith([makeUser("usr_1", "sam@example.com")]);
  const logged: string[] = [];
  const service = new NotificationService({
    config: smtpConfig(),
    transport: {
      async send() {
        throw new Error(`535 authentication failed for ${USERNAME}/${PASSWORD}`);
      },
    },
    logger: { warn: (message) => logged.push(message) },
  });

  const result = await service.notifyUserEvent(store, "usr_1", {
    type: "balance_low",
    data: { balanceUsd: 1 },
  });

  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.ok(result.error.includes("[redacted]"));
  assert.ok(!result.error.includes(PASSWORD));
  assert.ok(!result.error.includes(USERNAME));

  assert.equal(logged.length, 1);
  assert.ok(logged[0].includes("balance_low"));
  assert.ok(logged[0].includes("[redacted]"));
  assert.ok(!logged[0].includes(PASSWORD));
  assert.ok(!logged[0].includes(USERNAME));
});
