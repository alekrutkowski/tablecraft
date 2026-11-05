# Operation guide

Tablecraft provides **128 selectable visual operation forms**, a full-script preservation card, and **117 searchable helper entries**. The operation forms produce ordinary R code using `data.table` and magrittr `%>%`. The exact catalog is in [catalog.js](../js/catalog.js), and the compiler is in [compiler.js](../js/compiler.js).

## Coverage

| Category | Forms | Main capabilities |
| --- | ---: | --- |
| Rows | 11 | Conditions, membership, one or several ranges, regex matching, row positions, head/tail, reproducible sampling, unique rows, duplicate rows, missing-row filtering |
| Columns | 11 | Explicit selection, name patterns, type predicates, removal, one or several assignments, renaming, name replacement, column order, type conversion, `lapply(.SD)` transforms |
| Group & summarize | 5 | Named summaries, counts, summaries across columns, group-specific row selection, group identifiers |
| Sort & index | 5 | `setorderv`, expression ordering, keys, secondary indexes, clearing lookup metadata |
| Reshape | 6 | `melt`, multiple-measure melting, `dcast`, transposition, Cartesian value grids, missing combinations |
| Join & combine | 13 | Left/inner/right/full joins, semi/anti joins, rolling joins, non-equi joins, update joins, `.EACHI` summaries, overlap joins, cross joins, row/column binding, set operations, repeated merges |
| Window & rank | 9 | Row numbers, lag/lead, rolling means/sums/extrema/medians/variation, custom rolling functions, ranks, consecutive-run identifiers, occurrence counts, cumulative calculations, changes |
| Missing values | 5 | `nafill`, `setnafill`, `fcoalesce`, `fifelse`, `fcase` |
| Text & dates | 5 | `tstrsplit`, text cleaning, `IDate`/`ITime`, date-time components, fast character-position matching |
| Advanced | 4 | Column profiling, explicit copies, custom `DT[i, j, ...]`, arbitrary R pipe stages |
| Assertions | 54 | 53 focused `stopifnot()` templates plus a custom assertion; the incoming table continues unchanged when checks pass |

Import/export facilities add `fread` and `fwrite` outside the operation list. The helper palette also explains core symbols (`.N`, `.SD`, `.SDcols`, `.I`, `.BY`, `.GRP`, `.EACHI`), matching operators, set operations, constructors, date helpers, and inspection functions.

This is a curated set of forms, not a separate implementation of data.table. An **Advanced** step or direct R editing can use functions and arguments that do not have a dedicated form. Availability of a function depends on the installed R packages. The package's [reference manual](https://rdatatable.gitlab.io/data.table/reference/data.table.html) describes the full API.

## Literal names and R expressions

Fields called **Column**, **Columns**, **Group by**, or **Output column** accept literal names. Do not type `c(...)` into a column list. Enter:

```text
region, unit price, "gross, net"
```

The compiler quotes these as R strings or backtick names where needed. Names containing commas can be quoted; the column picker can also supply an array of names directly.

Fields marked **(R)** accept R expressions. These may contain column references, function calls, arithmetic, logical conditions, or custom functions. In these expressions, use backticks around non-syntactic names:

```r
`unit price` * units
```

An output column written in one `:=` assignment becomes available to the next step. If several expressions in the same assignment depend on each other, split them into successive steps. This follows data.table's [reference semantics](https://rdatatable.gitlab.io/data.table/articles/datatable-reference-semantics.html).

## What the compiler produces

For example, a four-step sales pipeline becomes:

```r
library(data.table)
library(magrittr)

source_dt <- sales

result <- copy(as.data.table(source_dt)) %>%
  .[units >= 2] %>%
  .[, revenue := units * unit_price] %>%
  .[, .(revenue = sum(revenue), orders = .N), by = c("region")] %>%
  setorderv(cols = c("revenue"), order = c(-1L), na.last = TRUE)

result
```

The initial copy protects the original table from subsequent `:=` and `set*` steps. This also means that rerunning a pipeline does not compound earlier updates to the source. Disabled steps are omitted. An enabled step with an incomplete required form field generates an explicit `stop()` and an actionable form diagnostic, so it cannot silently disappear from the calculation.

## Common details that matter

### Sorting, groups, and windows

Window calculations follow the table's current row order. Place a **Sort rows** step before lag/lead, cumulative functions, rolling summaries, or first/last-within-group operations. A fixed rolling window counts rows. Grouped windows restart at each group boundary. See [rolling functions](https://rdatatable.gitlab.io/data.table/reference/froll.html) and [shift](https://rdatatable.gitlab.io/data.table/reference/shift.html).

