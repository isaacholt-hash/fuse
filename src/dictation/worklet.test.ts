// @vitest-environment node
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

test("the actual worklet downmixes channels, clamps its frame count and stops producing audio", () => {
  const sent: { type: string; samples?: Float32Array }[] = [];
  class Base {
    port = {
      postMessage: (m: { type: string; samples?: Float32Array }) => {
        sent.push(m);
      },
    };
  }
  type Processor = Base & { process(inputs: Float32Array[][]): boolean };
  let create!: (maxFrames: number) => Processor;
  runInNewContext(
    readFileSync(new URL("../../public/dictation-worklet.js", import.meta.url), "utf8"),
    {
      AudioWorkletProcessor: Base,
      Float32Array,
      sampleRate: 8000,
      registerProcessor: (
        name: string,
        Type: new (options: { processorOptions: { maxFrames: number } }) => Processor,
      ) => {
        expect(name).toBe("fuse-dictation");
        create = (maxFrames) => new Type({ processorOptions: { maxFrames } });
      },
    },
  );
  const processor = create(777);
  expect(processor).toBeDefined();
  expect(
    processor.process([[new Float32Array(2000).fill(1), new Float32Array(2000).fill(-1)]]),
  ).toBe(false);
  expect(sent[0]?.samples?.length).toBe(777);
  expect(sent[0]?.samples?.every((s) => s === 0)).toBe(true);
  expect(sent.at(-1)?.type).toBe("limit");
});
