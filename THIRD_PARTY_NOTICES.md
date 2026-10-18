# 第三方代码声明

本文件记录明确引入的开源实现。它不是当前所有传递依赖的完整许可证清单；发行安装包前仍需随所分发依赖保留其许可、版权及适用 NOTICE。

## tar-stream 3.2.2

- 来源：https://github.com/mafintosh/tar-stream
- 版本：3.2.2，通过包管理器按固定版本引入，完整性记录见 `pnpm-lock.yaml`。
- 用途：`src/project-archive.ts` 打包已核对的文件清单；测试解包并核对归档内容。
- 修改：未修改上游代码。
- 许可证：MIT，以下保留安装版本的版权与许可原文。

```text
The MIT License (MIT)

Copyright (c) 2014 Mathias Buus

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