**Set a key** sorts the data by those columns. **Add a secondary index** retains row order. Both can support lookups, but they have different effects on later windows. See [keys and indexes](https://rdatatable.gitlab.io/data.table/reference/setkey.html).

### Joins

Ordinary **Join tables** uses `merge()` with explicit left and right keys. With several keys, their order defines the correspondence. A left join retains the incoming table's rows; unmatched values from the other table become `NA`.

**Rolling lookup**, **Join by inequalities**, and **Summarize each join match** use native `x[i, ...]` syntax. The incoming table is `x`; the other table is `i`. Results follow the query rows in `i`. An update join modifies the incoming table's matching rows by reference. The [join guide](https://rdatatable.gitlab.io/data.table/articles/datatable-joins.html) gives examples of these different orientations.

For overlap joins, place optional grouping keys first and interval start/end columns last. Every interval needs `start <= end`. Tablecraft copies the other table before setting its required key. See [foverlaps](https://rdatatable.gitlab.io/data.table/reference/foverlaps.html).

### Reshaping

**Pivot longer** uses `melt()`: identifiers stay as columns, while measures become rows. **Melt multiple measures** accepts a list of column sets, `patterns()`, or `measure()`. **Pivot wider** uses a formula such as `region ~ product`; when multiple rows map to the same cell, choose an aggregation function. See [melt](https://rdatatable.gitlab.io/data.table/reference/melt.data.table.html) and [dcast](https://rdatatable.gitlab.io/data.table/reference/dcast.data.table.html).

Transposing mixed numeric and character columns usually promotes values to a shared type. The list-column option preserves mixed values at the cost of a more complex result. See [transpose](https://rdatatable.gitlab.io/data.table/reference/transpose.html).

### Missing values and types

`nafill()` and `setnafill()` work with integer and double columns. For other types, use a conditional assignment or a compatible `fcoalesce()` expression. `fcoalesce()`, `fifelse()`, and `fcase()` require compatible value types. Use `0L` for integer, `0` for numeric, or a quoted string for character values when specifying fallbacks. See [nafill](https://rdatatable.gitlab.io/data.table/reference/nafill.html), [fcoalesce](https://rdatatable.gitlab.io/data.table/reference/coalesce.html), and [fifelse](https://rdatatable.gitlab.io/data.table/reference/fifelse.html).

### Custom pipe stages

A custom stage is the right-hand side of a magrittr pipe:

```r
.[, .(mean_price = mean(unit_price)), by = .(region)]
```

Wrap a multi-statement stage or a nested use of `.` in braces when you need complete control over argument placement:

```r
{
  result <- .[, .(total = sum(units)), by = .(region)]
  setorder(result, -total)
  result
}
```

The last expression must return the table that the next step should receive. Magrittr's [pipe documentation](https://magrittr.tidyverse.org/reference/pipe.html) explains the placeholder and brace rules.


## Assertion templates

Each template uses `stopifnot()` and returns the incoming table. All conditions are visible in the generated R. The tests include a passing and failing case for each assertion.

| Template | Check |
| --- | --- |
| Assert a custom condition | Check any R condition with stopifnot() and keep the table unchanged. |
| Assert at least one row | The table must contain at least one row. |
| Assert no rows | The table must contain no rows. |
| Assert an exact row count | The row count must equal the expected count. |
| Assert a minimum row count | The table must contain at least the minimum number of rows. |
| Assert a maximum row count | The table must not exceed the maximum number of rows. |
| Assert a row-count interval | The row count must be within the inclusive interval. |
| Assert a rule for every row | Every row must satisfy the condition. |
| Assert at least one matching row | At least one row must satisfy the condition. |
| Assert no matching rows | No row may satisfy the forbidden condition. |
| Assert required columns | All required columns must exist. |
| Assert the exact column set | The table must have exactly the specified column names. |
| Assert column names and order | Column names and their order must match exactly. |
| Assert a column count | The number of columns must equal the expected count. |
| Assert unique column names | Column names must not be duplicated. |
| Assert nonblank column names | Column names must contain non-whitespace text. |
| Assert unique whole rows | No complete row may be duplicated. |
| Assert a unique composite key | The selected key combination must be unique. |
| Assert a primary key | Primary-key values must be unique and non-missing. |
| Assert unique column values | The column must contain no duplicate values. |
| Assert uniqueness within groups | Selected values must be unique within each group. |
| Assert a complete table | The table must contain no missing values. |
| Assert non-missing columns | Selected columns must contain no missing values. |
| Assert a non-missing column | The column must contain no missing values. |
| Assert a maximum missing fraction | Every selected column must satisfy the missing-value limit. |
| Assert an observed value per column | Every selected column must contain at least one non-missing value. |
| Assert numeric column types | Every selected column must be numeric. |
| Assert integer column types | Every selected column must have integer storage. |
| Assert character column types | Every selected column must be a character vector. |
| Assert logical column types | Every selected column must be a logical vector. |
| Assert factor column types | Every selected column must be a factor. |
| Assert date or time columns | Every selected column must have a date or date-time class. |
| Assert finite numeric values | The column must contain only finite, non-missing numbers. |
| Assert nonnegative values | Every value must be nonnegative and non-missing. |
| Assert strictly positive values | Every value must be strictly positive and non-missing. |
| Assert inclusive value bounds | Every value must be inside the inclusive bounds. |
| Assert whole-number values | Every value must be a finite whole number. |
| Assert probabilities | Every probability must be finite and between zero and one. |
| Assert allowed values | Every value must belong to the allowed set. |
| Assert nonblank text | Values must contain non-whitespace text and must not be missing. |
| Assert trimmed text | Text values must have no leading or trailing whitespace. |
| Assert a text pattern | Every non-missing text value must match the regular expression. |
| Assert ascending order | Column values must be non-missing and sorted in ascending order. |
| Assert strictly increasing values | Column values must be non-missing and strictly increasing. |
| Assert equal columns | Both columns must contain equal values. |
| Assert one column is no greater | Every left-column value must be no greater than the right-column value. |
| Assert a column total | The column total must match the expected value within tolerance. |
| Assert row totals | Each row total across selected columns must match the expected value. |
| Assert equal table row counts | Both tables must have the same number of rows. |
| Assert matching table columns | Both tables must have the same column names in the same order. |
| Assert matching table schemas | Both tables must have matching column names, order and classes. |
| Assert equal tables | Both tables must contain equal data in the same row and column order. |
| Assert matching foreign keys | Every non-missing source key must occur in the reference table. |
| Assert disjoint table keys | No source key may occur in the reference table. |
