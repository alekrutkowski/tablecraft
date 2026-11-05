/** Configurable, pass-through data-quality checks using ordinary base R. */
export function createAssertionOperations({rName, rString, parseColumns}) {
  const f = (key, label, value = '', extra = {}) => ({key, label, type:'text', default:value, ...extra});
  const expression = (key, label, value) => f(key, label, value, {type:'textarea', required:true, help:'R expression. Missing or indeterminate checks fail unless your expression handles them.'});
  const number = (key, label, value, extra = {}) => f(key, label, value, {type:'number', required:true, min:0, ...extra});
  const column = (key = 'column', label = 'Column') => f(key, label, 'value', {type:'column', required:true});
  const columns = (key = 'columns', label = 'Columns') => f(key, label, 'value', {type:'columns', required:true});
  const table = () => expression('table', 'Comparison table (R name or expression)', '.');
  const cv = value => `c(${parseColumns(value).map(rString).join(', ')})`;
  const get = (p, key = 'column') => `.[[${rString(p[key])}]]`;
  const subset = (p, key = 'columns') => `.[, ${cv(p[key])}, with = FALSE]`;
  const names = c => c.map(value => typeof value === 'string' ? value : value.name);
  const numeric = c => c.find(value => /numeric|integer|double/.test(value.type || '') && !/date|time/i.test(value.type || ''))?.name || names(c)[0] || 'value';
  const text = c => c.find(value => /character|factor/.test(value.type || ''))?.name || names(c)[0] || 'value';
  const secondNumeric = c => c.filter(value => /numeric|integer|double/.test(value.type || '') && !/date|time/i.test(value.type || ''))[1]?.name || numeric(c);
  const literalList = values => values.map(value => /[,\n"'`\\]/.test(value) || value.trim() !== value ? rString(value) : value).join(', ');
  const exists = (p, key) => key === 'column' || key === 'otherColumn'
    ? `${rString(p[key])} %in% names(.)`
    : `all(${cv(p[key])} %in% names(.))`;
  const make = (id, label, description, fields, predicate, extra = {}) => ({
    id:`assert-${id}`, label, category:'Assertions', description,
    functions:['stopifnot', ...(extra.functions || [])],
    fields:[...fields, f('message', 'Failure message', description, {required:true})],
    defaults:c => ({column:numeric(c), columns:literalList([numeric(c)]), otherColumn:secondNumeric(c), groups:literalList([text(c)]), ...(extra.defaults?.(c) || {})}),
    build:p => {
      const guards = fields.filter(field => ['column','columns'].includes(field.type)).map(field =>
        `${rString(`${field.label} must exist in the current table.`)} = ${exists(p, field.key)}`);
      const condition = typeof predicate === 'function' ? predicate(p) : predicate;
      return `{\n  stopifnot(\n    ${[...guards, `${rString(p.message)} = ${condition}`].join(',\n    ')}\n  )\n  .\n}`;
    },
    tips:['The check returns the incoming table unchanged when it passes. FALSE or NA stops the pipeline. Checks such as all() are vacuously true for zero rows; add a non-empty check when required.', ...(extra.tips || [])],
  });
  const operations = [
    make('nonempty', 'Assert at least one row', 'The table must contain at least one row.', [], 'nrow(.) > 0L'),
    make('empty', 'Assert no rows', 'The table must contain no rows.', [], 'nrow(.) == 0L'),
    make('rows-exact', 'Assert an exact row count', 'The row count must equal the expected count.', [number('n','Expected rows',240,{integer:true})], p => `nrow(.) == ${p.n}L`),
    make('rows-min', 'Assert a minimum row count', 'The table must contain at least the minimum number of rows.', [number('n','Minimum rows',1,{integer:true})], p => `nrow(.) >= ${p.n}L`),
    make('rows-max', 'Assert a maximum row count', 'The table must not exceed the maximum number of rows.', [number('n','Maximum rows',1000000,{integer:true})], p => `nrow(.) <= ${p.n}L`),
    make('rows-range', 'Assert a row-count interval', 'The row count must be within the inclusive interval.', [number('min','Minimum rows',1,{integer:true}),number('max','Maximum rows',1000000,{integer:true})], p => `nrow(.) >= ${p.min}L && nrow(.) <= ${p.max}L`),
    make('all-rows', 'Assert a rule for every row', 'Every row must satisfy the condition.', [expression('condition','Row condition (R)','value >= 0')], p => `.[, all(${p.condition})]`, {defaults:c => ({condition:`${rName(numeric(c))} >= 0`})}),
    make('some-rows', 'Assert at least one matching row', 'At least one row must satisfy the condition.', [expression('condition','Row condition (R)','value > 0')], p => `.[, any(${p.condition})]`, {defaults:c => ({condition:`${rName(numeric(c))} > 0`})}),
    make('no-rows', 'Assert no matching rows', 'No row may satisfy the forbidden condition.', [expression('condition','Forbidden row condition (R)','value < 0')], p => `.[, !any(${p.condition})]`, {defaults:c => ({condition:`${rName(numeric(c))} < 0`})}),
    make('columns-exist', 'Assert required columns', 'All required columns must exist.', [columns()], p => `all(${cv(p.columns)} %in% names(.))`, {defaults:c => ({columns:literalList(names(c).slice(0,3))})}),
    make('columns-exact', 'Assert the exact column set', 'The table must have exactly the specified column names.', [columns()], p => `setequal(names(.), ${cv(p.columns)})`, {defaults:c => ({columns:literalList(names(c))})}),
    make('column-order', 'Assert column names and order', 'Column names and their order must match exactly.', [columns()], p => `identical(names(.), ${cv(p.columns)})`, {defaults:c => ({columns:literalList(names(c))})}),
    make('column-count', 'Assert a column count', 'The number of columns must equal the expected count.', [number('n','Expected columns',1,{integer:true})], p => `ncol(.) == ${p.n}L`, {defaults:c => ({n:c.length || 1})}),
    make('column-names-unique', 'Assert unique column names', 'Column names must not be duplicated.', [], 'anyDuplicated(names(.)) == 0L'),
    make('column-names-nonblank', 'Assert nonblank column names', 'Column names must contain non-whitespace text.', [], '!anyNA(names(.)) && all(nzchar(trimws(names(.))))'),
    make('unique-rows', 'Assert unique whole rows', 'No complete row may be duplicated.', [], 'anyDuplicated(.) == 0L', {functions:['anyDuplicated']}),
    make('unique-key', 'Assert a unique composite key', 'The selected key combination must be unique.', [columns('columns','Key columns')], p => `anyDuplicated(., by = ${cv(p.columns)}) == 0L`, {functions:['anyDuplicated'],defaults:c => ({columns:literalList(names(c).slice(0,1))})}),
    make('primary-key', 'Assert a primary key', 'Primary-key values must be unique and non-missing.', [columns('columns','Primary-key columns')], p => `!anyNA(${subset(p)}) && anyDuplicated(., by = ${cv(p.columns)}) == 0L`, {functions:['anyDuplicated'],defaults:c => ({columns:literalList(names(c).slice(0,1))})}),
    make('unique-column', 'Assert unique column values', 'The column must contain no duplicate values.', [column()], p => `anyDuplicated(${get(p)}) == 0L`, {functions:['anyDuplicated'],defaults:c => ({column:names(c)[0] || 'id'})}),
    make('unique-in-groups', 'Assert uniqueness within groups', 'Selected values must be unique within each group.', [columns(),columns('groups','Group columns')], p => `anyDuplicated(., by = union(${cv(p.groups)}, ${cv(p.columns)})) == 0L`, {functions:['anyDuplicated']}),
    make('no-missing', 'Assert a complete table', 'The table must contain no missing values.', [], '!anyNA(.)'),
    make('columns-complete', 'Assert non-missing columns', 'Selected columns must contain no missing values.', [columns()], p => `!anyNA(${subset(p)})`),
    make('column-complete', 'Assert a non-missing column', 'The column must contain no missing values.', [column()], p => `!anyNA(${get(p)})`),
    make('missing-rate', 'Assert a maximum missing fraction', 'Every selected column must satisfy the missing-value limit.', [columns(),number('maximum','Maximum missing fraction',0.05,{max:1})], p => `nrow(.) == 0L || all(vapply(${subset(p)}, function(x) mean(is.na(x)) <= ${p.maximum}, logical(1L)))`),
    make('not-all-missing', 'Assert an observed value per column', 'Every selected column must contain at least one non-missing value.', [columns()], p => `all(vapply(${subset(p)}, function(x) any(!is.na(x)), logical(1L)))`),
    make('numeric-columns', 'Assert numeric column types', 'Every selected column must be numeric.', [columns()], p => `all(vapply(${subset(p)}, is.numeric, logical(1L)))`),
    make('integer-columns', 'Assert integer column types', 'Every selected column must have integer storage.', [columns()], p => `all(vapply(${subset(p)}, is.integer, logical(1L)))`),
    make('character-columns', 'Assert character column types', 'Every selected column must be a character vector.', [columns()], p => `all(vapply(${subset(p)}, is.character, logical(1L)))`, {defaults:c => ({columns:literalList([text(c)])})}),
    make('logical-columns', 'Assert logical column types', 'Every selected column must be a logical vector.', [columns()], p => `all(vapply(${subset(p)}, is.logical, logical(1L)))`),
    make('factor-columns', 'Assert factor column types', 'Every selected column must be a factor.', [columns()], p => `all(vapply(${subset(p)}, is.factor, logical(1L)))`),
    make('date-columns', 'Assert date or time columns', 'Every selected column must have a date or date-time class.', [columns()], p => `all(vapply(${subset(p)}, function(x) inherits(x, c("Date", "POSIXt", "IDate")), logical(1L)))`, {defaults:c => ({columns:literalList([c.find(value => /date|time/i.test(value.type || ''))?.name || names(c)[0] || 'date'])})}),
    make('finite', 'Assert finite numeric values', 'The column must contain only finite, non-missing numbers.', [column()], p => `is.numeric(${get(p)}) && all(is.finite(${get(p)}))`),
    make('nonnegative', 'Assert nonnegative values', 'Every value must be nonnegative and non-missing.', [column()], p => `all(${get(p)} >= 0)`),
    make('positive', 'Assert strictly positive values', 'Every value must be strictly positive and non-missing.', [column()], p => `all(${get(p)} > 0)`),
    make('bounds', 'Assert inclusive value bounds', 'Every value must be inside the inclusive bounds.', [column(),expression('lower','Lower bound (R)','0'),expression('upper','Upper bound (R)','1000000')], p => `all(${get(p)} >= (${p.lower}) & ${get(p)} <= (${p.upper}))`),
    make('integer-values', 'Assert whole-number values', 'Every value must be a finite whole number.', [column()], p => `is.numeric(${get(p)}) && all(is.finite(${get(p)}) & ${get(p)} == trunc(${get(p)}))`),
    make('probability', 'Assert probabilities', 'Every probability must be finite and between zero and one.', [column()], p => `is.numeric(${get(p)}) && all(is.finite(${get(p)}) & ${get(p)} >= 0 & ${get(p)} <= 1)`),
    make('allowed-values', 'Assert allowed values', 'Every value must belong to the allowed set.', [column(),expression('values','Allowed values (R vector)','c("North", "South", "East", "West")')], p => `all(${get(p)} %in% (${p.values}))`, {defaults:c => ({column:text(c),values:`unique(.[[${rString(text(c))}]])`})}),
    make('text-nonblank', 'Assert nonblank text', 'Values must contain non-whitespace text and must not be missing.', [column()], p => `!anyNA(${get(p)}) && all(nzchar(trimws(as.character(${get(p)}))))`, {defaults:c => ({column:text(c)})}),
    make('text-trimmed', 'Assert trimmed text', 'Text values must have no leading or trailing whitespace.', [column()], p => `!anyNA(${get(p)}) && all(as.character(${get(p)}) == trimws(as.character(${get(p)})))`, {defaults:c => ({column:text(c)})}),
    make('text-pattern', 'Assert a text pattern', 'Every non-missing text value must match the regular expression.', [column(),f('pattern','Regular expression','.+',{required:true})], p => `!anyNA(${get(p)}) && all(grepl(${rString(p.pattern)}, as.character(${get(p)})))`, {defaults:c => ({column:text(c)})}),
    make('sorted', 'Assert ascending order', 'Column values must be non-missing and sorted in ascending order.', [column()], p => `!anyNA(${get(p)}) && !is.unsorted(${get(p)})`),
    make('strictly-increasing', 'Assert strictly increasing values', 'Column values must be non-missing and strictly increasing.', [column()], p => `!anyNA(${get(p)}) && !is.unsorted(${get(p)}, strictly = TRUE)`),
    make('column-equality', 'Assert equal columns', 'Both columns must contain equal values.', [column(),column('otherColumn','Other column')], p => `isTRUE(all.equal(${get(p)}, ${get(p,'otherColumn')}, check.attributes = FALSE))`, {defaults:c => ({otherColumn:numeric(c)})}),
    make('column-ordering', 'Assert one column is no greater', 'Every left-column value must be no greater than the right-column value.', [column(),column('otherColumn','Right-hand column')], p => `all(${get(p)} <= ${get(p,'otherColumn')})`, {defaults:c => ({otherColumn:numeric(c)})}),
    make('column-total', 'Assert a column total', 'The column total must match the expected value within tolerance.', [column(),expression('expected','Expected total (R)','0'),number('tolerance','Absolute tolerance',0.000001)], p => `isTRUE(abs(sum(${get(p)}) - (${p.expected})) <= ${p.tolerance})`, {defaults:c => ({expected:`sum(.[[${rString(numeric(c))}]])`})}),
    make('row-totals', 'Assert row totals', 'Each row total across selected columns must match the expected value.', [columns(),expression('expected','Expected row total (R)','1'),number('tolerance','Absolute tolerance',0.000001)], p => `all(abs(rowSums(${subset(p)}) - (${p.expected})) <= ${p.tolerance})`),
    make('same-row-count', 'Assert equal table row counts', 'Both tables must have the same number of rows.', [table()], p => `nrow(.) == nrow(as.data.table(${p.table}))`),
    make('same-column-names', 'Assert matching table columns', 'Both tables must have the same column names in the same order.', [table()], p => `identical(names(.), names(as.data.table(${p.table})))`),
    make('same-schema', 'Assert matching table schemas', 'Both tables must have matching column names, order and classes.', [table()], p => `identical(vapply(., function(x) paste(class(x), collapse = "/"), character(1L)), vapply(as.data.table(${p.table}), function(x) paste(class(x), collapse = "/"), character(1L)))`),
    make('same-data', 'Assert equal tables', 'Both tables must contain equal data in the same row and column order.', [table()], p => `isTRUE(all.equal(., as.data.table(${p.table}), check.attributes = FALSE))`),
  ];
  const joinKeys = p => {
    const left = parseColumns(p.columns), right = parseColumns(p.referenceKeys).length ? parseColumns(p.referenceKeys) : left;
    return `c(${left.map((value, index) => `${rString(value)} = ${rString(right[index] || value)}`).join(', ')})`;
  };
  for (const [id,label,description,disjoint] of [
    ['foreign-key','Assert matching foreign keys','Every non-missing source key must occur in the reference table.',false],
    ['disjoint-keys','Assert disjoint table keys','No source key may occur in the reference table.',true],
  ]) {
    const op = make(id,label,description,[columns('columns','Source key columns'),table(),f('referenceKeys','Reference key columns','',{type:'columns',help:'Leave blank to use the same names as the source keys.'})], 'TRUE', {defaults:c => ({columns:literalList(names(c).slice(0,1))}),functions:['[']});
    op.validate = p => parseColumns(p.referenceKeys).length && parseColumns(p.referenceKeys).length !== parseColumns(p.columns).length ? [{severity:'error',field:'referenceKeys',message:'Use the same number of source and reference key columns.'}] : [];
    op.build = p => `{
  .tc_reference <- as.data.table(${p.table})
  stopifnot(
    "Source keys must exist." = all(${cv(p.columns)} %in% names(.)),
    "Reference keys must exist." = all(${cv(parseColumns(p.referenceKeys).length ? p.referenceKeys : p.columns)} %in% names(.tc_reference)),
    "Source keys must not be missing." = !anyNA(${subset(p)}),
    ${rString(p.message)} = ${disjoint ? `nrow(.[.tc_reference, on = ${joinKeys(p)}, nomatch = NULL, mult = "first"]) == 0L` : `nrow(.[!.tc_reference, on = ${joinKeys(p)}]) == 0L`}
  )
  .
}`;
    operations.push(op);
  }
  return operations;
}
