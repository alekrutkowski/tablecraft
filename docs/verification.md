# Verification record

Tablecraft 2.1.0 revision checks completed on 5 November 2026. Fresh results are distinguished from earlier 2.0.0 evidence carried forward without a full rerun.

The [2.1 revision record](revision-verification.json) contains the current summary and fresh production-runtime feature and help reports. The [2.0 runtime record](runtime-verification.json) is unchanged: its detailed outcomes remain historical evidence.

## Checks executed for 2.1

| Check | Result | Coverage |
| --- | --- | --- |
| Dependency-free JavaScript checks | 92 / 92 passed | Compiler, diagnostics, parser, formatter, assertions, completions, help cleanup, comment restoration, and analysis generation. |
| Static project checks | 4 / 4 passed | Relative assets, module resolution, deployment configuration, and clean project text. |
| Storage integration scenarios | 13 / 13 passed | Synchronous journal, backup recovery, exact file bytes, deletion, quota/denial/abort handling, reset ordering, and stale-tab writes. |
| DOM interaction scenarios | 36 / 36 passed | Actual HTML, app code, and CodeMirror under jsdom with a controlled R-engine double. Final run: 14.42 seconds, zero failed/skipped tests. |
| Supported parser variants in actual R | 86 / 86 across 53 operation types | Original parse trees retained; rebuilt visual fields preserve values, keys, and secondary indexes. |
| Unsupported parser variants in actual R | 34 / 34 passed | Exact fallback preserves the R parse tree. |
| Qualified functions with masked names | 3 / 3 passed | Namespace preservation for `data.table::setorderv`, `data.table::melt`, and `data.table::shift`. |
| Catalogue formatter/mode roundtrips | 129 / 129 passed | Matching R parse trees, plus five arbitrary scripts and ten quoted identifiers. |
| Generated R behavior cases | 201 / 201 passed | Regenerated transformations, pipeline combinations, 108 positive/negative assertion cases, joins, reshaping, rolling functions, and source preservation. |
| Comment handling in actual R | 19 / 19 passed | Parse-tree preservation, hashes in literals/operators, safe pipes, and restored comments after editing/wrapping. |
| Production-runtime feature groups | 9 / 9 passed | Naming, package requests, isolated previews/analysis, serialized execution, completions/help, and table deletion/restart. |
| Installed R help pages | 2 / 2 passed | Full `setorderv` and `fread` documentation, clean plain text, legacy-overstrike recovery, unchanged options/results, and missing-topic handling. |

Counts describe different kinds of checks with overlapping coverage. They should not be summed as distinct application features. Assertion cases deliberately include inputs that must be rejected. Expected melt coercion warnings do not count as failures.

### Revision-specific coverage

Storage tests use `fake-indexeddb` and controlled localStorage. They verify immediate journaling, independent backup recovery, exact binary bytes and Unicode filenames, corrupt snapshots, transaction aborts, storage failures, path isolation, and reset protection against queued writes or an older tab.

DOM scenarios restore edited code, hidden comments, settings, searches, theme, multiple files, and import options in a fresh application instance. Full reset clears workspace state, files, and undo history. Delayed recipe reads cannot restore cleared work; Run shortcuts cannot enter R while reset awaits storage. Removed example tables stay removed after refresh and are not silently selected for new joins.

The comment toggle affects displayed, copied, downloaded, and executed R. Unchanged visibility roundtrips restore annotated source exactly. Ordinary edits, line insertion/deletion, and formatting retain associated comments without restoring old executable text. Comments in extensively replaced blocks may be dropped when their association is ambiguous. A newly typed actual comment switches comments on so its remaining text stays a comment.

Parser regressions include editing `setorderv(..., na.last = TRUE)`, positional/named arguments, namespace-qualified functions, and unsupported forms. Original-source preservation and equivalent rebuilding of visual fields are checked separately. The fresh runtime feature suite also verifies that previews and analyses share one queue and preserve the main result under mutations or errors. Both uploaded and example table removal are covered.

Real help-page tests reproduce legacy terminal overstrikes, verify clean output from R before JavaScript cleanup, recover cached legacy text, and confirm unchanged R formatting options and pipeline results.

## Carried-forward 2.0 evidence

