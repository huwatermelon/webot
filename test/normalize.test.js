import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeHookEvent,
  normalizePadEnvelope,
} from "../src/normalize.js";

test("normalizes OneBot private and group messages", () => {
  const privateMessage = normalizeHookEvent({
    post_type: "message",
    message_type: "private",
    self_id: "wxid_bot",
    user_id: "wxid_peer",
    message_id: 101,
    time: 1_770_000_000,
    message: [{ type: "text", data: { text: "hello" } }],
  });
  assert.equal(privateMessage.chatId, "wxid_peer");
  assert.equal(privateMessage.text, "hello");

  const groupMessage = normalizeHookEvent({
    post_type: "message",
    message_type: "group",
    self_id: "wxid_bot",
    user_id: "wxid_peer",
    group_id: "123@chatroom",
    message_id: 102,
    message: [
      { type: "at", data: { qq: "wxid_bot" } },
      { type: "text", data: { text: " status" } },
    ],
  });
  assert.equal(groupMessage.chatId, "123@chatroom");
  assert.deepEqual(groupMessage.mentions, ["wxid_bot"]);
});

test("normalizes common Pad sync envelopes", () => {
  const messages = normalizePadEnvelope(
    {
      Data: {
        type: "sync_message",
        data: {
          AddMsgs: [
            {
              NewMsgId: 201,
              MsgType: 1,
              CreateTime: 1_770_000_000,
              FromUserName: { string: "123@chatroom" },
              ToUserName: { string: "wxid_bot" },
              Content: { string: "wxid_peer:\nwebot ping" },
            },
          ],
        },
      },
    },
    "wxid_bot",
  );

  assert.equal(messages.length, 1);
  assert.equal(messages[0].chatType, "group");
  assert.equal(messages[0].chatId, "123@chatroom");
  assert.equal(messages[0].senderId, "wxid_peer");
  assert.equal(messages[0].text, "webot ping");
});

test("separates main self chat from the main-small account conversation", () => {
  const source = {
    id: "small",
    displayName: "小号",
    selfId: "wxid_small",
    selfChatPeers: new Set(["owner_wxid"]),
  };
  const [message] = normalizePadEnvelope({
    Data: {
      type: "sync_message",
      messages: [{
        NewMsgId: "pair-1",
        MsgType: 1,
        FromUserName: "owner_wxid",
        ToUserName: "wxid_small",
        Content: "继续",
      }],
    },
  }, source);

  assert.equal(message.sourceId, "small");
  assert.equal(message.selfConversation, true);
  assert.equal(
    message.conversationId,
    "self-pair:owner_wxid--wxid_small",
  );
  assert.equal(message.replyTarget, "owner_wxid");
});

test("normalizes top-level WeChatPad gateway events", () => {
  const [message] = normalizePadEnvelope({
    id: "opt-event-1",
    new_msg_id: "opt-message-1",
    type: 1,
    direction: "incoming",
    conversation_id: "owner_wxid",
    sender_id: "owner_wxid",
    recipient_id: "wxid_small",
    content: "webot ping",
    created_at: 1_789_116_782,
  }, {
    id: "small-opt",
    displayName: "小号",
    selfId: "wxid_small",
    selfChatPeers: new Set(["owner_wxid"]),
  });

  assert.equal(message.messageId, "opt-message-1");
  assert.equal(message.timestamp, 1_789_116_782_000);
  assert.equal(message.senderId, "owner_wxid");
  assert.equal(message.selfId, "wxid_small");
  assert.equal(message.direction, "incoming");
  assert.equal(message.selfConversation, true);
  assert.equal(message.replyTarget, "owner_wxid");
  assert.equal(message.text, "webot ping");
});
