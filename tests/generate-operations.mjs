// Regenerate the real-R integration cases after editing operation recipes.
// Usage: node tests/generate-operations.mjs
import {writeFileSync} from 'node:fs';
import {OPERATIONS} from '../js/catalog.js';
import {compilePipeline, defaultsFor, rString} from '../js/compiler.js';
import {assertionCases, ASSERTION_FIXTURE_R} from './assertion-cases.mjs';

const columns = [
  {name:'order_id',type:'integer'}, {name:'date',type:'IDate'},
  {name:'region',type:'character'}, {name:'product',type:'character'},
  {name:'units',type:'integer'}, {name:'unit_price',type:'numeric'},
  {name:'channel',type:'character'}, {name:'customer_id',type:'integer'}
];
const overrides = {
  'non-equi-join':{table:'ranges'},
  'overlap-join':{table:'interval_lookup'},
  'bind-columns':{table:'sales'}
};
// Assertions deliberately reject bad inputs, so their dedicated cases below
// supply both passing and failing data instead of treating every default as true.
const cases = OPERATIONS.filter(op => op.category !== 'Assertions').map(op => ({
  name:op.id,
  code:compilePipeline({sourceCode:op.id === 'overlap-join' ? 'intervals' : 'sales',steps:[{id:op.id,op:op.id,params:{...defaultsFor(op.id,columns),...overrides[op.id]}}]}).code
}));
const S = (op,params,id=op) => ({id,op,params});
cases.push({name:'seed-pipeline',code:compilePipeline({sourceCode:'sales',steps:[
  S('filter',{condition:'units >= 2'}),
  S('mutate',{name:'revenue',expression:'units * unit_price'}),
  S('summarize',{expressions:'revenue = sum(revenue), orders = .N',groups:'region'}),
  S('sort',{columns:'revenue',directions:'-1'})
]}).code});
cases.push({name:'melt-dcast-roundtrip',code:compilePipeline({sourceCode:'sales',steps:[
  S('select',{columns:'order_id, units, unit_price'}),
  S('melt',{idColumns:'order_id',valueColumns:'units, unit_price',variableName:'variable',valueName:'value'}),
  S('dcast',{formula:'order_id ~ variable',valueColumns:'value',aggregate:'',fill:'NA'})
]}).code});
cases.push({name:'grouped-windows',code:compilePipeline({sourceCode:'sales',steps:[
  S('sort',{columns:'region, date',directions:'1'}),
  S('shift',{column:'units',name:'previous',groups:'region'}),
  S('rolling',{column:'units',name:'average',n:3,groups:'region'}),
  S('rank',{columns:'units',directions:'-1',name:'dense_rank',groups:'region'}),
  S('fill-na',{columns:'previous',groups:'region',type:'const',fill:'0'})
]}).code});
cases.push({name:'odd-column-names',code:compilePipeline({sourceCode:'odd_names',steps:[
  S('mutate',{name:'with`tick',expression:'`a b` * 2'}),
  S('rename',{old:'"a,b"',new:'plain'}),
  S('select',{columns:['a b','plain','with`tick']})
]}).code});
['frollmin','frollmax','frollprod','frollmedian','frollvar','frollsd'].forEach(fun => cases.push({
  name:fun,
  code:compilePipeline({sourceCode:'sales',steps:[S('rolling',{column:'units',name:'rolled',fun,n:3,removeNA:true})]}).code
}));
cases.push({name:'ISO-year',code:compilePipeline({sourceCode:'sales',steps:[S('date-part',{column:'date',name:'iso_year',part:'isoyear'})]}).code});
cases.push({name:'semi-join-duplicate-keys',code:compilePipeline({sourceCode:'duplicate_keys',steps:[S('semi-join',{table:'duplicate_lookup',leftKeys:'id'})]}).code});
cases.push({name:'grid-with-formal-names',code:compilePipeline({sourceCode:'formal_names',steps:[S('expand-grid',{columns:'sorted,unique'})]}).code});
cases.push({name:'complete-with-formal-names',code:compilePipeline({sourceCode:'formal_names',steps:[S('complete',{columns:'sorted,unique'})]}).code});
cases.push({name:'adaptive-rolling-helper',code:compilePipeline({sourceCode:'sales',steps:[S('custom',{expression:'.[, adaptive_mean := frollmean(units, frolladapt(date, n = 7L, partial = TRUE), adaptive = TRUE, na.rm = TRUE)]'})]}).code});
cases.push({name:'mergelist-helper',code:compilePipeline({sourceCode:'sales',steps:[S('custom',{expression:'{ mergelist(list(., new_lookup), on = "order_id", how = "left", mult = "all", join.many = FALSE) }'})]}).code});
cases.push({name:'setmergelist-helper',code:compilePipeline({sourceCode:'sales',steps:[S('custom',{expression:'{ setmergelist(lapply(list(., new_lookup), copy), on = "order_id", how = "left") }'})]}).code});
cases.push({name:'trailing-comment-pipe',code:compilePipeline({sourceCode:'sales',steps:[S('custom',{expression:'.[] # keep all\n# then take two'}), S('head-tail',{n:2})]}).code});
cases.push(...assertionCases());
const fixture = `
library(data.table)
library(magrittr)
sales <- data.table(
  order_id = 1:12,
  date = as.IDate("2025-01-01") + 0:11,
  region = rep(c("North", "South", "East"), 4L),
  product = rep(c("Alpha", "Beta"), 6L),
  units = c(1L, 4L, NA_integer_, 2L, 10L, 5L, 2L, 8L, 3L, 1L, 4L, 6L),
  unit_price = rep(c(9.5, 12.5, 7.5), 4L),
  channel = rep(c("Web", "Shop"), 6L),
  customer_id = rep(1:4, 3L)
)
sales_before <- copy(sales)
lookup <- copy(sales[1:3])
ranges <- data.table(lower = c(0L, 5L), upper = c(4L, 12L))
intervals <- data.table(start = c(1L, 5L, 8L), end = c(3L, 7L, 10L), value = 1:3)
interval_lookup <- data.table(start = c(2L, 6L), end = c(4L, 9L), note = c("A", "B"))
odd_names <- data.table(
  \`a b\` = c(1, 2),
  \`a,b\` = c(3, 4)
)
duplicate_keys <- data.table(id = rep(1:3, 10L), value = 1:30)
duplicate_lookup <- data.table(id = rep(1:3, 10L))
formal_names <- data.table(sorted = c("A", "A", "B"), unique = c(1L, 2L, 1L), value = 1:3)
new_lookup <- data.table(order_id = 1:3, extra = 4:6)
${ASSERTION_FIXTURE_R}
`;
const code = `${fixture}
cases <- list(
${cases.map(x=>`  list(name = ${rString(x.name)}, code = ${rString(x.code)}, expected_error = ${rString(x.expectedError || '')}, expected_source = ${rString(x.expectedSource || '')})`).join(',\n')}
)
logs <- lapply(cases, function(test) {
  warnings <- character()
  tryCatch({
    value <- withCallingHandlers(eval(parse(text = test$code), envir = new.env(parent = environment())), warning = function(w) {
      warnings <<- c(warnings, conditionMessage(w)); invokeRestart("muffleWarning")
    })
    if (nzchar(test$expected_error)) stop("The assertion unexpectedly accepted invalid data.")
    stopifnot(is.data.table(value), identical(sales, sales_before))
    if (nzchar(test$expected_source)) stopifnot(identical(value, eval(parse(text = test$expected_source))))
    if (test$name == "seed-pipeline") stopifnot(identical(value$region, c("South", "East", "North")), identical(value$orders, c(4L, 3L, 2L)), identical(value$revenue, c(325, 105, 38)))
    if (test$name == "melt-dcast-roundtrip") stopifnot(identical(value$order_id, sales$order_id), isTRUE(all.equal(value$units, as.numeric(sales$units))), isTRUE(all.equal(value$unit_price, sales$unit_price)))
    if (test$name == "semi-join-duplicate-keys") stopifnot(identical(value, duplicate_keys))
    if (test$name == "grid-with-formal-names") stopifnot(nrow(value) == 4L, identical(names(value), c("sorted", "unique")))
    if (test$name == "complete-with-formal-names") stopifnot(nrow(value) == 4L, sum(is.na(value$value)) == 1L)
    if (test$name == "ISO-year") stopifnot(all(value$iso_year == 2025L))
    if (test$name == "trailing-comment-pipe") stopifnot(nrow(value) == 2L)
    paste0("PASS ", test$name, " ", nrow(value), "x", ncol(value), if (length(warnings)) paste0(" WARN: ", paste(warnings, collapse = " | ")) else "")
  }, error = function(e) {
    if (nzchar(test$expected_error) && grepl(test$expected_error, conditionMessage(e))) {
      paste0("PASS ", test$name, " rejected invalid data")
    } else paste0("FAIL ", test$name, " : ", conditionMessage(e))
  })
})
paste(unlist(logs), collapse = "\\n")
`;
writeFileSync(new URL('./operations.integration.R', import.meta.url), code);
console.log(`${cases.length} R cases generated.`);
