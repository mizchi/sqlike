export interface WasmSection {
  id: number;
  name: string;
  payloadBytes: number;
  totalBytes: number;
  customName?: string;
}
export function wasmSections(bytes: Uint8Array): WasmSection[] {
  if (
    bytes.length < 8 ||
    bytes.slice(0, 8).some((b, i) => b !== [0, 97, 115, 109, 1, 0, 0, 0][i])
  )
    throw new Error("invalid Wasm header");
  let position = 8;
  const integer = () => {
    let n = 0;
    for (let shift = 0; shift <= 28; shift += 7) {
      const b = bytes[position++];
      if (b === undefined) throw new Error("truncated Wasm varint");
      n += (b & 127) * 2 ** shift;
      if (b < 128) return n;
    }
    throw new Error("invalid Wasm varint");
  };
  const names = [
    "custom",
    "type",
    "import",
    "function",
    "table",
    "memory",
    "global",
    "export",
    "start",
    "element",
    "code",
    "data",
    "data-count",
    "tag",
  ];
  const sections: WasmSection[] = [];
  while (position < bytes.length) {
    const start = position;
    const id = bytes[position++]!;
    const size = integer();
    const payload = position;
    const end = position + size;
    if (end > bytes.length) throw new Error("truncated Wasm section");
    let customName: string | undefined;
    if (id === 0) {
      const length = integer();
      if (position + length > end)
        throw new Error("truncated Wasm custom name");
      customName = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.slice(position, position + length),
      );
    }
    sections.push({
      id,
      name: names[id] ?? `section-${id}`,
      payloadBytes: size,
      totalBytes: end - start,
      ...(customName === undefined ? {} : { customName }),
    });
    position = end;
    if (position < payload) throw new Error("invalid Wasm section");
  }
  return sections;
}

/** Installed only by the benchmark debugger, before each page/Worker executes.
 * Observe constructors, not imported/exported aliases of shared Wasm memory.
 * WeakRefs plus an explicit GC avoid counting released memories.
 */
export const allocationProbe = String.raw`function(){
  if(globalThis.__runtimeAllocationSnapshot)return;
  const memories=[];
  const Memory=WebAssembly.Memory;
  WebAssembly.Memory=new Proxy(Memory,{construct(target,args){const memory=Reflect.construct(target,args,target);memories.push(new WeakRef(memory));return memory;}});
  globalThis.__runtimeAllocationSnapshot=()=>{
    const liveMemories=memories.map(ref=>ref.deref()).filter(Boolean).map(memory=>({bytes:memory.buffer.byteLength,shared:typeof SharedArrayBuffer!=='undefined'&&memory.buffer instanceof SharedArrayBuffer}));
    return {memories:liveMemories,linearBytes:liveMemories.reduce((n,m)=>n+m.bytes,0)};
  };
}`;
export interface AllocationSnapshot {
  memories: { bytes: number; shared: boolean }[];
  linearBytes: number;
}
