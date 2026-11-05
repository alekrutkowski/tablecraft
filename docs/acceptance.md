# Acceptance scenarios

These are reproducible browser checks, with explicit expected results. This document is a test procedure, not a claim that every browser or device has been tested. Serve the project over HTTP or HTTPS and wait for the R runtime to become ready.

The completed automated checks and remaining verification limits are recorded separately in [`verification.md`](verification.md).

## Import fixtures

| File | Settings | Expected result |
| --- | --- | --- |
| `tests/fixtures/sales.csv` | CSV, header on, remaining defaults. | 8 rows, 7 columns. `sum(units)` is 26; `sum(units * price)` is 323. |
| `tests/fixtures/products.csv` | CSV, header on. | 3 rows and 3 columns: `product`, `family`, `unit_cost`. |
| `tests/fixtures/sensors.tsv` | TSV, header on, `NA` as a missing-value string. | 6 rows, 3 columns, two missing `temperature` values. |
| `tests/fixtures/staff.fwf` | Fixed width; widths `6,12,3,8`; no header; names `employee_id,name,age,salary`. | 4 rows, 4 columns; first employee is `E00001`, name `Ada`, age 36; salaries sum to 244000. |
| `tests/fixtures/workbook.xlsx` | Sheet `Sales`, header on. | 8 rows, 7 columns; totals match the CSV fixture. |
| `tests/fixtures/workbook.xlsx` | Sheet `Products`, header on. | 3 rows, 3 columns. |
| `tests/fixtures/workbook.xlsx` | Range `Sales!A1:D4`, header on. | 3 rows, 4 columns; order IDs 1001, 1002, 1003. |

Expected fixture metadata is also supplied in `tests/fixtures/expected.json`. Excel date/time display may include a time component; the calendar dates should still match the CSV file.

## Transformation correctness

Using the sales fixture, create `revenue = units * price`, group by `region`, and sum `revenue`. Sort descending. Expected rows:

| region | revenue |
| --- | ---: |
| East | 116.5 |
| North | 109.5 |
| South | 61 |
| West | 36 |

Filter to `region == "North"` and inspect order IDs 1001, 1003, 1007. Add a distinct operation on `region` and expect four regions on the unfiltered source. Join the products fixture on `product` and expect eight rows with non-missing `family` and `unit_cost`.

Melt the sales fixture with `order_id` as identifier and `units,price` as measure columns. Expect 16 rows. Cast back with `order_id ~ variable` and `value` as the value column. Expect 8 rows with `order_id`, `units`, and `price`.

For the sensors fixture, group by `sensor` and fill temperature with last observation carried forward. Expect `12.5,12.5,13.1` for A and `21.4,20.9,20.9` for B. Shift within each sensor and verify that the first observation of each group has a missing lag.

## Editing, diagnostics, and scheduling

1. Change a visual step and confirm that both the R code and preview update.
2. Type directly in the R editor. Confirm Text mode appears and visual step controls cannot overwrite the draft.
3. Edit a filter, assignment and grouping in Text mode, then use **Sync to Visual**. Confirm the edited values appear in the corresponding forms. Custom stages and unrelated setup statements must survive the switch. Use **Text draft** to recover the previous manual draft.
4. Remove a closing bracket in the R editor. Confirm a syntax diagnostic identifies the error without replacing the last good result.
5. Refer to a nonexistent column. Confirm that R's runtime error is shown with a useful suggestion.
6. Pause Live preview. Make several changes and confirm no new table evaluation occurs until an explicit run. Syntax checks may still run.
7. Make several quick edits while a calculation is pending. Confirm the eventual result corresponds to the latest edit.
8. Disable a pipeline step and confirm the generated code omits it. Re-enable and move it, then confirm order and result change together.

## Output and persistence

1. Copy the current R code and compare it with the editor contents.
2. Download the R script and confirm it contains its imports and source-table setup.
3. Export the result as CSV. Confirm the export includes every result row, not just the visible preview page.
4. Import files, edit the pipeline and text, and refresh the page. Confirm code, mode, files, options and preferences recover without reselection. In a different browser or app address, open a portable recipe and reselect its files.
5. Confirm the recipe JSON contains file metadata but does not embed the imported file bytes. R code explicitly typed into the recipe is retained as text.
6. Toggle the theme and reload. Confirm the preference is retained and code, controls, diagnostics, and table remain readable in both themes.

## Layout and deployment

- Check keyboard access to source controls, step controls, forms, the code editor, and the result pager.
- At a narrow viewport, verify panels stack or remain accessible without clipping controls.
- Scroll a wide result horizontally and verify column headers remain usable.
- Serve the application under a path such as `/tablecraft/` and verify all local assets and modules load.
- On GitHub Pages, confirm the app starts without requiring COOP or COEP headers.
- If runtime download is blocked, verify that the UI reports the problem and that a retry is available.

## Boundaries

The application runs arbitrary user-authored R in webR; it does not prove that statistical or business logic is correct. Package availability, browser memory, unusual Excel formats, and very large joins need separate testing for the intended deployment. Restarting the worker is a reset, not a cooperative R interrupt.


## Multi-table imports and names