These checks passed during the 2.0.0 verification on 5 November 2026 and were **not rerun in full for this revision**:

| Earlier check | Recorded result | Scope |
| --- | --- | --- |
| Core production webR runtime groups | 23 / 23 passed | Imports, parsing, paging, complete CSV export, exact filenames, rollback, hard stop, and session restoration. Details remain in `runtime-verification.json`. |
| Actual R analysis scenarios | 48 / 48 passed | All eight chart types, expected statistics, complete data beyond preview limits, empty/nonnumeric inputs, list columns, schema comparisons, and key overlap. |
| Built-in dataset dimensions | 12 / 12 verified | Declared dimensions matched actual R data in the earlier core-runtime suite. |

The unchanged baseline JSON also retains eight earlier feature groups and 201 earlier operation outcomes. They were not overwritten with the fresh nine-group report or the result of this revision's separate 201-case behavior rerun.

Earlier core tests covered CSV, TSV, fixed-width and Excel inputs, exact 64-bit values, Unicode filenames, missing/non-finite values, export fidelity, source preservation, and stopping a nonterminating `repeat {}` before restoring uploaded data. Earlier analysis checks verified finite-only statistics, correlations, missing-key policies, and list-column duplicate rows. A 10,001-row table confirmed full-data summaries. All eight chart types ran using R's PDF device; these remain baseline results.

## Environment and limits

Actual R checks used webR's `PostMessage` channel under Node.js. Production `REngine` was used for runtime-feature and help tests. Compatible Wasm R packages were mounted locally because the Node package downloader could not use the environment's network proxy. Package discovery/installation requests and local execution were verified; first-time browser downloads were not.

| Component | Tested version |
| --- | --- |
| Node.js | 24.22.1 |
| webR / R | 0.6.0 / 4.6.0 |
| data.table / magrittr | 1.18.6.1 / 2.0.5 |
| jsonlite / bit64 / readxl | 2.0.0 / 4.8.6 / 1.5.0.1 |
| CodeMirror | 5.65.21 |
| jsdom / fake-indexeddb | 27.0.1 / 6.2.5 |

The managed browser preview service was again unavailable. No real browser was used for layout, responsive breakpoints, pointer/focus behavior, chart canvas appearance, remote CDN startup, or native storage durability. DOM and storage test doubles do not establish those behaviors. Node graphics tests do not verify browser image-bitmap transfer. The [acceptance scenarios](acceptance.md) describe manual browser checks.

The deployment workflow and relative paths were checked locally; no deployment occurred. No cross-browser certification, performance benchmark, or practical dataset-size guarantee is claimed. Browser quotas, eviction, and available memory vary. The 50 MiB file cap is an application guard. Runtime/UI library versions are pinned; compatible R package versions may change with the package repository.

## Reproduce the checks

Dependency-free, DOM, and storage checks:

```bash
npm test
npm install
npm run test:ui
npm run test:storage
```

Actual R checks using the optional test dependency:

```bash
npm install --no-save webr@0.6.0
node tests/compiler.webr.mjs
node tests/comments.webr.mjs
node tests/help.webr.mjs
node tests/runtime-features.integration.mjs
```

The parser harness expects data.table and magrittr in webR's library. To reproduce the recorded run, set `TABLECRAFT_R_LIBRARY` to a compatible unpacked **Wasm** library, not a native desktop R library:

```bash
export TABLECRAFT_R_LIBRARY=/absolute/path/to/compatible/wasm/library
node tests/parser.webr.mjs
```

The help, runtime-feature, core-runtime, and analysis harnesses support the same variable. Production-runtime harnesses otherwise use webR's package installer with ordinary network access. `TABLECRAFT_HELP_REPORT` and `TABLECRAFT_FEATURE_REPORT` select JSON report destinations; script headers document other module/temporary-directory overrides.

To regenerate behavior cases and rerun the broader core-runtime and analysis suites, including the baseline checks:

```bash
node tests/generate-operations.mjs
node tests/runtime.integration.mjs
node tests/analysis.webr.mjs
```

The core-runtime harness executes `tests/operations.integration.R` and can write its report to `TABLECRAFT_REPORT`. Development dependencies are unnecessary to serve or publish the app.
