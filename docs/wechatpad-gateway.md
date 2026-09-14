# WeChatPad Gateway

Webot connects to a separately operated WeChatPad-compatible gateway. The
gateway handles the WeChat protocol connection; Webot handles message policy,
cases, assistant sessions, knowledge, drafts, and replies.

## Required Settings

Configure each account with:

- A stable account ID such as a `wxid`.
- The gateway HTTP API URL.
- The gateway WebSocket URL.
- An account-scoped access token or a path to a protected token file.
- Optional private-chat, group-chat, mention, and keyword allowlists.

Credentials, gateway sessions, protocol state, and logs are runtime data. Keep
them outside this repository and restrict their filesystem permissions.

## Local Example

A local gateway may expose endpoints similar to:

```text
HTTP: http://127.0.0.1:18102/api
WS:   ws://127.0.0.1:18102/ws/<account-id>
```

Authentication and route details depend on the gateway implementation. Use its
own documentation to obtain credentials and establish the account session.

## Validation

1. Add the account in the Webot administration console.
2. Save the HTTP, WebSocket, account ID, and credential settings.
3. Run the connection check.
4. Keep outbound mode set to dry-run while validating inbound events.
5. Enable live outbound only after verifying the correct account and chat.

Webot sends normalized messages to assistant providers. Raw gateway envelopes
and credentials are not included in assistant prompts.