1. Select `sales.csv`, `products.csv` and `sensors.tsv` in one file picker operation. Configure each independently and import all three. Verify that the generated R contains three reader assignments, even if the pipeline uses only the first table.
2. Try filenames such as `sales 2026.csv`, `unit-prices.csv`, `if.csv` and `2026.csv`. The object names should retain their filename stems, with backticks in generated R wherever necessary. Repeated names must receive a collision suffix.
3. Search Available tables and the manager by filename, R name, and a column name. Preview a secondary table without replacing the pipeline result; export should still export the pipeline.
4. Focus a text or visual expression and click a table name. Confirm a non-syntactic name inserts with backticks. In a table field, typing a known raw name must compile to a quoted object reference.
5. Import a batch containing a malformed file. Successful imports remain available; the failed file and its settings remain for retry.
6. Delete an unused table. Verify it disappears from the manager and generated default imports. If edited R still refers to a deleted table, the UI should keep the text for review and expose any R error.
7. With no uploads, choose iris and add a join. Confirm a distinct Species lookup example is defined, the merge keys are Species, and the result has 150 rows. Try a row bind and verify both tables have compatible columns.

## Hints, help and synchronization

1. Type part of a column or table name in a visual field. Use Arrow keys and Enter or Tab to accept a popout. Escape dismisses it.
2. Use Ctrl+Space in R code. Check backticked names, quoted column strings, `table$column`, `stats::median`, and installed package functions.
3. Toggle Code hints off, then type again. Automatic and explicit completion popouts should be disabled. Reload and verify the preference persists.
4. Put the cursor on `mean` or `stats::median`, press F1, and use the clickable help control. Verify the help text or primary documentation link. Check the documentation links beside a visual operation.
5. Edit imports, helper functions, filters, groupings and final expressions in Text mode. Repeated Visual/Text switches must retain their meaning. A script with loops or unrelated statements should remain editable as a full script when it cannot be represented safely as guided steps.
6. Format long nested code and verify line breaks near 88 characters with logical indentation. Literal strings, raw strings and backticked names must retain their contents.

## Assertions, packages and analysis

1. Insert a nonmissing-column assertion on a complete table, then on the sensors temperature column with NA. The first should pass through the same rows; the second should stop with a diagnostic. Test key uniqueness and a cross-table membership check similarly.
2. Use a webR-compatible package absent from the initial package set with `library(package)` and separately with `package::function()`. Verify automatic installation followed by execution. An unavailable package should produce a useful error, without endlessly restarting the run.
3. Open Explore data. Run a numeric column profile, a categorical frequency chart, whole-table missingness, two-column scatter and correlation, then cross-table schema and key-overlap comparisons.
4. Confirm numeric profile values against `summary()`, `sd()` and `quantile()` in R. Test an empty column, all-NA numeric column, constant values and integer64 columns. Plots should explain unsuitable or empty inputs.
5. Copy and download each analysis script. Run it in a fresh R session with the referenced files. Summary values must match; no Tablecraft-private runtime objects should be needed.
6. The pipeline result, paging and CSV export must stay unchanged after an independent table preview, a successful analysis, and an analysis error.
7. Trigger an R error containing spaces, ampersands, quotes and newlines. The Mistral link's decoded `q` parameter must contain the error and exact executed code. No external request should happen until the user opens the link.


## Parser robustness, recovery, reset and help

1. In the initial pipeline, change `na.last = TRUE` to `FALSE` in Text mode, return to Visual, and select the sort step. Confirm the checkbox is off. Change it back to `TRUE`, return to Visual, and confirm it remains a guided sort with the checkbox on.
2. Repeat with named arguments reordered and with equivalent represented positional calls. Confirm unsupported options remain exact custom R, and that changing a custom stage back to supported code recovers its guided form.
3. Import two files with spaces or punctuation in their names. Change an import option, pause Live preview, edit text, disable hints, change theme and refresh. Confirm exact input contents, names, options, text and settings are restored. Run explicitly and verify the complete result.
4. Turn Comments off. Confirm real comments are absent from the editor, copied/downloaded R and executed code, but hashes in strings and raw strings remain. Edit a value, turn comments on and confirm both the edit and retained annotations are present. Refresh while comments are off and repeat.
5. Open F1 help for `setorderv` and `fread`. Check headings, indentation and examples without underscore/backspace or ANSI artifacts.
6. Open Restart app and cancel: code, files, history and settings must be unchanged. Confirm the action: the initial example returns, imported files and old code disappear, and another refresh does not bring them back.
7. Start a slow recipe read or file operation, then confirm Restart app. Its obsolete completion must not alter or save into the new workspace. Ctrl+Enter while storage is being cleared must not start an R job.
8. Simulate blocked or quota-limited browser storage. The app must identify incomplete recovery, keep current in-memory work usable, and permit a manual recipe export. Missing saved files must be listed for reselection without silently substituting another file.

9. Remove `products` from Available tables and `customers` from Manage. Refresh: neither should reappear in active table lists or analysis choices. Add a join and confirm it uses a new compatible companion instead of restoring either deleted lookup. Use Example tables → Add back to restore one explicitly.
