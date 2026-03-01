import { describe, it, expect, vi } from "vitest";
import { Readable, PassThrough } from "node:stream";
import { parseNdjsonStream } from "../stream.js";

describe("parseNdjsonStream", () => {
  it("yields one parsed object per newline-delimited line", async () => {
    const messages: unknown[] = [];
    const input = Readable.from(['{"a":1}\n{"b":2}\n']);

    parseNdjsonStream(input, (msg) => messages.push(msg), vi.fn());

    await new Promise((r) => input.on("end", r));
    expect(messages).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("handles partial lines buffered across chunks", async () => {
    const messages: unknown[] = [];
    const input = new PassThrough();

    parseNdjsonStream(input, (msg) => messages.push(msg), vi.fn());

    input.write('{"split":');
    input.write('"value"}\n');
    input.end();

    await new Promise((r) => input.on("end", r));
    expect(messages).toEqual([{ split: "value" }]);
  });

  it("skips empty lines", async () => {
    const messages: unknown[] = [];
    const input = Readable.from(['{"a":1}\n\n\n{"b":2}\n']);

    parseNdjsonStream(input, (msg) => messages.push(msg), vi.fn());

    await new Promise((r) => input.on("end", r));
    expect(messages).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("emits error for malformed JSON without crashing", async () => {
    const messages: unknown[] = [];
    const errors: Error[] = [];
    const input = Readable.from(['{"a":1}\nnot-json\n{"b":2}\n']);

    parseNdjsonStream(
      input,
      (msg) => messages.push(msg),
      (err) => errors.push(err),
    );

    await new Promise((r) => input.on("end", r));
    expect(messages).toEqual([{ a: 1 }, { b: 2 }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("Invalid NDJSON");
  });

  it("handles multiple lines in a single chunk", async () => {
    const messages: unknown[] = [];
    const input = Readable.from(['{"x":1}\n{"y":2}\n{"z":3}\n']);

    parseNdjsonStream(input, (msg) => messages.push(msg), vi.fn());

    await new Promise((r) => input.on("end", r));
    expect(messages).toEqual([{ x: 1 }, { y: 2 }, { z: 3 }]);
  });

  it("works with Readable.from()", async () => {
    const messages: unknown[] = [];
    const input = Readable.from([
      Buffer.from('{"hello":"world"}\n'),
    ]);

    parseNdjsonStream(input, (msg) => messages.push(msg), vi.fn());

    await new Promise((r) => input.on("end", r));
    expect(messages).toEqual([{ hello: "world" }]);
  });
});
