import crypto from "node:crypto";

export function validSignature(rawBody, header, secret) {
  if (!secret) return true;
  const supplied = String(header || "").replace(/^sha256=/i, "");
  if (!/^[a-f0-9]{64}$/i.test(supplied)) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  return crypto.timingSafeEqual(
    Buffer.from(supplied.toLowerCase()),
    Buffer.from(expected),
  );
}

export function requesterAccess(message, ownerSenderIds = new Set()) {
  const senderId = String(message?.senderId || "").trim().toLowerCase();
  const owner = senderId && [...ownerSenderIds].some(
    (candidate) => String(candidate || "").trim().toLowerCase() === senderId,
  );
  return owner ? "owner" : "public";
}
