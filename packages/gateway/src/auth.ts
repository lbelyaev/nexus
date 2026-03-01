import { randomBytes, timingSafeEqual } from "node:crypto";

export const generateToken = (): string => randomBytes(16).toString("hex");

export const validateToken = (
  provided: string | null | undefined,
  expected: string,
): boolean => {
  if (!provided || provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
};
