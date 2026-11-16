import { parseFreezeParams, parseId } from "@/.server/params";
import { suppliedSignatures } from "@/.server/request";
import { describe, expect, it } from "vitest";

const id = `0x${"ab".repeat(32)}`;

describe("URL parameters", () => {
  it("accepts only 32-byte ids", () => {
    expect(parseId(id.toUpperCase().replace("0X", "0x"))).toBe(id);
    expect(() => parseId("0x1234")).toThrow();
    expect(() => parseId(undefined)).toThrow();
  });

  it("parses a freeze request URL and rejects incomplete ones", () => {
    const url = new URL("http://x/app/freeze/soft-freeze?nonce=0&validUntil=1790000000");
    expect(parseFreezeParams("soft-freeze", url)).toEqual({
      action: "SoftFreeze",
      nonce: "0",
      validUntil: "1790000000",
      threshold: undefined,
    });
    expect(() => parseFreezeParams("melt", url)).toThrow();
    expect(() => parseFreezeParams("set-soft-freeze-threshold", url)).toThrow();
    expect(
      parseFreezeParams("set-soft-freeze-threshold", new URL(`${url}&threshold=2`)).threshold
    ).toBe("2");
  });

  it("answers 400 for a value above 2^256 − 1, never a bare 500", async () => {
    const above = ((1n << 256n) + 7n).toString();
    const max = ((1n << 256n) - 1n).toString();
    const freeze = (validUntil: string) =>
      new URL(`http://x/app/freeze/soft-freeze?nonce=0&validUntil=${validUntil}`);
    expect(parseFreezeParams("soft-freeze", freeze(max)).validUntil).toBe(max);
    let thrown: unknown;
    try {
      parseFreezeParams("soft-freeze", freeze(above));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(400);
    expect(await (thrown as Response).text()).toMatch(/^validUntil is above 2\^256/);
  });

  it("reads ?sig=<member>:<signature> and skips malformed ones", () => {
    const request = new Request(
      "http://x/?sig=0x34ea62d4b9bbb8ad927efb6ab31e3ab3474ac93a:0xaabb&sig=nonsense&sig=0x34Ea62D4b9bBB8AD927eFB6ab31E3Ab3474aC93a:0xzz"
    );
    expect(suppliedSignatures(request)).toEqual([
      { signer: "0x34Ea62D4b9bBB8AD927eFB6ab31E3Ab3474aC93a", signature: "0xaabb" },
    ]);
  });
});
