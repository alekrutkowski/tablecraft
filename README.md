# Tablecraft

<img src="https://www.r-project.org/logo/Rlogo.svg" width="58"> &nbsp;
<img src="https://raw.githubusercontent.com/Rdatatable/data.table/master/.graphics/logo.png" width=40> &nbsp;
<img src="https://magrittr.tidyverse.org/logo.png" width=42>

A visual workbench for building real [R](https://www.r-project.org/about.html) [**data.table**](https://CRAN.R-project.org/package=data.table) pipelines in your browser. Add and configure transformation steps, inspect the generated [**magrittr**](https://CRAN.R-project.org/package=magrittr) `%>%`** chain, edit the R directly, and see the resulting table through [**webR**](https://docs.r-wasm.org/).

Tablecraft is a static HTML, CSS, JavaScript, and WebAssembly/webR application. It needs no application server, database, R installation, package manager, or build step. It can be served from GitHub Pages, including a project subdirectory.

### You can use it at https://alekrutkowski.github.io/tablecraft

## What you can do

- Select several CSV, TSV, fixed-width, `.xls`, and `.xlsx` files together. Search, preview, insert, and delete imported tables.
- Build a pipeline using 128 searchable operation forms: filter, select, assign, group, aggregate, reshape, join, sort, rank, fill missing values, split text, and more.
- Use `fread`, `melt`, `dcast`, `.SD`, `.SDcols`, `:=`, grouping helpers, rolling calculations, and by-reference setters.
- Edit R and synchronize it back into visual steps using argument-aware recognition. Equivalent named, reordered and positional calls recover their guided controls. Unrecognized expressions stay as custom R; complete arbitrary scripts stay in one editable script card.
- Use contextual table, column, and general R completions, F1 help, documentation links, and an optional Code hints switch.
- Add 53 assertion templates or a custom `stopifnot()` assertion without changing the table passed to the next step.
- Explore full-data profiles, frequencies, missingness, correlations, schema and key overlap, with charts and downloadable R code.
- Keep automatic previews on, or pause them and run explicitly for expensive transformations.
- Copy the R, download an `.R` script, export the complete result as CSV, and save or reload a recipe.
- Recover code, pipeline steps, uploaded file contents, and settings after a page refresh.
- Toggle comments in the editor and copied, downloaded or executed R.
- Use a confirmed **Restart app** action to clear the saved workspace and begin again.
- Switch between light and dark themes.

The full operation catalogue is implemented in [`js/catalog.js`](js/catalog.js), with a [coverage guide](docs/operations.md). Its 117-entry helper reference also provides examples for expressions that you can insert into a step or the R editor. Custom expressions allow combinations beyond the supplied forms.

## Run locally

Extract the project, open a terminal in the directory containing `index.html`, and start a static server.

On Windows:

```powershell
py -m http.server 8080
```

On Linux or WSL:

```bash
python3 -m http.server 8080
```

Open [http://localhost:8080](http://localhost:8080). Serve the page over HTTP or HTTPS; opening `index.html` through a `file:` URL is insufficient for browser module and worker loading.

The first R session downloads the webR runtime and R packages. Keep an internet connection for this initialization and for the first Excel import. The interface's stylesheet and editor assets are included locally.

## Deploy to GitHub Pages

1. Put the **contents** of this project in the root of a GitHub repository. Include the `.github` directory and `.nojekyll` file.
2. In the repository, open **Settings → Pages** and choose **GitHub Actions** as the publishing source.
3. Push to the `main` branch. The included [deployment workflow](.github/workflows/deploy.yml) uploads the static files and deploys them.
4. Open the URL shown by the completed deployment. It normally has the form `https://YOUR-USERNAME.github.io/YOUR-REPOSITORY/`.

The workflow also supports a manual run from the **Actions** tab. If your deployment branch has another name, update both `branches: [main]` and the `github.ref` condition in the workflow. No repository secrets are needed.

The workflow follows [GitHub's custom Pages workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages). Tablecraft explicitly uses webR's `PostMessage` channel, which supports GitHub Pages without special cross-origin isolation headers; see [webR's serving guide](https://docs.r-wasm.org/webr/v0.6.0/serving.html).

## Build a transformation

### 1. Choose your data

Use **Data source** to select an example or import a file. Examples include synthetic sales and lookup tables, `iris`, `mtcars`, `airquality`, `PlantGrowth`, `ToothGrowth`, `chickwts`, `CO2`, and `USArrests`.

| Format | Import details |
| --- | --- |
| CSV or other delimited text | Read using `data.table::fread`. Automatic delimiter detection, explicit separators, header handling, skipped rows, missing-value strings, and encoding options are available. Decimal mark detection is automatic; edit `dec` in the R code for an explicit choice. |
| TSV | Read using `fread` with a tab separator. |
| Fixed width | Supply a comma-separated width vector, for example `6,12,3,8`. Optional column names and skipped lines are supported. Reading uses `utils::read.fwf`, then converts the result to a data.table. |
| Excel | Read using `readxl::read_excel`, then convert to a data.table. Choose a sheet by name or number and optionally restrict the cell range. `readxl` is installed on demand. |

Imported R object names follow the filename without its extension: `orders.csv` becomes `orders`, and `sales 2026.csv` becomes `` `sales 2026` ``. Names that are not syntactic R identifiers, including reserved words and names containing punctuation or spaces, are backticked in generated code. Name collisions get a deterministic suffix. Internal runtime names are reserved. The import script contains a statement for **every** imported file, including tables not yet referenced by a pipeline step.

Select or drop several files at once. The pending-file list lets you configure each file separately before importing the batch. File types are detected individually, so one selection may include CSV, TSV and Excel. Fixed-width files need their own widths. Successful imports are kept if another file fails; only failed files remain for correction and retry.

**Available tables** provides searchable, clickable names and a remove button beside each imported or example table. This includes `products` and `customers`. Removed examples are excluded from table lists, generated definitions, analysis choices and automatic companion selection, and stay removed after refresh. **Data source → Example tables → Add back** restores an example explicitly. If a removed table is referenced by the current code, Live preview pauses for review; hand-edited definitions are preserved.

**Available tables** also provides quick previews. **Manage** opens filename, object-name and column-name search, preview, primary-table selection, reselect and delete controls. Table previews do not replace the pipeline result. A table name click inserts it in the last focused R or visual field. Deleted tables are removed from the session; hand-edited code can still refer to them and should be reviewed.

Examples remain useful for multi-table work. Sales can join the product or customer lookup when their keys match. Otherwise the builder makes a deterministic companion from the pipeline at that point, with distinct keys for an ordinary merge. Row-binding examples use a companion with the same schema. Referenced built-in examples in Text mode are added as explicit, reproducible definitions when Run is selected.

For desktop R, put the input files beside the exported script or adjust their paths. The browser preserves ordinary spaces and Unicode in filenames; unsafe path/control characters and collisions may require a displayed alternative filename.

The import limit is **50 MiB per file** by default. This is an app guard, not a guarantee that every file below the limit will fit comfortably in browser memory.

### 2. Add and configure steps

Add an operation to **Pipeline**, select it, and edit its settings. Reorder, disable, duplicate, or remove steps as needed. The enabled steps become one `%>%` chain.

Column-name fields accept names rather than whole R statements. Expression fields accept R expressions. For example, a row filter might be `units >= 3 & region == "North"`; an assignment might be `revenue = units * price`. A label beside each field explains which form is expected.

Use the operation search and helper reference to find functions by name, such as `shift`, `frollmean`, `frank`, `rleid`, `fifelse`, `fcase`, `fcoalesce`, `nafill`, `tstrsplit`, `between`, and `CJ`.

### 3. Inspect and edit the R

The **R code** panel contains an ordinary R script. Typing switches to **Text mode**. Choose **Visual** or **Sync to Visual** to parse the current text, including edited filter, selection, assignment, grouping, sorting and join expressions. Sorting calls such as `setorderv(cols = c("revenue"), order = c(-1L), na.last = TRUE)` remain a visual sort after changing `na.last` to `FALSE` and back. The parser understands represented named, positional, reordered and default arguments, package qualification, integer signs, and ordinary grouped literals. A previously custom stage can become a guided step when its edited expression is recognized. Existing generated forms retain their identity when their expressions are unchanged. Unrecognized pipe stages stay as editable custom R steps. A script that cannot be represented faithfully as one pipeline stays in a complete R script card. Imports, setup statements, comments and the final expression are preserved; switching modes does not restore an older version over your edits.

Recovered stages keep their original R expression while their visual parameters remain unchanged. The parser only offers a guided form when its fields can represent the call: unsupported options, shadowed logical aliases, nonstandard evaluation, or ambiguous syntax remain custom R rather than losing information.

A complete-script card is edited as one unit. Its Add step control is disabled because appending an ordinary pipeline stage could change the meaning of arbitrary R. Choose a new data source to start a fresh guided pipeline, or continue editing the card. **Text draft** retains the last manual draft as a recovery option.

Generated code is hard-wrapped near 88 columns at safe R token boundaries, with indentation following expression nesting. **Format R** applies the same formatter to manual text. Strings and quoted names are preserved rather than split; an indivisible long token may exceed the target width.

**Code hints** proposes columns, table names, base R functions, data.table helpers and symbols available in the running R session. Suggestions appear as you type or with **Ctrl+Space**. Table-qualified and package-qualified expressions narrow the suggestions. Toggle Code hints off to disable popouts. This preference is saved locally. Function signatures and documentation links are available near the editor; **F1** opens function help. Every visual operation also links to the relevant documentation.

**Comments: on/off** controls actual comment text in the editor, copied script, downloaded R and execution. Quoted `#` characters remain data. Switching comments back on restores annotations while retaining your intervening edits. Comments attached to an extensively rewritten block may be dropped when their association is no longer reliable. Blank line boundaries are kept so error locations remain correct. If you start typing a new R comment with comments off, the app shows comments again so the text remains a comment as you type.

F1 help is rendered as plain text. Terminal underline and bold overstrike sequences are removed while Unicode, indentation and examples remain intact.

The script's final expression is the result preview. A final `head(result, 20)` therefore previews those 20 rows. Syntax checks and actual R evaluation remain authoritative; completion suggestions are assistance rather than a full R language server.

The following example can be run with [`tests/fixtures/sales.csv`](tests/fixtures/sales.csv):

```r
library(data.table)
library(magrittr)

orders <- fread("sales.csv")

result <- copy(orders) %>%
  .[, revenue := units * price] %>%
  .[, .(orders = .N, revenue = sum(revenue)), by = .(region)] %>%
  .[order(-revenue)]

result
```

The result contains four regions, with total revenue of 323. The generated pipelines copy their starting table before transformations that may modify it by reference.

### 4. Preview and diagnose

With **Live preview** enabled, changes schedule a new R evaluation after a short delay. The **Result preview** shows the table's dimensions, column types, and a bounded page of rows. Paging reads from the latest computed result.

The initial page size is 100 rows. To keep rendering bounded, the default engine settings show at most 100 columns and shorten text cells after 512 characters, with a notice when either limit applies. The complete values remain available in R and in the CSV export.

Switch Live preview off to edit without repeatedly evaluating the pipeline, then run when ready. Syntax inspection continues while the runtime is available. Preview pagination limits display and serialization; the transformations still operate on the **complete input table**.

R's parser identifies syntax errors, while actual evaluation catches data-dependent errors such as missing columns, incompatible types, invalid joins, and malformed formulas. Diagnostics identify a line or step when possible and provide contextual suggestions. This is an interactive assistant to R's diagnostics, not a replacement for testing an analysis.

### 5. Save your work

- **Copy** in the R code panel places the current script on the clipboard.
- The **Download R script** icon saves the current script as an `.R` file.
- **Export CSV** writes the complete current result using `fwrite`, not only the visible page.
- **Save recipe** stores the visual steps, code state, and import metadata in a JSON file. It does not embed uploaded table bytes. Reload a recipe and reselect its input files when needed.

### Automatic recovery and reset

The app automatically saves the pipeline, canonical R text and comment visibility, manual draft, selected step, recent builder undo/redo history, table metadata, analysis settings, theme, Code hints, Live preview, page size, search fields and editor position. A bounded last-result preview is retained when small enough; it is marked stale until R reconstructs the result.

Workspace metadata is journaled synchronously in localStorage and backed up in IndexedDB. Successfully imported file contents are stored as Blobs in IndexedDB before the import finishes. Reloading the same app address restores the editor immediately, then reimports those files with their original names and options as R starts. Live preview resumes only if it was enabled. With Live preview paused, use Run to recreate the full R result and CSV export.

The header reports whether recovery data is saved. Browser storage quotas, denied storage, private-browsing policies, or manually cleared site data can prevent recovery. Missing files remain listed for reselection. Save recipe is still a portable JSON backup; it deliberately does not embed file bytes. Keep the originals when moving to another browser or app address. Separate deployment paths have separate saved workspaces.

**Restart R** restarts only the worker and keeps the workspace and imported files. **Restart app** opens a confirmation dialog. Confirming clears the saved workspace and file copies, code, imported tables, recent history and preferences, then restores the initial example pipeline. Cancel leaves work intact. A reset marker prevents older open tabs from writing pre-reset state back into the saved workspace. If browser storage cannot be fully cleared, the app reports that limitation.

R's live process is reconstructed after a refresh; arbitrary unscripted R memory and chart bitmap objects are not a saved VM image. Imported originals and the saved script provide the reproducible recovery path.

## Assertions

Choose **Assertions** in Add a step. The 53 templates cover row and column counts, required or forbidden columns, types, duplicate names, whole-row and key uniqueness, nonmissingness, finite values, bounds, signs, integer-valued numbers, dates, text patterns, allowed values, grouped checks and cross-table relationships. There is also a custom assertion form.

Each assertion calls `stopifnot()` and returns the incoming table on success, so it fits anywhere in a transformation chain. A failure stops evaluation and displays the assertion's R diagnostic. Empty-set and missing-value behavior is explicit in the template code; inspect the generated expression for your intended rule.

## Explore statistics and charts

Open **Explore data** from the workspace. Choose a single column, selected columns, a whole table, or a comparison across tables. The current successful pipeline result is available as a table alongside imported and example tables.

- **Column profiles:** observation counts, missing and distinct counts, modes, numeric mean, standard deviation, variance, minimum, quartiles, median, maximum, IQR and related summaries where meaningful.
- **Frequencies and missingness:** value counts, percentages and selected-column missingness using complete source data.
- **Correlations:** Pearson and Spearman correlations, with the number of usable finite pairs.
- **Table and schema comparisons:** dimensions, completeness, duplicate rows, memory size and columns/types across tables.
- **Key overlap:** distinct shared, left-only and right-only keys, duplicates and overlap ratios, with an explicit option for missing keys.
- **Charts:** histograms, frequency bars, box plots, scatter plots, correlation heatmaps, missingness bars, table sizes and key overlap.

The analysis dialog displays its full R script, with **Copy** and **Download R**. Calculations run on the full selected tables; the display is bounded. The script documents chart limits, such as a maximum number of plots and the bounded, evenly spaced rows drawn in scatter plots. Summary calculations do not use only the displayed preview rows. Independent exploration preserves the main pipeline result and CSV export.

## Error assistance

R diagnostics include **Ask Mistral about this error**. This explicitly opened link contains a URL-encoded prompt with the error and the executed R code. Nothing is sent merely because an error occurs. The code itself may contain literal data or file names, so review it before opening or sending an external prompt. **Copy error + code** is available when the URL is too long for the external service or a browser. Mistral's handling of the `q` parameter is controlled by that external service.

## Performance and runtime details

The UI runs in the main browser thread, while R runs in a web worker. R execution requests are serialized and stale results are not allowed to overwrite newer edits. The preview sends a bounded set of rows to JavaScript instead of serializing the full table after every transformation. The full result remains in R for paging and export.

webR is pinned to **v0.6.0**. R packages are installed from webR's compatible Wasm repository. Their installed versions are runtime-dependent; the app does not claim a frozen CRAN snapshot. Initial packages include `data.table`, `magrittr`, `jsonlite`, and `bit64`; Excel adds `readxl` and its dependencies. The runtime also discovers package references in user R code and installs missing compatible packages before execution. This covers `library()`, `require()`, and namespace calls such as `package::function()`. Installation requires a package binary supported by the webR repository; ordinary native R binaries cannot run in WebAssembly. Large integer values are displayed as strings to avoid JavaScript precision loss.

Some transformations create large copies or expand the number of rows substantially, especially joins, Cartesian products, reshaping, and `copy`. Available memory depends on the browser and device. For large work, pause Live preview, reduce the input size, or take the generated script to desktop R.

The GitHub Pages compatible `PostMessage` channel cannot cooperatively interrupt running R code. Restarting R terminates the worker and creates a fresh session. Interactive R prompts such as `readline`, `menu`, and `browser` are not supported by this channel. See [webR worker communication](https://docs.r-wasm.org/webr/v0.6.0/communication.html).

Tablecraft does not send imported tables to an application server. Network requests are used to load the runtime and packages. Code that you add yourself can perform whatever network operations are supported by webR and the browser.

Bootstrap **6.0.0-alpha.1** is used as requested. It is an alpha release and targets modern browsers; see the [Bootstrap 6 announcement](https://blog.getbootstrap.com/2026/10/08/bootstrap-6-alpha/). CodeMirror **5.65.21** provides the R editor. There is no Node.js runtime dependency for deployment.

## Project files and checks

| Location | Purpose |
| --- | --- |
| `index.html` | Application entry point. |
| `js/` | UI, operation catalogue, pipeline compiler, and webR integration. |
| `css/` | Application styling and themes. |
| `vendor/` | Pinned browser UI dependencies. |
| `.github/workflows/deploy.yml` | Buildless GitHub Pages deployment. |
| `tests/` | Compiler checks, packaging checks, and synthetic import fixtures. |
| `docs/` | Operation details, acceptance scenarios, and dependency notices. |

Optional development checks use Node.js's built-in test runner:

```bash
node --test tests/*.test.mjs
node tests/check-project.mjs
```

No packages need to be installed for these checks. Browser acceptance scenarios and expected import results are in [`docs/acceptance.md`](docs/acceptance.md). The small files in [`tests/fixtures`](tests/fixtures) are synthetic and can be used without personal data.

Optional DOM integration checks exercise the actual UI and vendored CodeMirror with a controlled R-engine test double. Install the development dependency only when running these checks:

```bash
npm install
npm run test:ui
npm run test:storage
```

The jsdom checks cover interaction, refresh recovery, reset confirmation, stale-action cancellation and scheduling logic. The storage suite uses fake-indexeddb to verify committed file writes, exact byte recovery, quota fallback, corruption recovery and reset ordering. They do not substitute for a real browser's layout and rendering checks. The deployed app does not use jsdom, fake-indexeddb, npm, or a Node.js server.

An additional integration harness runs the production engine against actual webR, including the generated operation cases, imports, export, integer precision, restart behavior, and the script's final expression:

```bash
npm install --no-save webr@0.6.0
node tests/runtime.integration.mjs
```

Use a current Node.js release for optional integration checks. The real-R harness downloads Wasm packages unless a compatible local package directory is supplied; its source documents the optional environment variables. Executed checks and verification limits are recorded in [`docs/verification.md`](docs/verification.md).

## Dependencies and acknowledgments

Tablecraft's MIT licence covers its original application code. Upstream software retains its own copyright and licence. Thank you to the maintainers and contributors of these projects:

| Dependency | Contribution | Attribution and licence |
| --- | --- | --- |
| [webR](https://github.com/r-wasm/webr) | R compiled to WebAssembly and browser worker API. | webR authors; distribution binaries GPL-3.0, supporting code generally MIT. See [webR's full software notices](https://github.com/r-wasm/webr/blob/main/LICENSE.md), which also identify bundled components. |
| [R](https://www.r-project.org/) | Language, base packages, and built-in example datasets. | R Core Team and R contributors; [GPL-2.0 or GPL-3.0](https://www.r-project.org/Licenses/). Dataset-specific sources remain available through their R help pages. |
| [data.table](https://rdatatable.gitlab.io/data.table/) | Table transformations, reshaping, joins, import, and export. | data.table authors and contributors; [MPL-2.0 or the accompanying licence file](https://rdatatable.gitlab.io/data.table/web/packages/data.table/index.html). |
| [magrittr](https://magrittr.tidyverse.org/) | `%>%` and placeholder semantics. | Stefan Milton Bache, Hadley Wickham, Lionel Henry, and contributors; [MIT](https://magrittr.tidyverse.org/LICENSE.html). |
| [jsonlite](https://jeroen.r-universe.dev/jsonlite) | Bounded R-to-JavaScript result serialization. | Jeroen Ooms and contributors, including Lloyd Hilaiel's bundled YAJL; [MIT and package notices](https://github.com/jeroen/jsonlite). |
| [bit64](https://github.com/r-lib/bit64) and [bit](https://github.com/r-lib/bit) | Faithful handling of 64-bit integer columns. | Michael Chirico, Jens Oehlschlägel, and contributors; GPL-2.0 or GPL-3.0, with authors and notices in each source repository. |
| [readxl](https://readxl.tidyverse.org/) | Excel import. | Hadley Wickham, Jennifer Bryan, Posit, and contributors; [MIT](https://readxl.tidyverse.org/LICENSE.html), with additional [embedded-library credits](https://readxl.tidyverse.org/authors.html). |
| [Bootstrap](https://getbootstrap.com/) | Base layout and controls. | The Bootstrap Authors; [MIT](https://github.com/twbs/bootstrap/blob/main/LICENSE). |
| [CodeMirror 5](https://codemirror.net/5/) | Syntax-highlighted editable R code. | Marijn Haverbeke and contributors; [MIT](https://github.com/codemirror/codemirror5/blob/master/LICENSE). |
| [fake-indexeddb](https://github.com/dumbmatter/fakeIndexedDB) (development only) | IndexedDB behavior for optional recovery and reset tests. | Jeremy Scheff and contributors; [Apache-2.0](https://github.com/dumbmatter/fakeIndexedDB/blob/master/LICENSE). It is not loaded by the app. |
| [jsdom](https://github.com/jsdom/jsdom) (development only) | Optional DOM interaction and scheduling tests. | jsdom authors and contributors; [MIT](https://github.com/jsdom/jsdom/blob/main/LICENSE.txt). npm resolves its development dependency tree. It is not loaded by the app. |

Excel import also uses the dependency packages resolved by webR, including `cellranger`, `tibble`, and their upstream dependencies. Their licences and authorship remain in the installed packages' `DESCRIPTION`, `LICENSE`, `COPYRIGHTS`, and `AUTHORS` files, where present. The exact dependency set follows the available Wasm build of readxl rather than this project's release. [`docs/third-party-notices.md`](docs/third-party-notices.md) records the included browser assets' licence text and links to the upstream dependency trees. CodeMirror's R mode and bracket/hint add-ons are included under its licence. Icons are original SVG and fonts come from the operating system.

The bundled sales and import fixtures are original synthetic examples. They do not describe real customers, employees, or transactions.
