// The chart renderer, out of the way: the tests make it fail, which is the path that must not cost an alert.
export const initWasm = () => Promise.reject(new Error("no wasm in tests"));
export class Resvg {
  render() {
    throw new Error("no wasm in tests");
  }
}
