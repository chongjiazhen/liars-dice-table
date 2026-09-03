# Third-party notices - the compiled build

`table.wasm` and `table.js` are built from the author's own source with the
Emscripten toolchain. The build links the runtime components below; each is
credited here under the terms its licence requires of a binary redistribution.
Versions are the ones the build resolved.

| Component | Version | Licence |
|---|---|---|
| Emscripten (JavaScript glue and runtime support library) | 6.0.9 | MIT (also available under the University of Illinois/NCSA licence) |
| musl libc (as bundled by Emscripten) | Emscripten 6.0.9's copy | MIT |
| LLVM libc++ (as bundled by Emscripten) | Emscripten 6.0.9's copy | Apache-2.0 WITH LLVM-exception |

Emscripten: https://emscripten.org/ - licence text in the project's LICENSE file.
musl: https://musl.libc.org/ - licence text in the project's COPYRIGHT file.
libc++: https://libcxx.llvm.org/ - licence text in LLVM's LICENSE.TXT.

Nothing else is linked. The page code beside this build (`../index.html`,
`../table.js`, `../table.css`) has no dependencies and is licensed under the
repository's MIT `LICENSE`.
