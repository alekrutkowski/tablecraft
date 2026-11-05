# Third-party notices

Original Tablecraft application code is copyright (c) 2026 Alek Rutkowski and is distributed under the MIT licence in the project's `LICENSE` file. Dependencies retain their respective licences.

## Included browser assets

### Bootstrap 6.0.0-alpha.1

Copyright (c) 2011-2026 The Bootstrap Authors.

Source: [Bootstrap](https://github.com/twbs/bootstrap).  
Licence: [MIT](https://github.com/twbs/bootstrap/blob/main/LICENSE).

### CodeMirror 5.65.21

Copyright (C) 2017 by Marijn Haverbeke <marijn@haverbeke.berlin> and others.

Source: [CodeMirror 5](https://codemirror.net/5/).  
Licence: [MIT](https://github.com/codemirror/codemirror5/blob/master/LICENSE).

The included files comprise the editor's JavaScript and CSS, its R language mode, the `matchbrackets`, `closebrackets`, and `show-hint` add-ons, and the hint stylesheet. All retain the above attribution. Application icons are handwritten SVG; the font stack uses system fonts, so there is no separate font dependency.

### MIT terms for the above assets

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

## Runtime downloads

webR and R package binaries are retrieved from their upstream repositories at runtime. They are not relicensed under Tablecraft's MIT licence. The following upstream resources identify their licences, sources, and contributors:

- [webR software licensing and bundled libraries](https://github.com/r-wasm/webr/blob/main/LICENSE.md).
- [R licences](https://www.r-project.org/Licenses/).
- [data.table package metadata](https://rdatatable.gitlab.io/data.table/web/packages/data.table/index.html).
- [magrittr licence](https://magrittr.tidyverse.org/LICENSE.html) and [contributors](https://magrittr.tidyverse.org/authors.html).
- [jsonlite source, licence, and bundled YAJL notices](https://github.com/jeroen/jsonlite).
- [bit64](https://github.com/r-lib/bit64) and [bit](https://github.com/r-lib/bit) source and package metadata.
- [readxl licence](https://readxl.tidyverse.org/LICENSE.html), [contributors and embedded-library authors](https://readxl.tidyverse.org/authors.html), and [dependency metadata](https://github.com/tidyverse/readxl/blob/main/DESCRIPTION).

readxl's R dependencies vary with the Wasm repository build. They may include the following projects and their own dependency trees:

- [cellranger](https://github.com/rsheets/cellranger) and [rematch](https://github.com/r-lib/rematch).
- [tibble](https://github.com/tidyverse/tibble), [pillar](https://github.com/r-lib/pillar), and [pkgconfig](https://github.com/r-lib/pkgconfig).
- [rlang](https://github.com/r-lib/rlang), [vctrs](https://github.com/r-lib/vctrs), and [lifecycle](https://github.com/r-lib/lifecycle).
- [cli](https://github.com/r-lib/cli), [glue](https://github.com/tidyverse/glue), and [utf8](https://github.com/patperry/r-utf8).
- [progress](https://github.com/r-lib/progress), [hms](https://github.com/tidyverse/hms), [prettyunits](https://github.com/r-lib/prettyunits), [R6](https://github.com/r-lib/R6), and [crayon](https://github.com/r-lib/crayon), where required by the available readxl build.
- [cpp11](https://github.com/r-lib/cpp11), used when building readxl's C++ components.

Package source metadata is authoritative for the exact installed version. In an R session, package authorship and licence details can be inspected with `packageDescription("PACKAGE")`; `installed.packages()[, c("Package", "Version", "License")]` lists the local package versions and licences.

The synthetic sample data and handwritten application icons are original to this project. R's built-in example data retains the source attribution given in its respective help pages.

## Optional development tooling

[jsdom](https://github.com/jsdom/jsdom) 27.0.1 is an optional development dependency for DOM integration checks. It is copyright its authors and contributors and is distributed under the [MIT licence](https://github.com/jsdom/jsdom/blob/main/LICENSE.txt). Its transitive dependencies retain their respective package notices and licences. These packages are installed by npm only for development; neither their sources nor their `node_modules` directory is required to serve Tablecraft.
