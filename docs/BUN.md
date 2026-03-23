# Bun 支持说明

本文档说明本次为 `@matbee/libreoffice-converter` 增加的 Bun 支持、这样做的原因，以及 Bun 脚本模式/单文件可执行文件模式分别应该怎么使用。

## 本次改动做了什么

1. **修正运行时判断**
   - 之前 `convertDocument()` 只要看到 `process.versions.node` 就会走 `SubprocessConverter`。
   - Bun 也会暴露 `process.versions.node`，所以会被误判成普通 Node.js。
   - 现在改成了显式区分 `process.versions.bun`，让 Bun 默认走直接转换器，而不是 Node 专用的 `child_process.fork()` 路径。

2. **让 loader 真正尊重 `wasmPath`**
   - 之前 `wasm/loader.cjs` 固定使用自己的 `__dirname` 查找 `soffice.wasm`、`soffice.data` 等资源。
   - 这对 Node.js 本地包目录没问题，但对 Bun `--compile` 场景不够灵活。
   - 现在 `LibreOfficeConverter` 会把 `wasmPath` 传给 loader，loader 会按调用方指定的目录解析 WASM 资源。

3. **导出 Bun 编译场景需要的 WASM 资源路径**
   - `package.json` 里增加了 `./wasm/soffice.*` 相关 export。
   - 这样 Bun 应用可以显式 `import ... with { type: "file" }`，把运行所需资源一起带到编译产物旁边。

4. **提供 Bun 入口调度辅助**
   - 新增了 `getBunSelfSpawnCommand()`、`isBunSubprocessEntrypoint()` 等辅助函数。
   - 它们用于“同一个 Bun 入口既能跑主流程，也能在被再次拉起时充当 worker/subprocess”这类场景。

## 为什么这样做

### 1. Bun 不是“普通 Node.js”

虽然 Bun 提供了大量 Node API 兼容层，但这个库原来的 Node 优化路径依赖：

- `child_process.fork()`
- 外部 worker/subprocess 文件路径
- 基于包目录的静态资源定位

这些假设在 Bun 中不总是成立，尤其是在 `bun build --compile` 之后更明显。

### 2. `bun build --compile` 需要可控的资源定位

LibreOffice WASM 运行依赖：

- `soffice.wasm`
- `soffice.data`
- `soffice.data.js.metadata`
- pthread worker 相关文件

如果 loader 始终只看自己的 `__dirname`，那调用方就很难在 Bun 编译产物里控制这些资源从哪里读取。让 loader 支持 `wasmPath` 是最直接、也最通用的做法。

### 3. 单文件可执行文件里，最稳妥的是“同入口自举”

对于 Bun 编译出来的可执行文件，最通用的方式不是假设外部还有一份 JS worker 文件，而是：

1. 主入口启动；
2. 判断当前是否带了特殊标记参数；
3. 如果带了参数，就执行 worker/subprocess 分支；
4. 如果没带参数，就按正常 CLI 流程跑；
5. 需要隔离转换时，再拉起“自己”并传入标记参数。

本仓库里的 `examples/bun-single-file-ppt-to-images.ts` 就演示了这个模式。

## 脚本模式示例

见：

- `/home/runner/work/libreoffice-document-converter/libreoffice-document-converter/examples/bun-ppt-to-images.ts`

运行：

```bash
bun examples/bun-ppt-to-images.ts tests/sample_test_1.pptx ./output
```

特点：

- 直接在 Bun 环境里调用库；
- 显式传入 `wasmLoader`；
- 显式指定 `wasmPath`；
- 将 PPT/PPTX 页面导出成 PNG。

## 打包模式示例

见：

- `/home/runner/work/libreoffice-document-converter/libreoffice-document-converter/examples/bun-single-file-ppt-to-images.ts`

编译：

```bash
bun build --compile examples/bun-single-file-ppt-to-images.ts \
  --outfile dist/bun-ppt-to-images \
  --asset-naming='[name].[ext]'
```

运行：

```bash
./dist/bun-ppt-to-images tests/sample_test_1.pptx ./output
```

这个示例有两个关键点：

1. **通过 `import ... with { type: "file" }` 把 WASM 资源带进 Bun 编译流程**
2. **通过命令行 flag 把同一个入口切换成主进程 / subprocess 两种角色**

## 技术原理总结

### 运行时选择

- **Node.js**：`convertDocument()` 仍然优先走 `SubprocessConverter`
- **Bun**：`convertDocument()` 改为默认走直接转换器

这样可以避免 Bun 误入 Node 专用的 fork 路径。

### 资源解析

- `LibreOfficeConverter` 现在会把 `wasmPath` 传给 `wasmLoader.createModule()`
- `wasm/loader.cjs` 会按这个 `wasmPath` 去解析 `soffice.*` 资源

因此：

- 在普通脚本模式里，可以直接指向包内 `wasm/`
- 在 Bun 编译模式里，可以指向 Bun 输出到可执行文件旁边的资源目录

### 同入口 subprocess/worker 调度

新增的辅助函数让 Bun 入口可以判断：

- 当前是不是 Bun 运行时
- 当前是不是被当作 subprocess 再次启动
- 当前应该如何拼接“再次拉起自己”的命令

这就是“通过命令行参数等方式在入口点判断是否为 subprocess/worker”的实现方式。
